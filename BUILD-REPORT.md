# qrpaint — Build Report (Batch 23)

Rebuild of the `@qrxcodes/mcp` MCP server (npm v1.0.1;
registry record `codes.qrx/mcp`) from the firsthand spec
in `specs-batch23/qrpaint.md`. Built 2026-10-27.

## Identity

- npm: `@reneturcios/qrpaint` @ 0.1.0, bin `qrpaint` →
  `dist/cli.js`
- MCP Registry name: `io.github.CloudCorpRecords/qrpaint`
  (matches `package.json` `mcpName`, `server.json` `name`,
  and the Dockerfile `io.modelcontextprotocol.server.name`
  label)
- server.json description (96 chars, verified):
  "Art QR codes via a hosted service: generate, vary, list
  and retarget scannable picture QR codes."
- server.json: npm package entry carries `"version":
  "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/qrpaint:0.1.0`) carries **no**
  `version` field (verified).

## Files (19-file factory set, per TEMPLATE.md §2)

package.json, server.json, Dockerfile, tsconfig.json
(byte-identical to builds/geodata/tsconfig.json, verified
with `cmp`), .gitignore, package-lock.json, README.md
(fresh prose), LICENSE (MIT, © 2026 Rene Turcios),
CHANGELOG.md (single 0.1.0 entry dated 2026-10-27),
src/index.ts, src/cli.ts, src/mcp.ts, src/types.ts,
src/qr.ts (core), test/qr.test.ts, and the four workflows
under .github/workflows/ (publish-container adapted:
IMAGE ghcr.io/cloudcorprecords/qrpaint, smoke assertion
on server name `qrpaint`). Plus this BUILD-REPORT.md and
the parity-out/ artifacts. The parity fixture lives at
`harness/fixtures/qrxcodes-mcp-tools-original.json`
(program-root harness, per the parity command).

## Implementation

- `src/mcp.ts`: low-level `Server` API
  (`sdk/server/index.js` + `StdioServerTransport`,
  handlers for `ListToolsRequestSchema` /
  `CallToolRequestSchema` from `sdk/types.js`), explicit
  JSON-schema literals for all 9 tools (generate_qr_code,
  generate_qr_code_from_image, vary_qr_code, get_qr_code,
  list_qr_codes, change_qr_code_destination, get_account,
  get_profile, list_styles); no McpServer/zod
  registration. This build is the fleet exception: the
  served schemas DO carry `additionalProperties: false`,
  `minLength`/`maxLength`, `pattern`, `format` and
  `default` keys, and the nested `image` object schema in
  `generate_qr_code_from_image`, because the fixture does
  — descriptions and inputSchemas are the QRX public
  server card's values verbatim (the fixture was verified
  parsed-equal to `specs-batch23/qrx-server-card.json`
  `tools[]`, name/description/inputSchema, all 9 tools).
- `src/qr.ts`: `VERSION = "0.1.0"`. A forwarding client
  for `https://qrx.codes/mcp` through an injectable fetch
  (deps `fetchFn`, `env`, `apiKey`, `mcpUrl`). Per tool
  call, with no session reuse and no retries: POST
  JSON-RPC `initialize` (protocolVersion `2025-03-26`,
  clientInfo `qrpaint/0.1.0`, capabilities {}), capture
  the `mcp-session-id` response header, POST
  `notifications/initialized`, then POST `tools/call` with
  the tool name and the caller's arguments verbatim.
  Every POST carries `Authorization: Bearer <QRX_API_KEY>`
  and `Accept: application/json, text/event-stream`;
  responses are parsed as plain JSON or SSE (`data:`
  lines). The endpoint defaults to
  `https://qrx.codes/mcp`, overridable via `QRX_MCP_URL`.
  No local validation beyond the missing-key rule: when
  `QRX_API_KEY` is unset, every call returns isError
  `QRX_API_KEY is not set` and makes no request, while
  tools/list works without a key. Success returns the
  remote `result` value serialized as JSON text; a remote
  JSON-RPC `error` becomes an isError carrying the remote
  error's `message`; a non-2xx response becomes
  `qrx error: HTTP <status>`; a throwing fetch becomes
  `qrx unreachable`.
