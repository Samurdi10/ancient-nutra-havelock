// Shared QuickBooks Online helpers used by every qbo-* edge function:
// access-token refresh (QBO access tokens last 1h, refresh tokens ~100 days),
// a thin REST wrapper, and the sync-log helper. Kept in one place so each
// sync function only has to build its own entity payload.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export interface QboConnection {
  realmId: string
  environment: 'sandbox' | 'production'
  accessToken: string
}

interface ConnectionRow {
  realm_id: string
  environment: 'sandbox' | 'production'
  access_token: string
  access_token_expires_at: string
  refresh_token: string
}

function apiBase(environment: 'sandbox' | 'production'): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com'
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number
  x_refresh_token_expires_in: number
}> {
  const clientId = Deno.env.get('QBO_CLIENT_ID')
  const clientSecret = Deno.env.get('QBO_CLIENT_SECRET')
  // A missing secret silently produces a Basic-auth header for "undefined:undefined"
  // (or half of the pair), which Intuit correctly rejects as invalid_client — but
  // that response looks identical to "the secret was rotated in Intuit and Supabase
  // wasn't updated to match", which is a completely different fix. Failing fast here,
  // before the network call, makes the "not configured on this function" case
  // immediately distinguishable from "Intuit rejected the credentials we sent".
  if (!clientId || !clientSecret) {
    throw new Error(
      'QBO token refresh failed: QBO_CLIENT_ID/QBO_CLIENT_SECRET are not set as Supabase function secrets for this project — set them (from the Intuit app\'s Keys & Credentials page) before treating this as an Intuit-side problem.',
    )
  }
  const basicAuth = btoa(`${clientId}:${clientSecret}`)

  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  })
  if (!res.ok) {
    const body = await res.text()
    // invalid_client specifically means Intuit rejected the client_id/secret pair
    // itself (as opposed to invalid_grant, a bad/expired/reused refresh token) —
    // almost always because the Intuit app's secret was regenerated on the Keys &
    // Credentials page after QBO_CLIENT_SECRET was last set here. Reconnecting
    // (the OAuth consent flow) does NOT fix this; QBO_CLIENT_SECRET must be updated
    // to match Intuit's current value first, or every refresh (and every future
    // reconnect, since qbo-oauth-callback uses the same secret) will keep failing.
    const hint = body.includes('invalid_client')
      ? ' — this means the app credentials Intuit has on file no longer match QBO_CLIENT_ID/QBO_CLIENT_SECRET here (most likely the secret was regenerated in Intuit\'s Keys & Credentials page); update the Supabase secret to match, reconnecting will not help'
      : ''
    throw new Error(`QBO token refresh failed: ${res.status} ${body}${hint}`)
  }
  return res.json()
}

/** Returns a connection with a guaranteed-valid access token, refreshing (and
 *  persisting the refresh) if the current one is expired or about to expire. */
export async function getValidConnection(supabase: SupabaseClient): Promise<QboConnection> {
  const { data: row, error } = await supabase
    .from('havelock_qbo_connection')
    .select('*')
    .eq('id', true)
    .maybeSingle<ConnectionRow>()

  if (error || !row) throw new Error('QuickBooks is not connected yet.')

  const expiresAt = new Date(row.access_token_expires_at).getTime()
  const expiringSoon = expiresAt - Date.now() < 5 * 60 * 1000 // refresh 5min early
  if (!expiringSoon) {
    return { realmId: row.realm_id, environment: row.environment, accessToken: row.access_token }
  }

  const refreshed = await refreshAccessToken(row.refresh_token)
  const now = Date.now()
  const { error: updateErr } = await supabase
    .from('havelock_qbo_connection')
    .update({
      access_token: refreshed.access_token,
      access_token_expires_at: new Date(now + refreshed.expires_in * 1000).toISOString(),
      refresh_token: refreshed.refresh_token,
      refresh_token_expires_at: new Date(now + refreshed.x_refresh_token_expires_in * 1000).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
    .eq('id', true)
  if (updateErr) throw new Error(`Failed to persist refreshed QBO token: ${updateErr.message}`)

  return { realmId: row.realm_id, environment: row.environment, accessToken: refreshed.access_token }
}

/** POSTs an entity (SalesReceipt / InventoryAdjustment / Bill / ...) to QBO. */
export async function postQboEntity(
  conn: QboConnection,
  entity: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `${apiBase(conn.environment)}/v3/company/${conn.realmId}/${entity}?minorversion=65`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  if (!res.ok) {
    // Intuit's `Message` is a generic wrapper ("A business validation error
    // has occurred...") for many distinct causes — the actual reason is in
    // `Detail` (and `code`), which the old version of this function dropped,
    // making every failure look identical regardless of cause.
    const apiError = payload?.Fault?.Error?.[0]
    const message = apiError
      ? `${apiError.Message}${apiError.Detail ? ` — ${apiError.Detail}` : ''}${apiError.code ? ` (code ${apiError.code})` : ''}`
      : JSON.stringify(payload)
    throw new Error(`QBO ${entity} create failed: ${message}`)
  }
  return payload
}

/** Runs a QBO SQL-like query (GET /query) and returns the parsed QueryResponse. */
export async function queryQbo(conn: QboConnection, query: string): Promise<Record<string, unknown>> {
  const url = `${apiBase(conn.environment)}/v3/company/${conn.realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${conn.accessToken}`, Accept: 'application/json' },
  })
  const payload = await res.json()
  if (!res.ok) {
    const message = payload?.Fault?.Error?.[0]?.Message || JSON.stringify(payload)
    throw new Error(`QBO query failed: ${message}`)
  }
  return payload
}

