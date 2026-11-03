# Changelog

## 0.1.0 (2026-10-27)

- Initial release: nine MCP tools and matching CLI subcommands
  forwarding to the hosted QRX MCP service —
  `generate_qr_code`, `generate_qr_code_from_image`,
  `vary_qr_code`, `get_qr_code`, `list_qr_codes`,
  `change_qr_code_destination`, `get_account`, `get_profile`,
  and `list_styles`.
- Every tool call sends the API key as
  `Authorization: Bearer <key>` (`QRX_API_KEY`, endpoint via
  `QRX_MCP_URL`, default `https://qrx.codes/mcp`) over a
  per-call Streamable HTTP session and returns the remote
  result as JSON text; without a key, calls fail with
  `QRX_API_KEY is not set` and no request is made, while
  tools/list works without a key.
