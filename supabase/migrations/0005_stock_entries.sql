-- Physical Stock Entry: manual stock-count/adjustment records, matching
-- OMAK's "Create New Stock Entry" flow (Entry No, Date, Ref Doc No,
-- Remarks, line items with qty/rate/total).

create sequence public.havelock_stock_entry_seq;

create table public.havelock_stock_entries (
  id uuid primary key default gen_random_uuid(),
  entry_no text not null unique
    default ('PSE-' || lpad(nextval('public.havelock_stock_entry_seq')::text, 5, '0')),
  entry_date date not null default current_date,
  ref_doc_no text,
  remarks text,
  total numeric not null default 0,
  created_by_email text default auth.email(),
  created_at timestamptz not null default now()
);

create index havelock_stock_entries_date_idx on public.havelock_stock_entries (entry_date);

alter table public.havelock_stock_entries enable row level security;

create policy "Authenticated staff can read stock entries"
  on public.havelock_stock_entries for select
  to authenticated
  using (true);

create policy "Authenticated staff can insert stock entries"
  on public.havelock_stock_entries for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can delete stock entries"
  on public.havelock_stock_entries for delete
  to authenticated
  using (true);

grant select, insert, delete on public.havelock_stock_entries to authenticated;
grant usage on sequence public.havelock_stock_entry_seq to authenticated;

create table public.havelock_stock_entry_items (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.havelock_stock_entries(id) on delete cascade,
  product_name text not null,
  quantity numeric not null default 0,
  rate numeric not null default 0,
  total numeric not null default 0
);

create index havelock_stock_entry_items_entry_id_idx on public.havelock_stock_entry_items (entry_id);

alter table public.havelock_stock_entry_items enable row level security;

create policy "Authenticated staff can read stock entry items"
  on public.havelock_stock_entry_items for select
  to authenticated
  using (true);

create policy "Authenticated staff can insert stock entry items"
  on public.havelock_stock_entry_items for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can delete stock entry items"
  on public.havelock_stock_entry_items for delete
  to authenticated
  using (true);

grant select, insert, delete on public.havelock_stock_entry_items to authenticated;
