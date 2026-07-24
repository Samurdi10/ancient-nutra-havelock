-- QuickBooks Online integration: connection/token storage, product-to-item
-- mapping, and a sync audit log. Sales (havelock_bills), physical stock
-- entries, and completed purchase orders are pushed to QBO as Sales
-- Receipts / Inventory Quantity Adjustments / Bills respectively, so QBO's
-- Inventory becomes the system of record for stock on hand.

-- Single-row table holding the OAuth connection to one QBO company (realm).
-- Only ever read/written by edge functions using the service role key —
-- never exposed to the client, unlike every other havelock_* table.
create table public.havelock_qbo_connection (
  id boolean primary key default true,
  realm_id text not null,
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  access_token text not null,
  access_token_expires_at timestamptz not null,
  refresh_token text not null,
  refresh_token_expires_at timestamptz not null,
  connected_by_email text,
  updated_at timestamptz not null default now(),
  constraint havelock_qbo_connection_singleton check (id)
);

alter table public.havelock_qbo_connection enable row level security;
-- Intentionally no policies for `authenticated` — this table is only ever
-- touched via edge functions using the service role key, which bypasses RLS.

-- Product name -> QBO Item mapping. Products are free-text names in this app
-- (see havelock_product_prices for the same pattern); a sync can only push a
-- line item once its product has a mapping here.
create table public.havelock_qbo_item_map (
  product_name text primary key,
  qbo_item_id text not null,
  qbo_item_name text not null,
  updated_by_email text default auth.email(),
  updated_at timestamptz not null default now()
);

alter table public.havelock_qbo_item_map enable row level security;

create policy "Authenticated staff can read qbo item map"
  on public.havelock_qbo_item_map for select
  to authenticated
  using (true);

create policy "Authenticated staff can upsert qbo item map"
  on public.havelock_qbo_item_map for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can update qbo item map"
  on public.havelock_qbo_item_map for update
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated staff can delete qbo item map"
  on public.havelock_qbo_item_map for delete
  to authenticated
  using (true);

grant select, insert, update, delete on public.havelock_qbo_item_map to authenticated;

-- One row per sync attempt, for idempotency (don't double-push the same
-- record) and a visible audit trail in the UI.
create type public.qbo_sync_record_type as enum ('bill', 'stock_entry', 'purchase_order');
create type public.qbo_sync_status as enum ('pending', 'success', 'error');

create table public.havelock_qbo_sync_log (
  id uuid primary key default gen_random_uuid(),
  record_type public.qbo_sync_record_type not null,
  record_id uuid not null,
  status public.qbo_sync_status not null default 'pending',
  qbo_id text,
  error text,
  created_by_email text default auth.email(),
  created_at timestamptz not null default now()
);

create index havelock_qbo_sync_log_record_idx
  on public.havelock_qbo_sync_log (record_type, record_id, created_at desc);

alter table public.havelock_qbo_sync_log enable row level security;

create policy "Authenticated staff can read qbo sync log"
  on public.havelock_qbo_sync_log for select
  to authenticated
  using (true);

grant select on public.havelock_qbo_sync_log to authenticated;
-- Insert/update happens only from edge functions via the service role key.
