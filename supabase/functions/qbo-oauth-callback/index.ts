// Finishes the QuickBooks Online OAuth handshake.
//
// The frontend (src/lib/qboOAuth.ts) sends the user here to QBO's consent
// screen with a `state` value it kept in sessionStorage, gets redirected
// back with `?code=&realmId=&state=`, verifies `state` itself, then POSTs
// { code, realmId, redirectUri } here (with the user's normal Supabase
// session JWT — this function keeps the default verify_jwt=true, unlike
// havelock-sso-verify) to exchange the code for tokens and store the
// connection.
//
// Env (Supabase function secrets):
//   QBO_CLIENT_ID / QBO_CLIENT_SECRET  — from the Intuit Developer app
//   QBO_ENVIRONMENT                    — "sandbox" | "production"
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { CORS_HEADERS, jsonResponse } from '../_shared/qbo-client.ts'

/** Pulls the `email` claim out of an already-platform-verified JWT (no need
 *  to re-verify the signature — Supabase only invoked us because it's valid). */
function emailFromJwt(authHeader: string | null): string | null {
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload?.email ?? null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)

  const clientId = Deno.env.get('QBO_CLIENT_ID')
  const clientSecret = Deno.env.get('QBO_CLIENT_SECRET')
  const environment = (Deno.env.get('QBO_ENVIRONMENT') || 'sandbox') as 'sandbox' | 'production'
  if (!clientId || !clientSecret) return jsonResponse({ error: 'QBO app not configured' }, 500)

  let body: { code?: string; realmId?: string; redirectUri?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'bad request' }, 400)
  }
  const { code, realmId, redirectUri } = body
  if (!code || !realmId || !redirectUri) {
    return jsonResponse({ error: 'code, realmId and redirectUri are required' }, 400)
  }

  const basicAuth = btoa(`${clientId}:${clientSecret}`)
  const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  })
  if (!tokenRes.ok) {
    return jsonResponse({ error: `QBO token exchange failed: ${await tokenRes.text()}` }, 502)
  }
  const tokens = await tokenRes.json()

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const now = Date.now()
  const { error } = await supabase.from('havelock_qbo_connection').upsert({
    id: true,
    realm_id: realmId,
    environment,
    access_token: tokens.access_token,
    access_token_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    refresh_token: tokens.refresh_token,
    refresh_token_expires_at: new Date(now + tokens.x_refresh_token_expires_in * 1000).toISOString(),
    connected_by_email: emailFromJwt(req.headers.get('authorization')),
    updated_at: new Date(now).toISOString(),
  })
  if (error) return jsonResponse({ error: `could not store QBO connection: ${error.message}` }, 500)

  return jsonResponse({ connected: true, realmId, environment })
})
