// SPINE one-company-password sign-in (Option A), app side.
//
// We POST the SPINE launch token to our `havelock-sso-verify` Supabase edge
// function. It verifies the token with ATLAS_BRIDGE_SECRET, find-or-creates
// the Supabase auth user for the person's email, and returns a one-time
// magic-link `token_hash`. We exchange that for a REAL Supabase session with
// `verifyOtp`, so `supabase.from(...)` calls and RLS (keyed on auth.uid())
// work unchanged — each person signs in as their own user.

import { supabase } from './supabase'

const SSO_VERIFY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/havelock-sso-verify`

/**
 * Exchange a SPINE launch token for a Supabase session.
 * Returns null on success, or an error message string on failure.
 */
export async function exchangeSpineToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(SSO_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      return body.error || 'SPINE sign-in failed. The link may have expired.'
    }
    const { token_hash } = (await res.json()) as { token_hash?: string }
    if (!token_hash) return 'SPINE sign-in failed. No session returned.'

    const { error } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash })
    if (error) return error.message
    return null
  } catch {
    return 'SPINE sign-in failed. Please try again from the SPINE launcher.'
  }
}
