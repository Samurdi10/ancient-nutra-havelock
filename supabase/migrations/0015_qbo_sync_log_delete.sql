-- havelock_qbo_sync_log only ever granted `select` to authenticated (insert
-- was meant to happen only from edge functions via the service role key).
-- But the "Re-push all as Invoice" feature needs to clear old sync-log rows
-- from the client so a bill's idempotency check doesn't just keep returning
-- its old (now-wrong) transaction id -- without a delete grant, that clear
-- step was silently filtered down to zero rows by RLS, so every "re-push"
-- just handed back the original Sales Receipt id disguised as success.

create policy "Authenticated staff can delete qbo sync log"
  on public.havelock_qbo_sync_log for delete
  to authenticated
  using (true);

grant delete on public.havelock_qbo_sync_log to authenticated;
