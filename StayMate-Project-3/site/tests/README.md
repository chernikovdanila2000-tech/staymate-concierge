# StayAI QA test suite

Playwright E2E tests for the whole static site + cabinet. Runs against a
local static server (no real Supabase/Railway/WayForPay access needed —
`helpers/mockBackend.js` provides a full in-browser stand-in for all three,
persisted through `localStorage` so it survives the app's own
`signOut()` + `location.reload()`).

## Run

```
npm install
npx playwright test --project=desktop-chrome
```

Screenshots land in `screenshots/`. A JSON report is written to
`results.json`. See `../../../QA_REPORT_RU.md` at the repo root for the
full audit writeup (in Russian).

## Layout

- `helpers/mockBackend.js` — the shared Supabase/API test double.
- `helpers/pages.js` — the page inventory every spec iterates.
- `specs/` — one file per test category (navigation, i18n, auth, forms,
  dashboard, responsive, visual, console-errors, accessibility, security).
