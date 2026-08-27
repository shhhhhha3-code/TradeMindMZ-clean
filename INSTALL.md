# TradeMind MZ UI Refresh

## What is included
- `src/components/trademind/TradeMindUI.refresh.css`

This is a presentation-only layer. It does not change Supabase, trading, Pionex, RPC or business logic.

## Install
1. Put `TradeMindUI.refresh.css` next to `TradeMindUI.css`.
2. In `src/components/trademind/TradeMindApp.tsx`, immediately after:
   `import "./TradeMindUI.css";`
   add:
   `import "./TradeMindUI.refresh.css";`
3. Save and run the project.
4. Do not delete `TradeMindUI.css`.

The refresh is designed around the current TradeMind class names and makes mobile the priority while retaining the desktop sidebar.
