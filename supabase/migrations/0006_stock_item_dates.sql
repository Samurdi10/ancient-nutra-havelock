-- Track manufacturing/expiry date per stock entry line item (batch-level
-- tracking matters for supplements) rather than per entry as a whole.

alter table public.havelock_stock_entry_items
  add column if not exists manufacturing_date date,
  add column if not exists expiry_date date;
