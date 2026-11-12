# Changelog 2.0.0

## Added
- Added **In vận đơn Sapo** button while preserving the existing **In bill** path.
- Added Sapo Print Bridge Edge extension for tenant pages on `*.mysapogo.com` and `market-place.sapoapps.vn`.
- Added authenticated bridge WebSocket and `PRINT_ORDER` event ingestion.
- Added strict PDF URL allowlist and short-lived order ID/order code mapping in Durable Object storage.
- Added direct Sapo print triggering from the web through the logged-in Edge session.
- Added PDF-original printing in Windows Agent using SumatraPDF.

## Security
- Added `SAPO_BRIDGE_TOKEN`.
- Bridge never sends Sapo Authorization, X-Market-Token, cookies, or passwords to Cloudflare.
- Worker only accepts PDF URLs from `social.dktcdn.net` under `/shopee/.../prints_orders/*.pdf`.
- Original-print API remains protected by `PRINT_WEB_PIN`.
- No print queue or automatic retry.

## Preserved
- Existing Sapo order search.
- Existing generated bill printing endpoint and UI action.
