// SPINE wiring check (CONNECT-KIT §2b) — reports which secrets this deployment
// actually has. Presence booleans only, never a value, never a fingerprint.
// Curl this BEFORE clicking the SPINE tile, and again after any env change
// (function env needs a redeploy to take effect).
//
// GET/POST /selftest
//
// Deploy (public, no JWT — this endpoint reports presence only, never a value):
//   supabase functions deploy selftest --project-ref troxvvwkiontbliwuvkn --no-verify-jwt

const SURFACE = 'module_havelock'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const present = (key: string) => Boolean(Deno.env.get(key))

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })

  const secrets = {
    ATLAS_BRIDGE_SECRET: present('ATLAS_BRIDGE_SECRET'), // required for SSO (havelock-sso-verify)
    SUPABASE_URL: present('SUPABASE_URL'), // auto-injected, required to provision the auth user
    SUPABASE_SERVICE_ROLE_KEY: present('SUPABASE_SERVICE_ROLE_KEY'), // auto-injected, required for admin auth ops
    APP_TASK_SECRET: present('APP_TASK_SECRET'), // optional — server-side App-Access re-check
    ATLAS_AGENT_TOKEN: present('ATLAS_AGENT_TOKEN'), // not used by this app yet — reported for completeness
  }

  return new Response(
    JSON.stringify({
      ok: secrets.ATLAS_BRIDGE_SECRET && secrets.SUPABASE_URL && secrets.SUPABASE_SERVICE_ROLE_KEY,
      surface: SURFACE,
      secrets,
    }),
    { headers: { 'content-type': 'application/json', ...cors } },
  )
})
