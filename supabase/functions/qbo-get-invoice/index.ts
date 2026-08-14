// Fetches one Invoice's details straight from QuickBooks Online, so staff
// can review what actually landed there without leaving the app.
// Call with { qboId }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { CORS_HEADERS, jsonResponse, getValidConnection, queryQbo } from '../_shared/qbo-client.ts'

interface QboInvoiceLine {
  Amount?: number
  SalesItemLineDetail?: { ItemRef?: { name?: string }; Qty?: number }
}

interface QboInvoice {
  Id: string
  DocNumber?: string
  TxnDate?: string
  TotalAmt?: number
  Balance?: number
  CustomerRef?: { name?: string }
  Line?: QboInvoiceLine[]
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
    const result = await queryQbo(conn, `select * from Invoice where Id = '${escaped}'`)
    const invoice = (result as { QueryResponse?: { Invoice?: QboInvoice[] } }).QueryResponse?.Invoice?.[0]
    if (!invoice) return jsonResponse({ error: 'Invoice not found in QuickBooks' }, 404)

    return jsonResponse({
      id: invoice.Id,
      docNumber: invoice.DocNumber ?? null,
      txnDate: invoice.TxnDate ?? null,
      totalAmt: invoice.TotalAmt ?? null,
      balance: invoice.Balance ?? null,
      customerName: invoice.CustomerRef?.name ?? null,
      lines: (invoice.Line ?? [])
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
