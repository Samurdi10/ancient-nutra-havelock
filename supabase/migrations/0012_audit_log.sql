-- Audit trail for amendments made in the app — who changed a price or
-- created/deleted a stock entry, and what the values were. Any authenticated
-- staff member can write a log row (so their own actions get recorded), but
-- only the owner's email can read the log back — everyone else, including
-- other SPINE-connected staff, gets zero rows from a select, enforced here
-- at the RLS layer rather than just hidden in the UI.

create table public.havelock_audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('product_price', 'stock_entry')),
  action text not null check (action in ('created', 'updated', 'deleted')),
  summary text not null,
  details jsonb,
  changed_by_email text default auth.email(),
  created_at timestamptz not null default now()
);

create index havelock_audit_log_created_at_idx on public.havelock_audit_log (created_at desc);

alter table public.havelock_audit_log enable row level security;

create policy "Authenticated staff can insert audit log rows"
  on public.havelock_audit_log for insert
  to authenticated
  with check (true);

create policy "Only the owner can read the audit log"
  on public.havelock_audit_log for select
  to authenticated
  using (auth.email() = 'info@silkrouteventures.com');

grant select, insert on public.havelock_audit_log to authenticated;
-- No update/update policy and no delete policy — the log is append-only.
