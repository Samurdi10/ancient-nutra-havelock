// Pushes one completed purchase order (havelock_purchase_orders +
// havelock_purchase_order_items) to QuickBooks Online as a Bill, which
// increases QBO Inventory on hand for every mapped line item. Call with
// { purchaseOrderId }. Only POs with status "Completed" are accepted — a
// Pending/Approved/Rejected PO hasn't actually received stock yet.
//
// The PO's free-text `supplier_name` is matched (or created) as a QBO Vendor
// by exact display name — see findOrCreateVendorRef in ../_shared/qbo-client.ts.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  CORS_HEADERS,
  jsonResponse,
  getValidConnection,
  postQboEntity,
  findOrCreateVendorRef,
  findQboItemRef,
  logSyncResult,
} from '../_shared/qbo-client.ts'

interface PoItemRow {
  product_name: string
  quantity: number
  rate: number
  total: number
}

interface PoRow {
  id: string
  po_no: string
  po_date: string
  status: string
  supplier_name: string | null
  havelock_purchase_order_items: PoItemRow[]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)

  let purchaseOrderId: string | undefined
  try {
    purchaseOrderId = (await req.json())?.purchaseOrderId
  } catch {
    return jsonResponse({ error: 'bad request' }, 400)
  }
  if (!purchaseOrderId) return jsonResponse({ error: 'purchaseOrderId is required' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const { data: existing } = await supabase
    .from('havelock_qbo_sync_log')
    .select('qbo_id')
    .eq('record_type', 'purchase_order')
    .eq('record_id', purchaseOrderId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing?.qbo_id) return jsonResponse({ qboId: existing.qbo_id, alreadySynced: true })

  const { data: po, error: poError } = await supabase
    .from('havelock_purchase_orders')
    .select(
      'id, po_no, po_date, status, supplier_name, havelock_purchase_order_items(product_name, quantity, rate, total)',
    )
    .eq('id', purchaseOrderId)
    .maybeSingle<PoRow>()
  if (poError || !po) return jsonResponse({ error: 'purchase order not found' }, 404)
  if (po.status !== 'Completed') {
    return jsonResponse({ error: `Purchase order must be Completed (is "${po.status}") before syncing stock in.` }, 422)
  }
  if (!po.supplier_name) return jsonResponse({ error: 'Purchase order has no supplier name to match a QBO vendor.' }, 422)

  const unmappedProducts: string[] = []
  const lineInputs: { itemRef: { value: string; name: string }; qty: number; rate: number; amount: number }[] = []
  for (const item of po.havelock_purchase_order_items) {
    const itemRef = await findQboItemRef(supabase, item.product_name)
    if (!itemRef) {
      unmappedProducts.push(item.product_name)
      continue
    }
    lineInputs.push({ itemRef, qty: item.quantity, rate: item.rate, amount: item.total })
  }

  if (lineInputs.length === 0) {
    return jsonResponse(
      { error: 'No line items are mapped to a QBO item yet.', unmappedProducts },
      422,
    )
  }

  try {
    const conn = await getValidConnection(supabase)
    const vendorRef = await findOrCreateVendorRef(conn, po.supplier_name)
    const bill = await postQboEntity(conn, 'bill', {
      TxnDate: po.po_date,
      DocNumber: po.po_no,
      VendorRef: { value: vendorRef.value, name: vendorRef.name },
      Line: lineInputs.map((l) => ({
        Amount: l.amount,
        DetailType: 'ItemBasedExpenseLineDetail',
        ItemBasedExpenseLineDetail: { ItemRef: l.itemRef, Qty: l.qty, UnitPrice: l.rate },
      })),
    })
    const qboId = (bill as { Bill?: { Id?: string } }).Bill?.Id
    await logSyncResult(supabase, { recordType: 'purchase_order', recordId: purchaseOrderId, status: 'success', qboId })
    return jsonResponse({ qboId, unmappedProducts })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logSyncResult(supabase, { recordType: 'purchase_order', recordId: purchaseOrderId, status: 'error', error: message })
    return jsonResponse({ error: message, unmappedProducts }, 502)
  }
})
