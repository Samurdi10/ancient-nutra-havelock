// Lists active QBO Items (Inventory + Service + NonInventory) so the product
// mapping UI can offer a picker instead of asking staff to type a raw QBO
// item ID by hand.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { CORS_HEADERS, jsonResponse, getValidConnection, queryQbo } from '../_shared/qbo-client.ts'

interface QboItem {
  Id: string
  Name: string
  Type: string
  QtyOnHand?: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  try {
    const conn = await getValidConnection(supabase)
    // QBO caps query results at 1000 rows per page; Havelock's catalog is far
    // smaller than that, so a single page is enough for now.
    const result = await queryQbo(conn, 'select Id, Name, Type, QtyOnHand from Item where Active = true maxresults 1000')
    const items = ((result as { QueryResponse?: { Item?: QboItem[] } }).QueryResponse?.Item ?? []).map((i) => ({
      id: i.Id,
      name: i.Name,
      type: i.Type,
      qtyOnHand: i.QtyOnHand ?? null,
    }))
    return jsonResponse({ items })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: message }, 502)
  }
})
