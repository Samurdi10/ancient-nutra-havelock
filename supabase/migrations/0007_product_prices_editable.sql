-- The price list started as a read-only reference seeded from the website;
-- staff now need to correct prices and add products manually (e.g. ones the
-- website doesn't sell, or names that never matched the POS).

create policy "Authenticated staff can insert product prices"
  on public.havelock_product_prices for insert
  to authenticated
  with check (true);

create policy "Authenticated staff can update product prices"
  on public.havelock_product_prices for update
  to authenticated
  using (true)
  with check (true);

grant insert, update on public.havelock_product_prices to authenticated;