/** Finds a Vendor by exact DisplayName, creating one if it doesn't exist yet
 *  (Havelock's purchase orders only carry a free-text supplier name, same
 *  free-text-identity pattern as products). */
export async function findOrCreateVendorRef(
  conn: QboConnection,
  displayName: string,
): Promise<{ value: string; name: string }> {
  const escaped = displayName.replace(/'/g, "\\'")
  const result = await queryQbo(conn, `select Id, DisplayName from Vendor where DisplayName = '${escaped}'`)
  const found = (result as { QueryResponse?: { Vendor?: { Id: string; DisplayName: string }[] } })
    .QueryResponse?.Vendor?.[0]
  if (found) return { value: found.Id, name: found.DisplayName }

  const created = await postQboEntity(conn, 'vendor', { DisplayName: displayName })
  const vendor = (created as { Vendor?: { Id: string; DisplayName: string } }).Vendor
  if (!vendor) throw new Error(`Could not create QBO vendor "${displayName}"`)
  return { value: vendor.Id, name: vendor.DisplayName }
}

/** Finds a Customer by exact DisplayName, creating one if it doesn't exist yet.
 *  Retail POS sales aren't tied to a real customer record, so every bill posts
 *  under one shared "Walk-in Customer" — same free-text-identity pattern as
 *  findOrCreateVendorRef, so no manual QBO customer setup is needed. */
export async function findOrCreateCustomerRef(
  conn: QboConnection,
  displayName: string,
): Promise<{ value: string; name: string }> {
  const escaped = displayName.replace(/'/g, "\\'")
  const result = await queryQbo(conn, `select Id, DisplayName from Customer where DisplayName = '${escaped}'`)
  const found = (result as { QueryResponse?: { Customer?: { Id: string; DisplayName: string }[] } })
    .QueryResponse?.Customer?.[0]
  if (found) return { value: found.Id, name: found.DisplayName }

  const created = await postQboEntity(conn, 'customer', { DisplayName: displayName })
  const customer = (created as { Customer?: { Id: string; DisplayName: string } }).Customer
  if (!customer) throw new Error(`Could not create QBO customer "${displayName}"`)
  return { value: customer.Id, name: customer.DisplayName }
}

/** Looks up the QBO item mapping for a product name; null if unmapped. */
export async function findQboItemRef(
  supabase: SupabaseClient,
  productName: string,
): Promise<{ value: string; name: string } | null> {
  const { data } = await supabase
    .from('havelock_qbo_item_map')
    .select('qbo_item_id, qbo_item_name')
    .eq('product_name', productName)
    .maybeSingle()
  if (!data) return null
  return { value: data.qbo_item_id, name: data.qbo_item_name }
}

export type QboSyncRecordType = 'bill' | 'stock_entry' | 'purchase_order'

export async function logSyncResult(
  supabase: SupabaseClient,
  params: {
    recordType: QboSyncRecordType
    recordId: string
    status: 'success' | 'error'
    qboId?: string
    error?: string
  },
): Promise<void> {
  await supabase.from('havelock_qbo_sync_log').insert({
    record_type: params.recordType,
    record_id: params.recordId,
    status: params.status,
    qbo_id: params.qboId ?? null,
    error: params.error ?? null,
  })
}

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  })
}
