# Contributing to SpeciMap

Thanks for helping! SpeciMap is MIT-licensed; by contributing you agree your
work is too.

## Setup

See the Development section of the [README](README.md). The short version:
`npm install`, `supabase start`, `supabase db reset`, `npm run dev`.

## Testing on a real phone

Camera, geolocation, and service-worker behavior differ between desktop and
mobile — **changes to the capture flow must be tested on a phone**:

```bash
npm run dev -- --host
cloudflared tunnel --url http://localhost:5173   # stable HTTPS URL
```

Minimum test matrix: iOS Safari (both browser tab and installed/Add to Home
Screen) and Android Chrome.

## What to test before a PR

- `npm run typecheck && npm test && npm run build`
- If you touched capture/sync: airplane-mode capture → back online → sync
  with no duplicates.
- If you touched the tag generator: print a sheet, measure the 50mm
  calibration ruler, and check tag fit on a real 20mL vial.

## Code layout

Pure logic lives apart from React and is unit-tested: `src/lib/tagid.ts`
(ID codec), `src/sync/engine.ts` (offline queue), `src/focus/laplacian.ts`
(sharpness metric), `src/tags/layout.ts` (sheet math). Keep it that way —
new logic should be testable without a browser.

Database changes go in `supabase/migrations/` (use `supabase db diff -f
<name>`), never by editing existing migration files.
