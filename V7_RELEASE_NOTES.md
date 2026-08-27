# TradeMindMZ V7

## Focus
V7 targets the two unresolved production issues while retaining the existing Matrix/V5 dashboard direction and AI controls.

### Demo trading
- Adds/republishes the atomic demo RPC.
- Initializes a missing demo account server-side.
- Explicitly refreshes the PostgREST schema cache after function deployment.
- Client surfaces the real RPC error instead of a generic failure.

### Pionex USDT-M balance
- Uses Pionex's dedicated Futures balance endpoint `/uapi/v1/account/balances`.
- Normalizes USDT free/frozen/debt values for the shared `get_balance` path.
- The same balance path is used by Dashboard, Live Buy and server-side live-order preflight.

### Dashboard/UI
- Keeps the existing Matrix/cyber dashboard.
- Adds a clearly labeled Live USDT-M KPI showing the real Futures available balance.
- Live positions and Demo positions remain visually separated.

## Validation
The source has been statically checked for the relevant code paths. Full dependency installation/build should still be run in Codespaces before commit/APK.
