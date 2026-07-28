-- The Bill Wise Report PDF's "Invoice Number" is only unique WITHIN a single
-- calendar day, not globally — confirmed from a report whose Date Range spans
-- 23/07/2026 - 24/07/2026, where invoice numbers 2607230002 through
-- 2607230009 each appear once on the 23rd and again, unchanged, on the 24th.
-- The original `invoice_number text unique` constraint would make the second
-- day's upsert silently overwrite the first day's bill (same conflict key),
-- destroying real revenue. Scoping uniqueness to (report_date, invoice_number)
-- fixes this while behaving identically for every already-uploaded single-day
-- report, where invoice numbers were never repeated to begin with.

alter table public.havelock_bills
  drop constraint havelock_bills_invoice_number_key;

alter table public.havelock_bills
  add constraint havelock_bills_report_date_invoice_number_key
  unique (report_date, invoice_number);
