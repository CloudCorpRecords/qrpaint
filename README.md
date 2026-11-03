# qrpaint

A QR code that is also a picture: a lighthouse at sunset, a
café awning, your own photograph — with a scannable code
painted into it. qrpaint is a thin forwarding client for
the hosted QRX service. It serves nine tools locally and
passes every call, unchanged, to the service, which paints
the picture, checks that it still scans, and hands back a
code with its own short link.

Because the painting happens on the hosted service, this
package holds no rendering logic of its own. What it does
hold is the contract: the exact tool list and schemas from
the service's public server card, the session handshake
each call travels over, and the rule that nothing is ever
sent until an API key is present.

## Configuration

- `QRX_API_KEY` (required for tool calls) — your QRX API
  key, sent to the hosted endpoint on every request as
  `Authorization: Bearer <key>`. Without it, the server
  still starts and lists its tools, but every call fails
  with `QRX_API_KEY is not set` and no request is made.
- `QRX_MCP_URL` (optional) — the hosted MCP endpoint.
  Defaults to `https://qrx.codes/mcp`.

## Tools

- `generate_qr_code` — start a new art code from a
  `prompt` (what the picture should show) and a
  `destination` link, with an optional `style` from
  `list_styles`. Answers at once with the code's id while
  the picture is painted.
- `generate_qr_code_from_image` — weave a code into a
  picture you already have, passed once as an attached
  `image` file, a public `imageUrl`, or `imageBase64`,
  plus the `destination`.
- `vary_qr_code` — a new code based on an existing code's
  `id`, with a `change` to its picture ("make it night
  time"). The original is untouched and the new code opens
  the same destination.
- `get_qr_code` — a code's status, finished image and
  short link by `id`; `wait` (0–25 seconds, default 25)
  lets it hold for a code that is still being painted.
- `list_qr_codes` — your codes, newest first, paged with
  `limit` (1–100, default 20) and `cursor`.
- `change_qr_code_destination` — retarget an existing
  link code to a new `destination`; printed copies follow
  at once.
- `get_account` — the connected account's plan and how
  much of today's code allowance remains.
- `get_profile` — which QRX account is connected.
- `list_styles` — the looks you can pass as `style` to
  `generate_qr_code`.

A typical flow is `generate_qr_code` (or
`generate_qr_code_from_image`), then `get_qr_code` with
the returned id until its status is `succeeded` — usually
under a minute. Codes count against your QRX allowance;
`get_account` shows what is left.

## How forwarding works

Each tool call opens a fresh session with the hosted
endpoint: an `initialize` request (protocol version
`2025-03-26`), the returned session id carried into a
`notifications/initialized` note, then the `tools/call`
request with your arguments exactly as given. Responses
arrive as plain JSON or as server-sent events; both are
read. The remote result comes back as JSON text. A remote
error surfaces with the remote message, a non-2xx reply
fails with `qrx error: HTTP <status>`, and an unreachable
endpoint fails with `qrx unreachable`. Calls are never
retried — a retry could paint (and charge) a second code.
The handshake is a reconstruction of the standard
Streamable HTTP session flow; the endpoint, the Bearer
auth and the missing-key behaviour are the original
package's documented design.

There is no local argument validation beyond the
missing-key rule: the schemas above are served verbatim
for your MCP client to validate against, and the service
itself is the authority on every call.

## CLI

Each tool is a subcommand taking one JSON argument string:

```bash
export QRX_API_KEY="<your key>"
npx @reneturcios/qrpaint generate_qr_code '{"prompt":"a lighthouse on a cliff at sunset","destination":"https://example.com/menu"}'
npx @reneturcios/qrpaint get_qr_code '{"id":"abc123"}'
npx @reneturcios/qrpaint list_qr_codes '{"limit":10}'
npx @reneturcios/qrpaint vary_qr_code '{"id":"abc123","change":"make it night time"}'
npx @reneturcios/qrpaint change_qr_code_destination '{"id":"abc123","destination":"https://example.com/new-menu"}'
npx @reneturcios/qrpaint get_account '{}'
npx @reneturcios/qrpaint list_styles '{}'
npx @reneturcios/qrpaint --version
```

Output is the remote result as JSON text. Exit codes: `0`
on success, `1` on an error result (including a
missing-key, remote or upstream failure), `2` on a usage
error.

## MCP server

```bash
npx -y @reneturcios/qrpaint mcp
```

MCP client config (provide the key through the client's
environment):

```json
{
  "mcpServers": {
    "qrpaint": {
      "command": "npx",
      "args": ["-y", "@reneturcios/qrpaint", "mcp"],
      "env": {
        "QRX_API_KEY": "<your key>"
      }
    }
  }
}
```

## Docker

```bash
docker run -i -e QRX_API_KEY="<your key>" ghcr.io/cloudcorprecords/qrpaint
docker run --rm -e QRX_API_KEY="<your key>" ghcr.io/cloudcorprecords/qrpaint list_styles '{}'
```

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (fake fetch only, no network)
npm run dev     # run the CLI from source
```

## License

MIT — Copyright (c) 2026 Rene Turcios
