-- Grant a second person read access to the audit log.

drop policy "Only the owner can read the audit log" on public.havelock_audit_log;

create policy "Audit log viewers can read the audit log"
  on public.havelock_audit_log for select
  to authenticated
  using (auth.email() in ('info@silkrouteventures.com', 'marketing@esilkroute.com.lk'));
