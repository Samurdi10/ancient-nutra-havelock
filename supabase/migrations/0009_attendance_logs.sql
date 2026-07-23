-- Staff attendance log: clock in/out with name, place, and timestamps.
-- Free-text staff name (not tied to the shared login) since multiple staff
-- share one Havelock Orders account.

create table public.havelock_attendance_logs (
  id uuid primary key default gen_random_uuid(),
  staff_name text not null,
  place text not null default 'Havelock City Mall',
  log_date date not null default current_date,
  time_in timestamptz not null default now(),
  time_out timestamptz,
  created_by_email text default auth.email(),
  created_at timestamptz not null default now()
);

create index havelock_attendance_logs_date_idx on public.havelock_attendance_logs (log_date);

alter table public.havelock_attendance_logs enable row level security;

create policy "Authenticated staff can read attendance logs"
  on public.havelock_attendance_logs for select
  to authenticated
  using (true);

create policy "Authenticated staff can insert attendance logs"
  on public.havelock_attendance_logs for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can update attendance logs"
  on public.havelock_attendance_logs for update
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated staff can delete attendance logs"
  on public.havelock_attendance_logs for delete
  to authenticated
  using (true);

grant select, insert, update, delete on public.havelock_attendance_logs to authenticated;
