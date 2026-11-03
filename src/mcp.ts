/**
 * qrpaint MCP server. Tools: generate_qr_code,
 * generate_qr_code_from_image, vary_qr_code, get_qr_code,
 * list_qr_codes, change_qr_code_destination, get_account,
 * get_profile, list_styles.
 *
 * Why the low-level Server instead of McpServer: this build
 * serves tools/list with the hosted QRX service's public
 * server-card schemas as explicit literals — verbatim,
 * including `additionalProperties: false`, the min/max
 * lengths, the destination pattern, the defaults, and the
 * nested `image` object schema — which the high-level
 * helper's zod conversion would not reproduce exactly. Do
 * not use McpServer/zod registration here.
 *
 * Every tools/call is forwarded to the hosted endpoint by
 * the core (src/qr.ts) with the caller's arguments
 * unchanged; the remote result comes back as a single text
 * item carrying its JSON serialization, and failures come
 * back as isError results carrying the pinned error
 * strings. tools/list is served locally and works without
 * an API key.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient, TOOL_NAMES, VERSION } from "./qr.js";

const TOOLS = [
  {
    name: "generate_qr_code",
    description:
      "Use this when the user wants a new QR code that is also a picture: a scannable code painted into art from a description, that opens a link. It starts the code and answers at once with its id while the picture is painted, which usually takes under a minute; then call get_qr_code with the id to wait for the image. Do not use it to look at, list or change codes that already exist. Each code counts against the user’s QRX allowance.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["prompt", "destination"],
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description: "What the picture should show, e.g. \"a lighthouse on a cliff at sunset\".",
        },
        destination: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          format: "iri",
          pattern: "^[Hh][Tt][Tt][Pp][Ss]?://[^\\s\\\\]+$",
          description:
            "The link scans open: an absolute http or https URL, e.g. https://example.com/menu.",
        },
        style: {
          type: "string",
          description: "A style id from list_styles. Leave out for the default.",
        },
      },
    },
  },
  {
    name: "generate_qr_code_from_image",
    description:
      "Use this when the user wants a scannable QR code woven into a picture they already have (a photo, an illustration or artwork) instead of one painted from a description. Pass the picture once, as exactly one of an attached file (image), a public https link (imageUrl) or base64 (imageBase64): PNG, JPEG or WebP, at most 10 MB and at least 256 pixels on each side; the code uses its centre square. Every picture is checked for safety first, and one that does not pass is refused with an error and nothing is made. It starts the code and answers at once with its id while it is painted, which usually takes under a minute; then call get_qr_code with the id to wait for the image. Do not use it to look at, list or change codes that already exist. Each code counts against the user’s QRX allowance.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["destination"],
      properties: {
        image: {
          type: "object",
          description: "The picture as a file the user attached in the conversation.",
          additionalProperties: false,
          required: ["download_url", "file_id"],
          properties: {
            download_url: {
              type: "string",
              description: "Where the file can be downloaded.",
            },
            file_id: {
              type: "string",
              description: "The file’s id.",
            },
            mime_type: {
              type: "string",
              description: "The file’s type, e.g. image/jpeg.",
            },
            file_name: {
              type: "string",
              description: "The file’s name.",
            },
          },
        },
        imageUrl: {
          type: "string",
          maxLength: 2048,
          format: "uri",
          description: "Or: a public https link to the picture.",
        },
        imageBase64: {
          type: "string",
          description: "Or: the picture as base64, or a base64 data: URL.",
        },
        destination: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          format: "iri",
          pattern: "^[Hh][Tt][Tt][Pp][Ss]?://[^\\s\\\\]+$",
          description:
            "The link scans open: an absolute http or https URL, e.g. https://example.com/menu.",
        },
        prompt: {
          type: "string",
          maxLength: 1000,
          description:
            "Optional: what the picture shows, to guide how it is redrawn. Leave out to have it described automatically.",
        },
        style: {
          type: "string",
          description: "A style id from list_styles. Leave out to keep the picture’s own look.",
        },
      },
    },
  },
  {
    name: "vary_qr_code",
    description:
      "Use this when the user wants a new QR code based on one of their existing codes, with a change to its picture, e.g. \"more trees\" or \"make it night time\". It makes a new code with its own id and short link that opens the same destination and keeps the original’s style and logo; the original code does not change. It answers at once with the new code’s id while the picture is painted; then call get_qr_code with the id to wait for the image. Only link codes the user owns can be varied. Do not use it to change where a code points or to make an unrelated code. Each variation counts against the user’s QRX allowance.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["id", "change"],
      properties: {
        id: {
          type: "string",
          maxLength: 64,
          description: "The id of the code to start from.",
        },
        change: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "What to change in the picture, e.g. \"add more trees\" or \"make it autumn\".",
        },
      },
    },
  },
  {
    name: "get_qr_code",
    description:
      "Use this when you have a QR code’s id (from generate_qr_code, vary_qr_code or list_qr_codes) and need its status or finished image. While the code is still being painted it waits up to `wait` seconds (25 by default) for it to finish before answering, so call it again if it is still processing. Do not use it to make a new code.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: {
          type: "string",
          maxLength: 64,
          description: "The code’s id.",
        },
        wait: {
          type: "integer",
          minimum: 0,
          maximum: 25,
          default: 25,
          description:
            "Seconds to wait for a processing code to finish before answering, 0 to 25.",
        },
      },
    },
  },
  {
    name: "list_qr_codes",
    description:
      "Use this when the user asks about QR codes they already have, newest first, a page at a time (pass nextCursor as cursor for the next page). Do not use it to make a code.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "How many codes to return, 1 to 100.",
        },
        cursor: {
          type: "string",
          description: "nextCursor from the previous page.",
        },
      },
    },
  },
  {
    name: "change_qr_code_destination",
    description:
      "Use this when the user wants an existing link QR code to open a different web address. Printed copies follow at once. It only works for link codes, and only if the account’s plan allows changing destinations. Do not use it to make a new code.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["id", "destination"],
      properties: {
        id: {
          type: "string",
          maxLength: 64,
          description: "The code’s id.",
        },
        destination: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          format: "iri",
          pattern: "^[Hh][Tt][Tt][Pp][Ss]?://[^\\s\\\\]+$",
          description: "The new link scans should open: an absolute http or https URL.",
        },
      },
    },
  },
  {
    name: "get_account",
    description:
      "Use this when the user asks how many QR codes they can still make today, when the daily count resets, or what their QRX account can do. Do not use it to make or list codes.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_profile",
    description:
      "Use this when you need to know which QRX account is connected, for example to confirm it with the user. Do not use it for limits; use get_account.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "list_styles",
    description:
      "Use this when the user wants to choose a look for a new QR code; pass a style id to generate_qr_code. Do not use it to make a code.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {},
    },
  },
];

const client = createClient();

const server = new Server(
  { name: "qrpaint", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (!(TOOL_NAMES as readonly string[]).includes(name)) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  const result = await client.callTool(name, (args ?? {}) as Record<string, unknown>);
  return {
    content: result.content,
    ...(result.isError ? { isError: true as const } : {}),
  };
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
