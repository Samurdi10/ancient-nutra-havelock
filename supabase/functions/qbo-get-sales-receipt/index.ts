// Fetches one Sales Receipt's details straight from QuickBooks Online, so
// staff can review what actually landed there without leaving the app.
// Call with { qboId }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { CORS_HEADERS, jsonResponse, getValidConnection, queryQbo } from '../_shared/qbo-client.ts'

interface QboSalesReceiptLine {
  Amount?: number
  SalesItemLineDetail?: { ItemRef?: { name?: string }; Qty?: number }
}

interface QboSalesReceipt {
  Id: string
  DocNumber?: string
  TxnDate?: string
  TotalAmt?: number
  CustomerRef?: { name?: string }
  Line?: QboSalesReceiptLine[]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)

  let qboId: string | undefined
  try {
    qboId = (await req.json())?.qboId
  } catch {
    return jsonResponse({ error: 'bad request' }, 400)
  }
  if (!qboId) return jsonResponse({ error: 'qboId is required' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  try {
    const conn = await getValidConnection(supabase)
    const escaped = qboId.replace(/'/g, "\\'")
    const result = await queryQbo(conn, `select * from SalesReceipt where Id = '${escaped}'`)
    const receipt = (result as { QueryResponse?: { SalesReceipt?: QboSalesReceipt[] } }).QueryResponse
      ?.SalesReceipt?.[0]
    if (!receipt) return jsonResponse({ error: 'Sales Receipt not found in QuickBooks' }, 404)

    return jsonResponse({
      id: receipt.Id,
      docNumber: receipt.DocNumber ?? null,
      txnDate: receipt.TxnDate ?? null,
      totalAmt: receipt.TotalAmt ?? null,
      customerName: receipt.CustomerRef?.name ?? null,
      lines: (receipt.Line ?? [])
        .filter((l) => l.SalesItemLineDetail)
        .map((l) => ({
          itemName: l.SalesItemLineDetail?.ItemRef?.name ?? null,
          qty: l.SalesItemLineDetail?.Qty ?? null,
          amount: l.Amount ?? null,
        })),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: message }, 502)
  }
})
