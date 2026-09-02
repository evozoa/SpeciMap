# Self-hosting SpeciMap

SpeciMap is a static web app plus a Supabase backend. Both have free tiers;
both can be fully self-hosted.

## Managed (easiest)

1. Create a project at [supabase.com](https://supabase.com).
2. `supabase link --project-ref <ref>` then `supabase db push` to apply
   `supabase/migrations/`.
3. In Supabase Auth settings: enable Email (magic link / OTP), and add your
   app origin to the redirect allowlist (`https://your-host/auth/callback`).
4. Deploy the frontend to **Cloudflare Pages** (the canonical deployment;
   Netlify works the same way):
   - `npx wrangler pages project create specimap` once, then pushes to
     `main` deploy via `.github/workflows/deploy.yml` (set the repo secrets
     listed at the top of that file), or deploy manually with
     `npm run build && npx wrangler pages deploy dist --project-name=specimap`.
   - SPA fallback: Pages serves `index.html` for unmatched paths
     automatically when there is no top-level `404.html` — `/s/:tagId` deep
     links just work.
   - Build-time env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
     `VITE_APP_ORIGIN` (the deployed origin — it's baked into printed QR
     codes, so treat it as permanent).
   - Custom domain: Pages project → Custom domains → add `specimap.org`
     (instant if the domain's DNS is already on Cloudflare).

### Free-tier caveats

- **Projects pause after ~7 idle days** — a paused project breaks tag
  scanning. `.github/workflows/keepalive.yml` pings the REST endpoint every
  3 days; enable it (or upgrade the project).
- Storage is 1GB ≈ 2–3k photos at SpeciMap's compression. Watch usage.

## Fully self-hosted

Run [Supabase self-hosted](https://supabase.com/docs/guides/self-hosting)
(Docker Compose) and serve `dist/` from any static server behind HTTPS.
HTTPS is required — camera and geolocation APIs refuse insecure origins.

## Important: QR permanence

Printed tags encode your origin forever. Choose a domain you can keep, and
never change `VITE_APP_ORIGIN` after printing real batches.
