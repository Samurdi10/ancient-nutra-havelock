// Reports whether QuickBooks is connected, without exposing any token —
// havelock_qbo_connection has no client-readable RLS policy on purpose, so
// the frontend's "Connect QuickBooks" status badge goes through this
// authenticated (verify_jwt default) function instead.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { CORS_HEADERS, jsonResponse } from '../_shared/qbo-client.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const { data } = await supabase
    .from('havelock_qbo_connection')
    .select('realm_id, environment, connected_by_email, updated_at')
    .eq('id', true)
    .maybeSingle()

  if (!data) return jsonResponse({ connected: false })
  return jsonResponse({
    connected: true,
    realmId: data.realm_id,
    environment: data.environment,
    connectedByEmail: data.connected_by_email,
    updatedAt: data.updated_at,
  })
})
