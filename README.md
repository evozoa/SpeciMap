# SpeciMap

Free, open-source specimen collection for fieldwork. Print uniquely numbered
QR tags sized for 20mL scintillation vials, scan a tag with your phone's
camera, photograph the specimen with the tag, and SpeciMap records the photo,
GPS location, and tag number — even with no signal.

## How it works

1. **Print tags** — the built-in generator makes print-ready PDF sheets. Each
   tag carries a QR code and a human-readable number, in two styles:
   - **Insert**: a strip that drops inside the vial
   - **Punch-hole**: a square whose hole fits over the vial's neck threads,
     held under the cap
2. **Scan** a tag with your phone's normal camera app. The QR opens
   `https://<your-host>/s/<tag-id>` in the browser — no app install needed
   (though installing the PWA is recommended for offline field use).
3. **Capture** — the app shows a live viewfinder with on-device focus
   guidance ("blurry — wipe the lens / move back"), records your GPS fix in
   parallel, and asks you to confirm the digital tag number matches the
   physical tag in frame.
4. **Confirm the location** on a map with a draggable pin, add optional
   notes, and save.
5. **Sync** — records and photos are stored on-device first and upload
   automatically when you're back online. Nothing is ever lost to a dead
   zone.

## Stack

React + Vite PWA · Dexie (IndexedDB) offline queue · Supabase (Postgres,
magic-link auth, storage) · Leaflet maps · pdf-lib tag sheets. Focus
detection is a Laplacian-variance metric computed on-device in a Web Worker —
no cloud AI, no photo leaves your phone until you save.

## Development

Prerequisites: Node 20+, and for the backend [Supabase
CLI](https://supabase.com/docs/guides/cli) + Docker.

```bash
npm install
cp .env.example .env        # fill in your Supabase URL + anon key
supabase start              # local Postgres/auth/storage stack
supabase db reset           # apply migrations + seed
npm run dev
```

Camera, GPS, and the service worker require HTTPS on a real phone. Use
`npm run dev -- --host` plus a tunnel with a stable HTTPS URL (e.g.
`cloudflared tunnel --url http://localhost:5173` or Tailscale Funnel).

```bash
npm test                    # vitest unit suite
npm run build               # typecheck + production build
```

## Printing tags

- Use **laser** printing (toner survives ethanol; inkjet does not), ideally
  on waterproof/synthetic sheet stock.
- Print at **100% / "Actual Size"** — never "Fit to page". Every sheet has a
  50mm calibration ruler; measure it before cutting a whole batch.
- The punch-hole is ~22.5mm — use scissors or a craft punch, not a standard
  office hole punch. See [docs/printing.md](docs/printing.md).

## Deploying

Cloudflare Pages (canonical: `specimap.org`) + a Supabase project. Push
migrations with `supabase db push`; deploys run from
`.github/workflows/deploy.yml`. The Supabase free tier pauses projects
after ~7 idle days — `keepalive.yml` pings it every 3 days. See
[docs/self-hosting.md](docs/self-hosting.md).

## License

[MIT](LICENSE)
