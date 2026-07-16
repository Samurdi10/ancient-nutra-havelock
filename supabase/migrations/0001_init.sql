-- Havelock Orders: daily "Bill Wise Report" PDF -> structured bills/items.
-- Uses its own schema inside the shared Multix project so it stays isolated
-- from other Multix tables (an_delivery, etc).

create schema if not exists havelock;

create table havelock.bills (
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

create index bills_report_date_idx on havelock.bills (report_date);

alter table havelock.bills enable row level security;

create policy "Authenticated staff can read bills"
  on havelock.bills for select
  to authenticated
  using (true);

create policy "Authenticated staff can insert bills"
  on havelock.bills for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can update bills"
  on havelock.bills for update
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated staff can delete bills"
  on havelock.bills for delete
  to authenticated
  using (true);

grant usage on schema havelock to authenticated;
grant select, insert, update, delete on havelock.bills to authenticated;

create table havelock.bill_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references havelock.bills(id) on delete cascade,
  product_name text not null,
  quantity numeric not null default 1,
  gross_total numeric not null default 0,
  net_total numeric not null default 0,
  created_at timestamptz not null default now()
);

create index bill_items_bill_id_idx on havelock.bill_items (bill_id);

alter table havelock.bill_items enable row level security;

create policy "Authenticated staff can read bill items"
  on havelock.bill_items for select
  to authenticated
  using (true);

create policy "Authenticated staff can insert bill items"
  on havelock.bill_items for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can delete bill items"
  on havelock.bill_items for delete
  to authenticated
  using (true);

grant select, insert, delete on havelock.bill_items to authenticated;
