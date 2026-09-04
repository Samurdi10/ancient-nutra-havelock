// Pushes one daily bill (havelock_bills + havelock_bill_items) to QuickBooks
// Online as an Invoice, which auto-decrements QBO Inventory on hand for every
// mapped line item. Call with { billId }.
//
// Deliberately an Invoice, not a Sales Receipt, to match the transaction type
// this business's other systems (e.g. AN Delivery) already push to this same
// QBO company — even though these POS sales are paid immediately, so the
// resulting Invoice shows as open/"Overdue" until someone records payment
// against it in QuickBooks.
//
// Products with no row in havelock_qbo_item_map are skipped (not failed) and
// listed back in the response as `unmappedProducts`, mirroring the warning
// style already used for PDF-parsing and price-list mismatches in this app.
//
// QBO requires a CustomerRef on every Invoice; retail POS sales aren't tied
// to a real customer record, so every bill posts under one shared customer
// named for this outlet specifically, found-or-created automatically (see
// findOrCreateCustomerRef) — no manual QBO setup needed. Named for the
// outlet rather than a generic "Walk-in Customer" so Havelock's retail sales
// stay distinguishable from other channels (e.g. AN Delivery) that may push
// to this same QBO company under their own generic customer.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  CORS_HEADERS,
  jsonResponse,
  getValidConnection,
  postQboEntity,
  queryQbo,
  findQboItemRef,
  findOrCreateCustomerRef,
  logSyncResult,
} from '../_shared/qbo-client.ts'

const OUTLET_CUSTOMER_NAME = 'Havelock Sales'

interface BillItemRow {
  product_name: string
  quantity: number
  net_total: number
}

interface BillRow {
  id: string
  report_date: string
  invoice_number: string
  net_total: number
  havelock_bill_items: BillItemRow[]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)

  let billId: string | undefined
  try {
    billId = (await req.json())?.billId
  } catch {
    return jsonResponse({ error: 'bad request' }, 400)
  }
  if (!billId) return jsonResponse({ error: 'billId is required' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  // Idempotent: a bill already pushed successfully just returns its QBO id again.
  const { data: existing } = await supabase
    .from('havelock_qbo_sync_log')
    .select('qbo_id')
    .eq('record_type', 'bill')
    .eq('record_id', billId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing?.qbo_id) return jsonResponse({ qboId: existing.qbo_id, alreadySynced: true })

  const { data: bill, error: billError } = await supabase
    .from('havelock_bills')
    .select('id, report_date, invoice_number, net_total, havelock_bill_items(product_name, quantity, net_total)')
    .eq('id', billId)
    .maybeSingle<BillRow>()
  if (billError || !bill) return jsonResponse({ error: 'bill not found' }, 404)

  const unmappedProducts: string[] = []
  const lines: Record<string, unknown>[] = []
  for (const item of bill.havelock_bill_items) {
    const itemRef = await findQboItemRef(supabase, item.product_name)
    if (!itemRef) {
      unmappedProducts.push(item.product_name)
      continue
    }
    lines.push({
      Amount: item.net_total,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: itemRef.value, name: itemRef.name },
        Qty: item.quantity,
        // Havelock's POS data doesn't track a separate tax amount per bill,
        // and QBO's sales tax feature rejects an Invoice with no tax code at
        // all. "NON" isn't a valid code on this (non-US) company's own tax
        // code list. Id 2 was once this company's "VAT Exempted" code but
        // has since been repurposed as the standard 18% "VAT" code (its
        // SalesTaxRateList now points at the 18% rate) -- sending it was
        // causing every invoice to be charged VAT instead of exempted. The
        // current real "VAT Exempted" code is Id 5 (verified live via the
        // qbo-tax-codes diagnostic: `select * from TaxCode`).
        TaxCodeRef: { value: '5' },
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
    const customerRef = await findOrCreateCustomerRef(conn, OUTLET_CUSTOMER_NAME)
    const receipt = await postQboEntity(conn, 'invoice', {
      TxnDate: bill.report_date,
      DocNumber: bill.invoice_number,
      CustomerRef: { value: customerRef.value },
      // "NotApplicable" (previously used here) does NOT actually turn tax
      // off for this company -- verified live: QBO still added 18% VAT on
      // top even with a genuinely exempt TaxCodeRef, meaning this company's
      // Automated Sales Tax setup determines taxability from the QBO Item
      // itself, not from anything sent on the transaction. "TaxInclusive"
      // tells QBO the Line Amount already includes whatever tax it decides
      // applies, so it's extracted from within instead of added on top --
      // keeping the customer-facing/Invoice total equal to the real bill
      // total either way.
      GlobalTaxCalculation: 'TaxInclusive',
      // Internal-only note (never shown to a customer, there isn't a real
      // one) so these are recognizable as Havelock POS sales when browsing
      // QBO's transaction list, distinct from any other Sales Receipts.
      PrivateNote: `Havelock Daily Invoice — ${bill.invoice_number} (${bill.report_date}), total LKR ${bill.net_total}`,
      Line: lines,
    })
    const qboId = (receipt as { Invoice?: { Id?: string } }).Invoice?.Id
    await logSyncResult(supabase, { recordType: 'bill', recordId: billId, status: 'success', qboId })
    return jsonResponse({ qboId, unmappedProducts })
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err)

    // "Duplicate Document Number" (QBO error code 6140) means an Invoice with
    // this DocNumber already exists in QBO — almost always because an earlier
    // attempt for this exact bill DID create it there, but something after
    // that call failed (e.g. a token refresh mid-flight) before we recorded
    // success locally. Our own idempotency check above only knows about our
    // own successful log rows, so it can't catch this; treat "QBO already has
    // it" as success too, rather than erroring forever on every retry.
    if (message.includes('code 6140')) {
      try {
        const conn = await getValidConnection(supabase)
        const escapedDocNumber = bill.invoice_number.replace(/'/g, "\\'")
        const result = await queryQbo(conn, `select Id from Invoice where DocNumber = '${escapedDocNumber}'`)
        const foundId = (result as { QueryResponse?: { Invoice?: { Id: string }[] } }).QueryResponse?.Invoice?.[0]?.Id
        if (foundId) {
          await logSyncResult(supabase, { recordType: 'bill', recordId: billId, status: 'success', qboId: foundId })
          return jsonResponse({ qboId: foundId, unmappedProducts, recoveredFromDuplicate: true })
        }
        message = `${message} (also failed to find the existing invoice by DocNumber to recover)`
      } catch {
        message = `${message} (also failed to look up the existing invoice by DocNumber to recover)`
      }
    }

    await logSyncResult(supabase, { recordType: 'bill', recordId: billId, status: 'error', error: message })
    return jsonResponse({ error: message, unmappedProducts }, 502)
  }
})
