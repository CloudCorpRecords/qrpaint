/**
 * qrpaint types.
 *
 * Nine tools that forward to the hosted QRX MCP endpoint.
 * The rebuild serves tools/list locally with the hosted
 * service's public server-card schemas verbatim, and
 * forwards every tools/call unchanged over a per-call
 * Streamable HTTP session. A successful call answers with
 * the remote result value serialized as JSON text;
 * failures are results carrying isError and the pinned
 * error strings.
 */

/** A tool's arguments, as decoded JSON. */
export type ToolArgs = Record<string, unknown>;

/** The result shape shared by the MCP handler and the CLI. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** The minimal slice of a fetch Response this client relies on. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Injectable fetch, so tests never touch the live network. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponseLike>;

/** Runtime dependencies for the client, all injectable in tests. */
export interface QrDeps {
  /** Fetch implementation. Defaults to the global fetch. */
  fetchFn?: FetchFn;
  /** Environment (QRX_API_KEY / QRX_MCP_URL). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** API key override. Defaults to env QRX_API_KEY. */
  apiKey?: string;
  /** Endpoint override. Defaults to env QRX_MCP_URL or the pinned default. */
  mcpUrl?: string;
}
