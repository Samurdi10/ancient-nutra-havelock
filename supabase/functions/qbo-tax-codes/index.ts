// One-time diagnostic: lists this company's real QBO TaxCode and TaxRate
// records, so a sync function can reference the correct code by Id instead
// of guessing. Read-only -- creates nothing, changes nothing.
//
// Kept as a standing utility (not deleted after use) in case tax codes ever
// need re-checking, e.g. after a QBO plan/region change.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { CORS_HEADERS, jsonResponse, getValidConnection, queryQbo } from '../_shared/qbo-client.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  try {
    const conn = await getValidConnection(supabase)
    const [taxCodes, taxRates] = await Promise.all([
      queryQbo(conn, 'select * from TaxCode'),
      queryQbo(conn, 'select * from TaxRate'),
    ])
    return jsonResponse({ taxCodes, taxRates })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: message }, 502)
  }
})