- CLI: one subcommand per tool taking a JSON argument
  string, `mcp`, `--version` (prints `0.1.0`); unknown
  subcommand → usage on stderr, exit 2; isError results
  exit 1 (both spot-checked against the built CLI, plus
  covered in the test suite via child processes).

## Verification (all real, run 2026-10-27)

- `npm run build` (tsc): exit 0.
- `npm test`: **19 tests, 19 pass, 0 fail** — a fake
  fetch implementing the handshake only, no live network,
  plus CLI/MCP child-process cases run from source via
  tsx. Covers the initialize/session/initialized/
  tools-call sequence (order, initialize payload, Bearer
  header on every request, session header on the later
  POSTs, no session header on initialize), verbatim
  argument forwarding (including the nested `image`
  object), the remote result returned as JSON text, a
  fresh handshake per call, forwarding when initialize
  returns no session id, the `QRX_MCP_URL` env override
  and an injected endpoint, SSE response parsing, the
  missing-key error with zero requests for all 9 tools,
  remote JSON-RPC errors on tools/call and on initialize,
  non-2xx mappings on tools/call and on initialize, and
  throwing-fetch mappings on initialize and on tools/call.
  CLI cases: `--version` prints `0.1.0` exit 0; unknown
  subcommand prints usage exit 2; a keyless tool call
  prints the missing-key error exit 1; a non-JSON argument
  string is a usage error exit 2. MCP case: tools/list
  spawned with no `QRX_API_KEY` returns all 9 tools in
  card order.
- `node dist/cli.js --version`: prints `0.1.0`.
  Unknown subcommand exits 2 with usage; a missing-key
  call exits 1 with `error: QRX_API_KEY is not set`.
- Parity: `python3 harness/parity.py --original
  harness/fixtures/qrxcodes-mcp-tools-original.json
  --rebuild "stdio:node builds/qrpaint/dist/cli.js mcp"
  --out builds/qrpaint/parity-out` from the program root
  → **PASS, parity 100.0, identical_tools 9 / total 9, no
  missing, no extra, no schema diffs** (see
  `parity-out/parity.json`).
- Lockfile (Route 3, clean from birth): generated in a
  temp dir containing only `package.json` with
  `npm install --package-lock-only --ignore-scripts
  --offline`; verified it parses, `name` ==
  `@reneturcios/qrpaint`, **128 package entries**; copied
  in as `package-lock.json`, then
  `npm install --offline --ignore-scripts` in the build
  dir succeeded for node_modules.
- Version consistency: `package.json` 0.1.0 =
  `server.json` top-level 0.1.0 = npm entry 0.1.0 = OCI
  tag `:0.1.0` = core `VERSION` 0.1.0 = CHANGELOG heading
  `## 0.1.0 (2026-10-27)`.

## Gaps

- The Streamable HTTP session handshake is a labelled
  reconstruction (the nycrentals pattern): the original
  README pins the endpoint, the Bearer auth, the
  `QRX_MCP_URL` default and the missing-key behaviour,
  but not the handshake itself. Per spec, the handshake
  runs fresh for every call (nycrentals reuses its
  session; qrpaint does not) and no call is ever retried
  (the README pins no-retries for code-creating tools;
  applied uniformly, labelled).
- The npm README's tool table lists 7 tools; the public
  server card's 9 govern — the card adds
  `generate_qr_code_from_image` and `vary_qr_code`, and
  the README itself says the tool list and schemas come
  from the remote server.
- Live upstream behaviour is unproven: no live call was
  made or claimed; behaviour is proven against a fake
  fetch implementing the handshake only.
- No push, no publish.
