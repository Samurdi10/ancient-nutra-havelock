# Havelock Orders

Daily bill dashboard for **Ancient Nutra - Havelock City Mall**. The outlet's
POS system exports a "Bill Wise Report" PDF each day; this app parses that PDF
in the browser, stores it, and shows it as a dashboard instead of a flat PDF.

Stack: React + TypeScript + Vite, Supabase (Postgres + Auth), deployed on
Netlify.

## How it works

1. At the end of the day, download the POS's "Bill Wise Report" PDF for the
   outlet.
2. Open this app and click **Upload daily report PDF**. It's parsed entirely
   client-side (`pdfjs-dist`) — nothing is sent anywhere until you review and
   save it.
3. A preview shows every bill it found (time, invoice number, items, net
   total, payment method) plus any warnings if something looks off (bill
   count mismatch, totals mismatch against the PDF's own summary line).
   Review it, then click **Save**.
4. The dashboard shows that day's KPIs (total bills, revenue, avg bill value,
   avg items per bill), a payment-method breakdown, the full bill list, and a
   product-level breakdown (top-selling products by quantity/revenue). Use
   the date dropdown to switch between previously uploaded days.

Re-uploading the same day's PDF is safe — bills are upserted by invoice
number, so it just refreshes that day's data instead of duplicating it.

### Why parsing needs care

The POS's PDF is wider than one printable page, so its single "Bill Wise
Report" table gets split into three column-groups printed as separate pages:
`[Outlet, Date, Time, Invoice Number, Order Number]`, then
`[Order Item, Quantity, Gross Total, Discount, NBT, Service Charge, TDL,
VAT]`, then `[Net Total, Payment Method]`. All three share the same row
order, so [`src/lib/parseHavelockReport.ts`](src/lib/parseHavelockReport.ts)
recombines them by row index rather than needing pixel-perfect column
positions. See the comment at the top of that file for the full layout
breakdown. Because this is a heuristic reconstruction (not a documented
export format), the app always shows a review step before saving, and flags
mismatches against the PDF's own stated totals as warnings.

## Setup

### 1. Supabase (Multix project)

1. In the Multix Supabase project, open **SQL Editor** and run
   [`supabase/migrations/0002_public_schema_fallback.sql`](supabase/migrations/0002_public_schema_fallback.sql).
   This creates `havelock_bills` and `havelock_bill_items` in the `public`
   schema, with RLS policies restricting access to authenticated staff.
   ([`0001_init.sql`](supabase/migrations/0001_init.sql) creates the same
   tables in a dedicated `havelock` schema — not used by the app currently,
   see note below.)
2. Go to **Authentication → Users** and invite/create an account for each
   person who needs access, with **Auto Confirm User** on. There's no public
   sign-up page. (Not needed if everyone signs in via the SPINE tile — see
   below.)
3. Copy the project URL and anon public key from **Project Settings → API**.

**Note on schema:** the app originally used an isolated `havelock` schema
(matching the `an_delivery` pattern), but Supabase's exposed-schema config got
stuck out of sync with the running PostgREST instance for this project —
`havelock` showed as exposed in the dashboard, yet API requests kept failing
with `PGRST106: Invalid schema: havelock`. Toggling the schema on/off, a full
project restart, and `NOTIFY pgrst, 'reload config'` / `'reload schema'` all
failed to fix it (Supabase support ticket SU-426244). Tables were moved into
`public` (prefixed `havelock_`) as a working fallback. If Supabase resolves
the underlying bug, the app can be migrated back to a dedicated schema.

### 2. Local development

```bash
npm install
cp .env.example .env.local
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local
npm run dev
```

### 3. Deploy to Netlify

1. Push this repo to GitHub, then connect it to a new Netlify site.
2. Build command `npm run build`, publish directory `dist` (already set in
   `netlify.toml`).
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment
   variables in Netlify's site settings (Site configuration → Environment
   variables) — same values as `.env.local`.
4. Deploy.

## SPINE sign-in (SSO)

Staff normally open this app from the **SPINE** launcher, not by URL. SPINE
opens the app at `.../#srv_token=<token>` after the person has signed into
SPINE once with the shared company credential. The app exchanges that launch
token for a real Supabase session — so each person signs in **as their own
user** without typing a password here. Per-user email + password login stays
as a fallback for direct access.

How it fits together:

- **App side** — [`src/App.tsx`](src/App.tsx) reads the `#srv_token` on first
  paint ([`src/lib/launchToken.ts`](src/lib/launchToken.ts)), POSTs it to the
  `havelock-sso-verify` edge function
  ([`src/lib/spineSso.ts`](src/lib/spineSso.ts)), then calls
  `supabase.auth.verifyOtp` to get a session and strips the token from the URL.
- **Edge function** —
  [`supabase/functions/havelock-sso-verify`](supabase/functions/havelock-sso-verify/index.ts)
  verifies the launch token with `ATLAS_BRIDGE_SECRET`, find-or-creates the
  Supabase user for the person's email, and returns a one-time magic-link
  `token_hash`.

### SPINE-managed secrets (names only)

Set these as **Supabase function secrets** on the Multix project
(`Project Settings → Edge Functions → Secrets`, or `supabase secrets set`).
Ask Sahan / SPINE for the values — never commit them.

| Secret | Purpose | Source |
|---|---|---|
| `ATLAS_BRIDGE_SECRET` | Verify the SPINE launch token | Shared SPINE secret (same value across all connected apps) |
| `APP_TASK_SECRET` | *Optional* — re-check the App-Access grant via SPINE's oracle | SPINE (only if you want server-side grant enforcement) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected into edge
functions — no need to set them.

### Deploy the edge function

The launch token is not a Supabase JWT, so the function must be deployed with
JWT verification **off** (it does its own HMAC verification):

```bash
supabase functions deploy havelock-sso-verify \
  --project-ref troxvvwkiontbliwuvkn \
  --no-verify-jwt
```

### Register the tile in SPINE

This repo only covers the app side of SSO. Someone with access to the SPINE
repo still needs to register a new tile/surface `module_havelock` pointing at
this app's deployed URL — that's a separate repo, not part of this project.

## Roadmap

- Product catalog / SKU reconciliation (currently product names are stored as
  free text — no SKU linking yet).
- Multi-outlet support if Ancient Nutra opens more retail locations (the
  outlet name is already captured per bill, so this mostly needs a filter in
  the UI).
- Trend charts across multiple days (currently each day is viewed
  individually via the date dropdown).
