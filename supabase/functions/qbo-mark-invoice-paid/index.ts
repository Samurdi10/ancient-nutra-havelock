// Records a Payment against one QBO Invoice for its full outstanding
// balance, deposited to Undeposited Funds (QBO's standard default -- the
// real bank match happens later via a Bank Deposit / bank feed, same as any
// other till reconciliation). Call with { billId }.
//
// These Invoices are POS sales that were paid in full at checkout, but
// pushing them as Invoices (see qbo-sync-bill) means QBO shows them as open/
// "Overdue" until a Payment is recorded -- this is that missing step,
// callable one bill at a time or in bulk from the QuickBooks tab.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { CORS_HEADERS, jsonResponse, getValidConnection, postQboEntity, queryQbo } from '../_shared/qbo-client.ts'

interface QboInvoice {
  Id: string
  Balance?: number
  CustomerRef?: { value: string }
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

  const { data: log } = await supabase
    .from('havelock_qbo_sync_log')
    .select('qbo_id')
    .eq('record_type', 'bill')
    .eq('record_id', billId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!log?.qbo_id) return jsonResponse({ error: 'This bill has no successful QuickBooks push to mark as paid.' }, 404)

  try {
    const conn = await getValidConnection(supabase)
    const escaped = log.qbo_id.replace(/'/g, "\\'")
    const result = await queryQbo(conn, `select * from Invoice where Id = '${escaped}'`)
    const invoice = (result as { QueryResponse?: { Invoice?: QboInvoice[] } }).QueryResponse?.Invoice?.[0]
    if (!invoice) return jsonResponse({ error: 'Invoice not found in QuickBooks' }, 404)

    const balance = invoice.Balance ?? 0
    if (balance <= 0) return jsonResponse({ alreadyPaid: true })
    if (!invoice.CustomerRef?.value) return jsonResponse({ error: 'Invoice has no CustomerRef to pay against' }, 502)

    const payment = await postQboEntity(conn, 'payment', {
      CustomerRef: { value: invoice.CustomerRef.value },
      TotalAmt: balance,
      Line: [{ Amount: balance, LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }] }],
    })
    const paymentId = (payment as { Payment?: { Id?: string } }).Payment?.Id
    return jsonResponse({ paymentId, amount: balance })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: message }, 502)
  }
})
