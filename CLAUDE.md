# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Build**: `npm run build` (runs `tsc`)
- **Dev**: `npm run dev` (runs `tsx src/index.ts` — no build needed)
- **Start**: `npm start` (runs compiled `dist/index.js`)

No test framework is configured yet.

## Architecture

Single-file MCP server (`src/index.ts`) that bridges Claude Desktop to the Kiwoom Securities REST API via stdio transport. ESM module (`"type": "module"`) with Node16 module resolution.

### src/index.ts layout (top to bottom)

1. **Environment variables** — `KIWOOM_APP_KEY`, `KIWOOM_SECRET_KEY`, `KIWOOM_ACCOUNT_NO`, `KIWOOM_IS_MOCK`. `IS_MOCK` switches between `mockapi.kiwoom.com` and `api.kiwoom.com`.
2. **TokenManager** — OAuth 2.0 client credentials token with 23-hour memory cache (24h expiry).
3. **KiwoomApiClient** — All Kiwoom REST API calls go through `request()` which auto-injects bearer token. Every API call uses HTTP POST (even queries use POST with `trcode` to distinguish operations).
4. **Formatting helpers** — `formatCurrency`, `formatPercent`, `formatBalance`, `formatPortfolioSummary`, `formatStockPrice`, `formatChartData`, `formatError`. Output is Korean markdown tables/lists.
5. **12 MCP tools** — Registered via `server.tool()`. Each wraps a client method + formatter in try/catch returning `isError: true` on failure. Order tools have `readOnlyHint: false` + `idempotentHint: false`; `cancel_order` also has `destructiveHint: true`.
6. **Server startup** — `StdioServerTransport` connection.

### Key patterns

- API response field names use fallback chains (`item.stk_nm ?? item.stock_name ?? "-"`) because Kiwoom API field names may vary.
- Tools that need an account number fall back to the `KIWOOM_ACCOUNT_NO` env var.
- Kiwoom API endpoints are differentiated by `trcode` in the POST body, not by URL path. Query APIs use `ka*` prefixes, order APIs use `kt*`.

### Tool → trcode mapping

| Tool | trcode | Endpoint |
|------|--------|----------|
| get_account_balance / get_portfolio_summary | ka10085 | /api/dostk/acnt |
| get_deposit_detail | ka10072 | /api/dostk/acnt |
| get_stock_price | ka10001 | /api/dostk/stkinfo |
| get_stock_chart | ka10002 | /api/dostk/chart |
| search_stock_code | ka10004 | /api/dostk/stkinfo |
| place_buy_order | kt10000 | /api/dostk/order |
| place_sell_order | kt10001 | /api/dostk/order |
| get_unfilled_orders | ka10075 | /api/dostk/acnt |
| cancel_order | kt10003 | /api/dostk/order |
| get_trade_history / analyze_profit_loss | ka10170 | /api/dostk/acnt |
