// QuickBooks Online integration, client side.
//
// Connect flow: buildAuthorizeUrl() sends the browser to Intuit's consent
// screen with a random `state` kept in sessionStorage. Intuit redirects back
// to this same app's root URL with `?code=&realmId=&state=`. isOAuthCallback()
// / completeOAuthCallback() detect that and hand the code to the
// `qbo-oauth-callback` edge function (which does the actual token exchange —
// the Client Secret never reaches the browser).
//
// Sync flow: syncBill / syncStockEntry / syncPurchaseOrder call the matching
// qbo-sync-* edge function for one record at a time (manual "Push to
// QuickBooks" buttons in the UI, not automatic — a bad sync should be
// reviewable before it lands in the accounting system).

import { supabase } from './supabase'

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const STATE_KEY = 'qbo_oauth_state'

async function authedFetch(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const { data } = await supabase.auth.getSession()
  const accessToken = data.session?.access_token
  const res = await fetch(`${FUNCTIONS_URL}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error || `Request to ${path} failed`)
  return json
}

function randomState(): string {
  return crypto.randomUUID()
}

/** Redirects the browser to QuickBooks' OAuth consent screen. */
export function redirectToQboConsent(): void {
  const clientId = import.meta.env.VITE_QBO_CLIENT_ID
  const state = randomState()
  sessionStorage.setItem(STATE_KEY, state)
  const redirectUri = `${window.location.origin}/`
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: redirectUri,
    state,
  })
  window.location.href = `https://appcenter.intuit.com/connect/oauth2?${params}`
}

/** True if the current URL looks like an Intuit OAuth redirect back to us. */
export function isOAuthCallback(): boolean {
  const params = new URLSearchParams(window.location.search)
  return params.has('code') && params.has('realmId') && params.has('state')
}

/** Validates `state`, exchanges `code` for tokens via qbo-oauth-callback, then
 *  strips the OAuth query params from the URL. Returns an error message, or
 *  null on success. */
export async function completeOAuthCallback(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const realmId = params.get('realmId')
  const state = params.get('state')
  const expectedState = sessionStorage.getItem(STATE_KEY)
  sessionStorage.removeItem(STATE_KEY)

  const cleanUrl = window.location.pathname
  window.history.replaceState(null, '', cleanUrl)

  if (!code || !realmId || !state) return 'Missing code/realmId/state from QuickBooks redirect.'
  if (!expectedState || state !== expectedState) return 'QuickBooks sign-in state mismatch — please try connecting again.'

  try {
    await authedFetch('qbo-oauth-callback', { code, realmId, redirectUri: `${window.location.origin}/` })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'Could not complete QuickBooks connection.'
  }
}

export interface QboStatus {
  connected: boolean
  realmId?: string
  environment?: 'sandbox' | 'production'
  connectedByEmail?: string | null
  updatedAt?: string
}

export async function getQboStatus(): Promise<QboStatus> {
  return (await authedFetch('qbo-status')) as unknown as QboStatus
}

export interface QboItemOption {
  id: string
  name: string
  type: string
  qtyOnHand: number | null
}

export async function listQboItems(): Promise<QboItemOption[]> {
  const result = await authedFetch('qbo-list-items')
  return (result.items as QboItemOption[]) ?? []
}

export interface QboItemMapRow {
  product_name: string
  qbo_item_id: string
  qbo_item_name: string
}

export async function fetchQboItemMap(): Promise<QboItemMapRow[]> {
  const { data, error } = await supabase.from('havelock_qbo_item_map').select('product_name, qbo_item_id, qbo_item_name')
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function upsertQboItemMap(productName: string, item: QboItemOption): Promise<void> {
  const { error } = await supabase
    .from('havelock_qbo_item_map')
    .upsert({ product_name: productName, qbo_item_id: item.id, qbo_item_name: item.name })
  if (error) throw new Error(error.message)
}

export async function removeQboItemMap(productName: string): Promise<void> {
  const { error } = await supabase.from('havelock_qbo_item_map').delete().eq('product_name', productName)
  if (error) throw new Error(error.message)
}

export type QboSyncRecordType = 'bill' | 'stock_entry' | 'purchase_order'

export interface QboSyncStatus {
  status: 'success' | 'error'
  qboId: string | null
  error: string | null
  createdAt: string
}

/** Latest sync attempt per record id (for status badges next to each row). */
export async function fetchLatestSyncStatuses(
  recordType: QboSyncRecordType,
  recordIds: string[],
): Promise<Record<string, QboSyncStatus>> {
  if (recordIds.length === 0) return {}
  const { data, error } = await supabase
    .from('havelock_qbo_sync_log')
    .select('record_id, status, qbo_id, error, created_at')
    .eq('record_type', recordType)
    .in('record_id', recordIds)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  const byId: Record<string, QboSyncStatus> = {}
  for (const row of data ?? []) {
    // Rows are ascending by time, so the last write per id wins — always the latest.
    byId[row.record_id] = { status: row.status, qboId: row.qbo_id, error: row.error, createdAt: row.created_at }
  }
  return byId
}

interface SyncResult {
  qboId?: string
  alreadySynced?: boolean
  unmappedProducts?: string[]
  error?: string
}

export async function syncBill(billId: string): Promise<SyncResult> {
  return (await authedFetch('qbo-sync-bill', { billId })) as unknown as SyncResult
}

export async function syncStockEntry(stockEntryId: string): Promise<SyncResult> {
  return (await authedFetch('qbo-sync-stock-entry', { stockEntryId })) as unknown as SyncResult
}

export async function syncPurchaseOrder(purchaseOrderId: string): Promise<SyncResult> {
  return (await authedFetch('qbo-sync-purchase-order', { purchaseOrderId })) as unknown as SyncResult
}
