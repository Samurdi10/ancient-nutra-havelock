// SPINE one-company-password sign-in (Option A) — launch-token verify.
//
// SPINE mints a short-lived HMAC "launch token" when a user (already logged into
// SPINE with the shared company credential) clicks the Havelock Orders tile. SPINE
// opens this app at `https://<site>.netlify.app/#srv_token=<token>`. The frontend
// POSTs the token here. We verify it with the shared secret ATLAS_BRIDGE_SECRET,
// trust the email inside, find-or-create the Supabase auth user for that email,
// and hand back a one-time magic-link `token_hash` the frontend exchanges for a
// real Supabase session (so RLS keyed on auth.uid() keeps working unchanged, and
// each person signs in as their own user).
//
// Env (Supabase function secrets):
//   ATLAS_BRIDGE_SECRET        — shared HMAC secret to verify the launch token (required)
//   SUPABASE_URL               — this app's Supabase project (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY  — service role for admin auth ops (auto-injected)
//   APP_TASK_SECRET            — optional; if set, re-check the grant via SPINE's oracle
//   SPINE_URL                  — optional; defaults to https://srv-spine.netlify.app
//
// Deploy (verify_jwt MUST be false — the function does its own auth):
//   supabase functions deploy havelock-sso-verify --project-ref troxvvwkiontbliwuvkn --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SURFACE = 'module_havelock'
const SPINE_URL = Deno.env.get('SPINE_URL') || 'https://srv-spine.netlify.app'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Canonical SPINE launch-token verify (HMAC-SHA256, base64url payload {email,surface,admin,exp}).
async function verifyLaunchToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<{ email: string; surface: string; admin: boolean } | null> {
  if (!token || !secret) return null
  const dot = token.indexOf('.')
  if (dot < 1 || dot === token.length - 1) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const expected = b64url(new Uint8Array(mac))
  if (sig.length !== expected.length) return null
  if (!timingSafeEqual(sig, expected)) return null

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(b64urlDecode(payload))
  } catch {
    return null
  }
  if (!obj?.email || !obj?.surface || !obj?.exp || now > Number(obj.exp)) return null
  return {
    email: String(obj.email).toLowerCase(),
    surface: String(obj.surface),
    admin: !!obj.admin,
  }
}

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  return atob(b64)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Optional server-side re-check of the grant via SPINE's oracle.
async function oracleGrants(email: string): Promise<{ granted: boolean; admin: boolean } | null> {
  const appSecret = Deno.env.get('APP_TASK_SECRET')
  if (!appSecret) return null // oracle re-check disabled
  try {
    const res = await fetch(`${SPINE_URL}/.netlify/functions/app-access`, {
      method: 'POST',
      headers: { 'x-app-secret': appSecret, 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const g = data?.apps?.[SURFACE]
    // CEO always has access; otherwise honour the per-app grant.
    if (data?.isCeo) return { granted: true, admin: true }
    if (!g) return { granted: false, admin: false }
    return { granted: !!g.granted, admin: !!g.admin }
  } catch {
    return null // oracle unreachable — fall back to trusting the launch token
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const secret = Deno.env.get('ATLAS_BRIDGE_SECRET')
  if (!secret) return json({ error: 'sso not configured' }, 500)

  let token: string | undefined
  try {
    const body = await req.json()
    token = body?.token
  } catch {
    return json({ error: 'bad request' }, 400)
  }

  const claims = await verifyLaunchToken(token || '', secret)
  if (!claims) return json({ error: 'invalid or expired token' }, 401)
  if (claims.surface !== SURFACE) return json({ error: 'wrong surface' }, 403)

  const email = claims.email
  let admin = claims.admin

  const oracle = await oracleGrants(email)
  if (oracle) {
    if (!oracle.granted) return json({ error: 'access revoked' }, 403)
    admin = oracle.admin || admin
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  // Find or create the Supabase auth user for this email.
  const { data: list } = await supabase.auth.admin.listUsers()
  let user = list?.users?.find((u) => u.email?.toLowerCase() === email)
  if (!user) {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { spine_surface: SURFACE, spine_admin: admin },
    })
    if (createErr || !created?.user) return json({ error: 'could not provision user' }, 500)
    user = created.user
  } else {
    await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: { spine_surface: SURFACE, spine_admin: admin },
    })
  }

  // Mint a one-time magic-link token_hash the frontend exchanges for a session.
  const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr || !link?.properties?.hashed_token) {
    return json({ error: 'could not mint session' }, 500)
  }

  return json({ token_hash: link.properties.hashed_token, admin })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  })
}
