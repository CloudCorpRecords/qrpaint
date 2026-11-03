import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createClient, DEFAULT_MCP_URL, TOOL_NAMES } from "../src/qr.js";
import type { FetchFn, FetchResponseLike, ToolResult } from "../src/types.js";

/**
 * Every test runs against a fake fetch implementing the
 * Streamable HTTP session handshake (initialize -> session
 * header -> notifications/initialized -> tools/call), or
 * against the CLI / MCP server spawned as a child process:
 * no live network, no live call.
 */

const KEY_ENV = { QRX_API_KEY: "test-key" };
const SAMPLE_RESULT = { id: "abc123", object: "code", status: "processing" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: unknown;
  callHttpStatus?: number;
  initHttpStatus?: number;
  throwOn?: "initialize" | "notifications/initialized" | "tools/call";
  sessionId?: string | null;
  sseCall?: boolean;
  callRpcError?: { code: number; message: string };
  initRpcError?: { code: number; message: string };
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): { fetchFn: FetchFn; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initHttpStatus !== undefined) {
        return jsonResponse(options.initHttpStatus, "upstream down");
      }
      if (options.initRpcError) {
        return jsonResponse(200, { jsonrpc: "2.0", id: body.id, error: options.initRpcError });
      }
      const headers: Record<string, string> = {};
      const sessionId = options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "qrx", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.callHttpStatus !== undefined) {
        return jsonResponse(options.callHttpStatus, "upstream down");
      }
      if (options.callRpcError) {
        return jsonResponse(200, { jsonrpc: "2.0", id: body.id, error: options.callRpcError });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sseCall) {
        return makeResponse(200, `event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
          "content-type": "text/event-stream",
        });
      }
      return jsonResponse(200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function client(options: FakeOptions = {}, env: Record<string, string | undefined> = KEY_ENV) {
  const upstream = makeUpstream(options);
  return {
    qr: createClient({ fetchFn: upstream.fetchFn, env }),
    calls: upstream.calls,
  };
}

function textOf(result: ToolResult): string {
  return result.content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

/* ------------------------------------------------------------------ */

describe("forwarding handshake", () => {
  it("runs initialize, initialized, then tools/call, with Bearer auth and session headers", async () => {
    const { qr, calls } = client();
    const out = await qr.callTool("generate_qr_code", {
      prompt: "a lighthouse on a cliff at sunset",
      destination: "https://example.com/menu",
    });
    assert.equal(out.isError, undefined);
    assert.equal(textOf(out), JSON.stringify(SAMPLE_RESULT));
    assert.deepEqual(methods(calls), ["initialize", "notifications/initialized", "tools/call"]);
    assert.ok(calls.every((call) => call.url === DEFAULT_MCP_URL));
    assert.ok(calls.every((call) => call.headers.Authorization === "Bearer test-key"));

    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, "2025-03-26");
    assert.deepEqual(initParams.clientInfo, { name: "qrpaint", version: "0.1.0" });
    assert.equal(calls[0].headers["mcp-session-id"], undefined);
    assert.equal(calls[1].headers["mcp-session-id"], "sess-xyz");
    assert.equal(calls[2].headers["mcp-session-id"], "sess-xyz");
  });

  it("forwards the tool name and the caller's arguments verbatim", async () => {
    const { qr, calls } = client();
    const args = {
      destination: "https://example.com/x",
      image: {
        download_url: "https://files.example.com/pic.png",
        file_id: "f-1",
        mime_type: "image/png",
        file_name: "pic.png",
      },
      prompt: "a harbour at dawn",
    };
    await qr.callTool("generate_qr_code_from_image", args);
    const callParams = calls[2].body.params as { name: string; arguments: unknown };
    assert.equal(callParams.name, "generate_qr_code_from_image");
    assert.deepEqual(callParams.arguments, args);
  });

  it("returns the remote result value serialized as JSON text", async () => {
    const result = {
      content: [{ type: "text", text: "painted" }],
      structuredContent: { id: "z9", status: "succeeded" },
    };
    const { qr } = client({ callResult: result });
    const out = await qr.callTool("get_account", {});
    assert.equal(out.isError, undefined);
    assert.equal(textOf(out), JSON.stringify(result));
  });

  it("runs a fresh handshake for every call (no session reuse)", async () => {
    const { qr, calls } = client();
    await qr.callTool("list_styles", {});
    await qr.callTool("get_profile", {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("still forwards when the initialize response carries no session id", async () => {
    const { qr, calls } = client({ sessionId: null });
    const out = await qr.callTool("list_qr_codes", { limit: 5 });
    assert.equal(out.isError, undefined);
    assert.equal(calls[1].headers["mcp-session-id"], undefined);
    assert.equal(calls[2].headers["mcp-session-id"], undefined);
  });

  it("honours the QRX_MCP_URL env override and an injected endpoint", async () => {
    const upstream = makeUpstream();
    const envClient = createClient({
      fetchFn: upstream.fetchFn,
      env: { QRX_API_KEY: "k", QRX_MCP_URL: "https://example.test/custom-mcp" },
    });
    await envClient.callTool("list_styles", {});
    assert.ok(upstream.calls.every((c) => c.url === "https://example.test/custom-mcp"));

    const injected = makeUpstream();
    const depsClient = createClient({
      fetchFn: injected.fetchFn,
      env: KEY_ENV,
      mcpUrl: "https://example.test/injected",
    });
    await depsClient.callTool("list_styles", {});
    assert.ok(injected.calls.every((c) => c.url === "https://example.test/injected"));
  });

  it("parses an SSE-framed tools/call response", async () => {
    const { qr } = client({ sseCall: true });
    const out = await qr.callTool("get_qr_code", { id: "abc123" });
    assert.equal(out.isError, undefined);
    assert.equal(textOf(out), JSON.stringify(SAMPLE_RESULT));
  });
});

describe("API-key gate", () => {
  it("returns QRX_API_KEY is not set and makes no request when the key is absent", async () => {
    const { qr, calls } = client({}, {});
    const out = await qr.callTool("generate_qr_code", {
      prompt: "x",
      destination: "https://example.com",
    });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "QRX_API_KEY is not set");
    assert.equal(calls.length, 0);
  });

  it("gates every tool the same way, including the no-argument tools", async () => {
    const { qr, calls } = client({}, {});
    for (const name of TOOL_NAMES) {
      const out = await qr.callTool(name, {});
      assert.equal(out.isError, true);
      assert.equal(textOf(out), "QRX_API_KEY is not set");
    }
    assert.equal(calls.length, 0);
  });
});

describe("remote error mapping", () => {
  it("maps a remote JSON-RPC error on tools/call to an isError carrying its message", async () => {
    const { qr } = client({
      callRpcError: { code: -32602, message: "Invalid params: destination is not a URL" },
    });
    const out = await qr.callTool("generate_qr_code", { prompt: "x", destination: "nope" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "Invalid params: destination is not a URL");
  });

  it("maps a remote JSON-RPC error on initialize to an isError carrying its message", async () => {
    const { qr, calls } = client({ initRpcError: { code: -32000, message: "bad key" } });
    const out = await qr.callTool("list_styles", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "bad key");
    assert.deepEqual(methods(calls), ["initialize"]);
  });

  it("maps a non-2xx tools/call response to qrx error: HTTP <status>", async () => {
    const { qr } = client({ callHttpStatus: 500 });
    const out = await qr.callTool("list_qr_codes", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "qrx error: HTTP 500");
  });

  it("maps a non-2xx initialize response to qrx error: HTTP <status>", async () => {
    const { qr } = client({ initHttpStatus: 503 });
    const out = await qr.callTool("list_qr_codes", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "qrx error: HTTP 503");
  });

  it("maps a throwing fetch to qrx unreachable, on initialize and on tools/call", async () => {
    const onInit = client({ throwOn: "initialize" });
    const initOut = await onInit.qr.callTool("list_styles", {});
    assert.equal(initOut.isError, true);
    assert.equal(textOf(initOut), "qrx unreachable");

    const onCall = client({ throwOn: "tools/call" });
    const callOut = await onCall.qr.callTool("list_styles", {});
    assert.equal(callOut.isError, true);
    assert.equal(textOf(callOut), "qrx unreachable");
  });
});

/* ------------------------------------------------------------------ */
/* CLI and MCP surface (child processes, no network)                   */
/* ------------------------------------------------------------------ */

function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const merged: Record<string, string | undefined> = { ...process.env, ...env };
    for (const k of Object.keys(merged)) {
      if (merged[k] === undefined) delete merged[k];
    }
    execFile(
      "node_modules/.bin/tsx",
      ["src/cli.ts", ...argv],
      { env: merged },
      (err, stdout, stderr) => {
        const code =
          err !== null && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe("CLI cases", () => {
  it("--version prints 0.1.0 and exits 0", async () => {
    const out = await runCli(["--version"], {});
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), "0.1.0");
  });

  it("an unknown subcommand prints usage and exits 2", async () => {
    const out = await runCli(["not-a-tool"], {});
    assert.equal(out.code, 2);
    assert.match(out.stderr, /Usage:/);
  });

  it("a tool call without a key prints the missing-key error and exits 1", async () => {
    const out = await runCli(["list_styles", "{}"], { QRX_API_KEY: undefined });
    assert.equal(out.code, 1);
    assert.match(out.stderr, /QRX_API_KEY is not set/);
  });

  it("a non-JSON argument string is a usage error, exit 2", async () => {
    const out = await runCli(["list_styles", "not json"], { QRX_API_KEY: "k" });
    assert.equal(out.code, 2);
  });
});

describe("MCP tools/list without a key", () => {
  it("lists all 9 tools with no QRX_API_KEY set", async () => {
    const { spawn } = await import("node:child_process");
    const childEnv: Record<string, string | undefined> = { ...process.env };
    delete childEnv.QRX_API_KEY;
    const child = spawn("node_modules/.bin/tsx", ["src/cli.ts", "mcp"], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const lines: string[] = [];
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          lines.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
        }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
      );
      const deadline = Date.now() + 20000;
      let listResponse: { result?: { tools?: Array<{ name: string }> } } | undefined;
      while (Date.now() < deadline) {
        for (const line of lines.splice(0)) {
          try {
            const msg = JSON.parse(line) as {
              id?: number;
              result?: { tools?: Array<{ name: string }> };
            };
            if (msg.id === 2) listResponse = msg;
          } catch {
            // Not a JSON line; ignore.
          }
        }
        if (listResponse) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(listResponse, "no tools/list response within 20s");
      const names = (listResponse.result?.tools ?? []).map((t) => t.name);
      assert.deepEqual(names, [...TOOL_NAMES]);
    } finally {
      child.kill();
    }
  });
});
