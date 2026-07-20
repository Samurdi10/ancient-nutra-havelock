-- Fallback: the dedicated `havelock` schema (0001_init.sql) never became
-- usable via the Data API — Supabase's exposed-schema config got stuck out
-- of sync with the running PostgREST instance for this project (confirmed
-- via Supabase support ticket SU-426244; toggling the schema, a full project
-- restart, and `NOTIFY pgrst, 'reload config'/'reload schema'` all failed to
-- fix it). `public` is already exposed and working, so these tables live
-- there instead, prefixed `havelock_` to avoid clashing with existing
-- tables. If the schema-exposure bug is fixed later, the app can be
-- migrated back to `havelock.bills` / `havelock.bill_items`.

create table public.havelock_bills (
  id uuid primary key default gen_random_uuid(),
  report_date date not null,
  outlet text not null default 'Ancient Nutra - Havelock City Mall',
  bill_time text not null,
  invoice_number text not null unique,
  order_number text,
  net_total numeric not null default 0,
  payment_method text,
  source_file text,
  created_by_email text default auth.email(),
  created_at timestamptz not null default now()
);

create index havelock_bills_report_date_idx on public.havelock_bills (report_date);

alter table public.havelock_bills enable row level security;

create policy "Authenticated staff can read havelock bills"
  on public.havelock_bills for select
  to authenticated
  using (true);

create policy "Authenticated staff can insert havelock bills"
  on public.havelock_bills for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can update havelock bills"
  on public.havelock_bills for update
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated staff can delete havelock bills"
  on public.havelock_bills for delete
  to authenticated
  using (true);

grant select, insert, update, delete on public.havelock_bills to authenticated;

create table public.havelock_bill_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.havelock_bills(id) on delete cascade,
  product_name text not null,
  quantity numeric not null default 1,
  gross_total numeric not null default 0,
  net_total numeric not null default 0,
  created_at timestamptz not null default now()
);

create index havelock_bill_items_bill_id_idx on public.havelock_bill_items (bill_id);

alter table public.havelock_bill_items enable row level security;

create policy "Authenticated staff can read havelock bill items"
  on public.havelock_bill_items for select
  to authenticated
  using (true);

create policy "Authenticated staff can insert havelock bill items"
  on public.havelock_bill_items for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can delete havelock bill items"
  on public.havelock_bill_items for delete
  to authenticated
  using (true);

grant select, insert, delete on public.havelock_bill_items to authenticated;
