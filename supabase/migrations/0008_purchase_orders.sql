-- Purchase Order requests to a supplier/warehouse, matching the "Purchase
-- Order - PO/00164" document layout: header (location, supplier, status),
-- item lines (Item Code, Item Name, Rate, Qty, Net Total, Discount, Tax,
-- Total), and a summary block.

create sequence public.havelock_po_seq;

create table public.havelock_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_no text not null unique
    default ('PO/' || lpad(nextval('public.havelock_po_seq')::text, 5, '0')),
  po_date date not null default current_date,
  ref_doc_no text,
  from_location text not null default 'Ancient Nutra - Havelock City Mall',
  to_location text not null default 'Ancient Nutra - Havelock City Mall',
  supplier_name text,
  supplier_reg_no text,
  status text not null default 'Pending'
    check (status in ('Pending', 'Approved', 'Rejected', 'Completed')),
  remarks text,
  net_total numeric not null default 0,
  total_discount numeric not null default 0,
  total_tax numeric not null default 0,
  total numeric not null default 0,
  created_by_email text default auth.email(),
  created_at timestamptz not null default now()
);

create index havelock_purchase_orders_date_idx on public.havelock_purchase_orders (po_date);

alter table public.havelock_purchase_orders enable row level security;

create policy "Authenticated staff can read purchase orders"
  on public.havelock_purchase_orders for select
  to authenticated
  using (true);

create policy "Authenticated staff can insert purchase orders"
  on public.havelock_purchase_orders for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can update purchase orders"
  on public.havelock_purchase_orders for update
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated staff can delete purchase orders"
  on public.havelock_purchase_orders for delete
  to authenticated
  using (true);

grant select, insert, update, delete on public.havelock_purchase_orders to authenticated;
grant usage on sequence public.havelock_po_seq to authenticated;

create table public.havelock_purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.havelock_purchase_orders(id) on delete cascade,
  item_code text,
  product_name text not null,
  rate numeric not null default 0,
  quantity numeric not null default 0,
  unit text not null default 'Numbers',
  net_total numeric not null default 0,
  discount_value numeric not null default 0,
  tax_amount numeric not null default 0,
  tax_combination text not null default 'VAT',
  total numeric not null default 0
);

create index havelock_po_items_po_id_idx on public.havelock_purchase_order_items (po_id);

alter table public.havelock_purchase_order_items enable row level security;

create policy "Authenticated staff can read purchase order items"
  on public.havelock_purchase_order_items for select
  to authenticated
  using (true);

create policy "Authenticated staff can insert purchase order items"
  on public.havelock_purchase_order_items for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can delete purchase order items"
  on public.havelock_purchase_order_items for delete
  to authenticated
  using (true);

grant select, insert, delete on public.havelock_purchase_order_items to authenticated;
