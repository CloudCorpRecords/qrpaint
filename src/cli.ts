#!/usr/bin/env node
/**
 * qrpaint CLI.
 *
 *   qrpaint generate_qr_code '<json>'     (and the other eight
 *   qrpaint get_qr_code '<json>'           tool names likewise)
 *   qrpaint mcp
 *   qrpaint --version
 *
 * Each tool subcommand takes one JSON argument string with the
 * tool's arguments, forwards the call like the MCP path, and
 * prints the remote result as JSON text. Exit codes:
 * 0 success, 1 on an isError result, 2 usage error.
 */
import { callTool, TOOL_NAMES, VERSION } from "./qr.js";
import type { ToolResult } from "./types.js";

function usage(): never {
  console.error(`Usage:
  qrpaint <tool> '<json-args>'     one of: ${TOOL_NAMES.join(", ")}
  qrpaint mcp
  qrpaint --version`);
  process.exit(2);
}

function firstText(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    if (rest.length !== 0) usage();
    await import("./mcp.js");
    return;
  }
  if (!(TOOL_NAMES as readonly string[]).includes(cmd ?? "")) usage();
  if (rest.length > 1) usage();
  let args: Record<string, unknown> = {};
  if (rest.length === 1) {
    try {
      const parsed: unknown = JSON.parse(rest[0]);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) usage();
      args = parsed as Record<string, unknown>;
    } catch {
      console.error("error: argument must be a JSON object string");
      process.exit(2);
    }
  }
  const result = await callTool(cmd, args);
  if (result.isError) {
    console.error(`error: ${firstText(result)}`);
    process.exit(1);
  }
  console.log(firstText(result));
}

void main();
