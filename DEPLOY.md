# Deploy

The deployable surfaces and where each runs:

| Surface | Host | What it does |
|---|---|---|
| `marketing/` | Vercel (static) | Public landing — `index.html`, `pricing.html`, `receipts.html`, the live demo hook |
| `app/` | Vercel (Vite SPA) | The signed-in product — `/sign-up`, `/app/*`, `/terms`, etc. |
| `engine/` (worker) | Railway (always-on Node) | Polls `jobs` + `demo_requests`, runs `generate()`, etc. |
| `supabase/functions/` | Supabase (already deployed) | Stripe webhook, edge functions, etc. |

CI runs on every push: typecheck engine, build app. See `.github/workflows/ci.yml`.

Once a custom domain is wired, switch from "platform subdomains" to a
proper subdomain split (`getbylined.com` → marketing, `app.getbylined.com` →
SPA) — the marketing `app.js` rewriter is already structured for it.

---

## 1. Worker → Railway

Background process that polls `jobs` + `demo_requests`. Must run 24/7
or article generation / demos hang.

1. Sign in at [railway.com](https://railway.com) → **New Project** →
   **Deploy from GitHub repo** → pick this repo.
2. After it imports, open the service settings:
   - **Root Directory**: `engine`
   - **Start Command**: leave blank — `npm start` (from
     `engine/package.json`) is the default.
3. **Variables** → add the secrets (copy from your local
   `engine/.env`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `MINIMAX_API_KEY`
   - `MINIMAX_BASE_URL` (optional, default `https://api.minimaxi.chat/v1`)
   - `MINIMAX_MODEL` (optional, default `MiniMax-M2.7`)
   - `WORKER_POLL_MS` (optional, default `5000`)
   - `SENTRY_DSN` — see § 4 below
   - `SENTRY_ENV` (optional, default `production`)
4. **Deploy**. Logs should show `[worker] up — polling …`. Smoke-test
   by inserting a row into `public.demo_requests` from the Supabase
   SQL editor and watching the worker claim it.

### Honest gotchas
- Railway charges for always-on containers. Budget ~$5–10/mo at this
  worker's size.
- The worker reads `MINIMAX_API_KEY` — keep that scoped tight; demo
  abuse rate-limits exist in `request-demo` but the worker still
  spends a real API call per claim.

---

## 2. App → Vercel

Vite React SPA at `app/`.

1. Sign in at [vercel.com](https://vercel.com) → **Add New… →
   Project** → import the GitHub repo.
2. **Root Directory**: `app`. Vercel auto-detects Vite; `vercel.json`
   pins the build command + SPA rewrite.
3. **Environment Variables** (Production + Preview):
   - `VITE_SUPABASE_URL` — from `app/.env.local`
   - `VITE_SUPABASE_ANON_KEY` — from `app/.env.local`
   - `VITE_STRIPE_PUBLISHABLE_KEY` — from `app/.env.local`
4. **Deploy**. Note the assigned `*.vercel.app` URL — you'll need it
   for the marketing site (§3 below).

---

## 3. Marketing → Vercel

Pure static HTML at `marketing/`.

1. **Add New… → Project** → same repo, **Root Directory**:
   `marketing`. No build, no env vars.
2. **Deploy**.
3. **Critical post-deploy step**: open `marketing/app.js` and update
   the `APP_ORIGIN_PROD` constant to the URL Vercel gave you for the
   `app/` project in §2. Commit + push — the redeploy is automatic.
   ```js
   const APP_ORIGIN_PROD = 'https://YOUR-APP-URL.vercel.app';
   ```
   Without this, marketing CTAs 404.

---

## 4. Error tracking → Sentry

Worker runs unattended. Sentry is how you find out it crashed without
noticing articles stopped landing.

1. Sign in at [sentry.io](https://sentry.io) → **Create Project** →
   **Node.js** → name it `bylined-worker`.
2. Copy the DSN from **Settings → Client Keys**.
3. Add `SENTRY_DSN` to the Railway worker's env vars (§1.3). Redeploy.

Verify: temporarily `throw new Error("sentry smoke")` somewhere in
`engine/src/worker.ts`, push, watch Sentry for the issue, then revert.

---

## 5. CI

`.github/workflows/ci.yml` runs on every push to `main` and on PRs:
- `engine` job — `npm ci` + `npm run typecheck`
- `app` job — `npm ci` + `npm run build` (with placeholder envs to
  prove compilation; real values come from Vercel at deploy time)

Nothing to configure — it just runs.

---

## When a custom domain lands

1. Add the domain in Vercel (one of the two projects gets the apex
   `getbylined.com`, the other gets `app.getbylined.com`).
2. Update Supabase Auth's redirect URLs in
   **Authentication → URL Configuration** to include the prod app
   URL — email confirmations bounce through there.
3. Update Stripe webhook endpoint URL if it changes.
4. Update `APP_ORIGIN_PROD` in `marketing/app.js` to the new app URL.
