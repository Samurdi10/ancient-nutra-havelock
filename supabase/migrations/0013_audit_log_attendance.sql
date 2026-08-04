-- Extend the audit log to also cover attendance time amendments.

alter table public.havelock_audit_log
  drop constraint havelock_audit_log_entity_type_check;

alter table public.havelock_audit_log
  add constraint havelock_audit_log_entity_type_check
  check (entity_type in ('product_price', 'stock_entry', 'attendance'));
