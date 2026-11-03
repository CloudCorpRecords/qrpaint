/**
 * qrpaint core: a forwarding client for the hosted QRX MCP
 * endpoint.
 *
 * tools/list is served locally (see src/mcp.ts) from the
 * hosted service's public server-card schemas. A tools/call
 * is forwarded, per call, over a fresh Streamable HTTP
 * session: an initialize POST (protocolVersion "2025-03-26",
 * clientInfo qrpaint/0.1.0) that captures the mcp-session-id
 * response header, a notifications/initialized POST, then
 * the tools/call POST with the caller's arguments verbatim.
 * Every POST carries `Authorization: Bearer <QRX_API_KEY>`.
 * The Streamable HTTP session handshake is a labelled
 * reconstruction (the nycrentals pattern); the endpoint,
 * the Bearer auth and the missing-key behaviour are pinned
 * by the original package's README.
 *
 * Shared rules, as documented in the spec:
 * - The API key is read from env `QRX_API_KEY`. When it is
 *   unset, every tool call returns isError
 *   `QRX_API_KEY is not set` and makes no request.
 *   tools/list works without a key.
 * - The endpoint defaults to `https://qrx.codes/mcp` and is
 *   overridable via env `QRX_MCP_URL` (or the injectable
 *   deps in tests).
 * - No local validation beyond the missing-key rule: the
 *   card's schemas are served verbatim for clients to
 *   validate against, and arguments are forwarded unchanged.
 * - A successful call returns the remote `result` value
 *   serialized as JSON text. A remote JSON-RPC `error`
 *   becomes an isError carrying the remote error's
 *   `message`. A non-2xx HTTP response becomes isError
 *   `qrx error: HTTP <status>`; a throwing fetch becomes
 *   isError `qrx unreachable`.
 * - No retries.
 * - Responses may be plain JSON or SSE (`data:` lines);
 *   both are parsed.
 * - Upstream access goes through the injectable fetch in
 *   deps, so tests run against a fake fetch only.
 */
import type { FetchFn, FetchResponseLike, QrDeps, ToolArgs, ToolResult } from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_MCP_URL = "https://qrx.codes/mcp";

export const TOOL_NAMES = [
  "generate_qr_code",
  "generate_qr_code_from_image",
  "vary_qr_code",
  "get_qr_code",
  "list_qr_codes",
  "change_qr_code_destination",
  "get_account",
  "get_profile",
  "list_styles",
] as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** Parse a JSON-RPC response body, tolerating SSE framing. */
function parseRpcBody(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  let payload = trimmed;
  if (trimmed.includes("data:")) {
    const dataLines = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line !== "" && line !== "[DONE]");
    if (dataLines.length > 0) payload = dataLines[dataLines.length - 1];
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function defaultFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

/**
 * A forwarding client for the hosted QRX endpoint. Each
 * callTool runs the full session handshake for that call;
 * no session is kept between calls.
 */
export class QrClient {
  private readonly deps: QrDeps;
  private idCounter = 0;

  constructor(deps: QrDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }

  private endpoint(): string {
    if (this.deps.mcpUrl && this.deps.mcpUrl.trim() !== "") return this.deps.mcpUrl.trim();
    const raw = this.env().QRX_MCP_URL;
    return raw && raw.trim() !== "" ? raw.trim() : DEFAULT_MCP_URL;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    key: string,
    sessionId: string | null,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId !== null) headers["mcp-session-id"] = sessionId;
    let res: FetchResponseLike;
    try {
      res = await this.fetchFn()(this.endpoint(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("qrx unreachable");
    }
    if (!res.ok) throw new Error(`qrx error: HTTP ${res.status}`);
    return res;
  }

  /** Forward one tool call; spec'd failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    const key = this.deps.apiKey ?? this.env().QRX_API_KEY;
    if (!key) return errorResult("QRX_API_KEY is not set");

    try {
      // 1. initialize — capture the mcp-session-id response header.
      const initRes = await this.post(
        {
          jsonrpc: "2.0",
          id: this.nextId(),
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "qrpaint", version: VERSION },
          },
        },
        key,
        null,
      );
      const sessionId = initRes.headers.get("mcp-session-id");
      const initParsed = parseRpcBody(await initRes.text());
      if (initParsed !== null && initParsed.error) {
        return errorResult(rpcErrorMessage(initParsed.error));
      }

      // 2. notifications/initialized — carries the session header.
      const initializedRes = await this.post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        key,
        sessionId,
      );
      try {
        await initializedRes.text();
      } catch {
        // The notification response body carries nothing we need.
      }

      // 3. tools/call — the tool name and arguments, verbatim.
      const callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: this.nextId(),
          method: "tools/call",
          params: { name, arguments: args },
        },
        key,
        sessionId,
      );
      const parsed = parseRpcBody(await callRes.text());
      if (parsed !== null && parsed.error) {
        return errorResult(rpcErrorMessage(parsed.error));
      }
      if (parsed === null || !("result" in parsed)) {
        return errorResult("qrx error: invalid response");
      }
      return { content: [{ type: "text", text: JSON.stringify(parsed.result) }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }
}

/** Create a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: QrDeps = {}): QrClient {
  return new QrClient(deps);
}

/** One-shot helper: a fresh client per call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: QrDeps = {},
): Promise<ToolResult> {
  return new QrClient(deps).callTool(name, args);
}
