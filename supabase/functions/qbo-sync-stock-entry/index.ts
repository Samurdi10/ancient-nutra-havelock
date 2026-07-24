// Pushes one physical stock entry (havelock_stock_entries +
// havelock_stock_entry_items) to QuickBooks Online as an InventoryAdjustment.
// Call with { stockEntryId }.
//
// A stock entry's `quantity` per line is an ABSOLUTE physical count (a stock
// take / bulk upload reads it from "Closing Stock"), not a movement — so this
// pushes it as `NewQty`, not `QtyDiff`. Using QtyDiff here would silently
// stack every count on top of QBO's existing on-hand number instead of
// correcting it.
//
// Env (Supabase function secrets):
//   QBO_INVENTORY_ADJUSTMENT_ACCOUNT_ID — the QBO account (typically an
//     Inventory Asset or "Inventory Shrinkage" account) InventoryAdjustment
//     requires as its AccountRef.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  CORS_HEADERS,
  jsonResponse,
  getValidConnection,
  postQboEntity,
  findQboItemRef,
  logSyncResult,
} from '../_shared/qbo-client.ts'

interface StockEntryItemRow {
  product_name: string
  quantity: number
}

interface StockEntryRow {
  id: string
  entry_no: string
  entry_date: string
  havelock_stock_entry_items: StockEntryItemRow[]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)

  const accountId = Deno.env.get('QBO_INVENTORY_ADJUSTMENT_ACCOUNT_ID')
  if (!accountId) return jsonResponse({ error: 'QBO_INVENTORY_ADJUSTMENT_ACCOUNT_ID is not configured' }, 500)

  let stockEntryId: string | undefined
  try {
    stockEntryId = (await req.json())?.stockEntryId
  } catch {
    return jsonResponse({ error: 'bad request' }, 400)
  }
  if (!stockEntryId) return jsonResponse({ error: 'stockEntryId is required' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const { data: existing } = await supabase
    .from('havelock_qbo_sync_log')
    .select('qbo_id')
    .eq('record_type', 'stock_entry')
    .eq('record_id', stockEntryId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing?.qbo_id) return jsonResponse({ qboId: existing.qbo_id, alreadySynced: true })

  const { data: entry, error: entryError } = await supabase
    .from('havelock_stock_entries')
    .select('id, entry_no, entry_date, havelock_stock_entry_items(product_name, quantity)')
    .eq('id', stockEntryId)
    .maybeSingle<StockEntryRow>()
  if (entryError || !entry) return jsonResponse({ error: 'stock entry not found' }, 404)

  const unmappedProducts: string[] = []
  const lines: Record<string, unknown>[] = []
  for (const item of entry.havelock_stock_entry_items) {
    const itemRef = await findQboItemRef(supabase, item.product_name)
    if (!itemRef) {
      unmappedProducts.push(item.product_name)
      continue
    }
    lines.push({
      DetailType: 'InventoryAdjustmentLine',
      ItemAdjustmentLineDetail: {
        ItemRef: { value: itemRef.value, name: itemRef.name },
        NewQty: item.quantity,
      },
    })
  }

  if (lines.length === 0) {
    return jsonResponse(
      { error: 'No line items are mapped to a QBO item yet.', unmappedProducts },
      422,
    )
  }

  try {
    const conn = await getValidConnection(supabase)
    const adjustment = await postQboEntity(conn, 'inventoryadjustment', {
      TxnDate: entry.entry_date,
      AccountRef: { value: accountId },
      Line: lines,
    })
    const qboId = (adjustment as { InventoryAdjustment?: { Id?: string } }).InventoryAdjustment?.Id
    await logSyncResult(supabase, { recordType: 'stock_entry', recordId: stockEntryId, status: 'success', qboId })
    return jsonResponse({ qboId, unmappedProducts })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logSyncResult(supabase, { recordType: 'stock_entry', recordId: stockEntryId, status: 'error', error: message })
    return jsonResponse({ error: message, unmappedProducts }, 502)
  }
})
