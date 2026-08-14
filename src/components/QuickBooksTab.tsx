import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  redirectToQboConsent,
  isOAuthCallback,
  completeOAuthCallback,
  getQboStatus,
  listQboItems,
  fetchQboItemMap,
  upsertQboItemMap,
  removeQboItemMap,
  normalizeProductName,
  syncBill,
  type QboStatus,
  type QboItemOption,
} from '../lib/qbo'

interface PushedInvoice {
  billId: string
  reportDate: string
  billTime: string
  invoiceNumber: string
  netTotal: number
  status: 'success' | 'error'
  qboId: string | null
  error: string | null
  createdAt: string
}

export function QuickBooksTab() {
  const [status, setStatus] = useState<QboStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [qboItems, setQboItems] = useState<QboItemOption[]>([])
  const [itemMap, setItemMap] = useState<Record<string, { id: string; name: string }>>({})
  const [products, setProducts] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [autoMapping, setAutoMapping] = useState(false)
  const [autoMapSummary, setAutoMapSummary] = useState<{ mapped: number; remaining: number } | null>(null)
  const [invoices, setInvoices] = useState<PushedInvoice[]>([])
  const [invoicesLoading, setInvoicesLoading] = useState(false)
  const [retryingAll, setRetryingAll] = useState(false)
  const [retryAllSummary, setRetryAllSummary] = useState<{ total: number; success: number } | null>(null)

  async function refreshStatus() {
    setLoading(true)
    setError(null)
    try {
      const s = await getQboStatus()
      setStatus(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load QuickBooks status.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    async function boot() {
      // Run the OAuth exchange first, but don't set its error until after
      // refreshStatus() — refreshStatus() clears `error` at its start, which
      // would otherwise wipe out the real connect failure message before it
      // ever reached the screen.
      const oauthError = isOAuthCallback() ? await completeOAuthCallback() : null
      await refreshStatus()
      if (oauthError) setError(oauthError)
    }
    boot()
  }, [])

  useEffect(() => {
    if (!status?.connected) return
    async function loadMappingData() {
      try {
        const [items, map, priceRows, billItemRows] = await Promise.all([
          listQboItems(),
          fetchQboItemMap(),
          supabase.from('havelock_product_prices').select('product_name'),
          // The QBO push looks up havelock_qbo_item_map by a bill's exact item
          // name, which sometimes differs from the Price List's product name
          // (e.g. "Ashwagandha Extract" vs "Ashwagandha Extract - 60
          // capsules") — without this, those items could never be mapped.
          supabase.from('havelock_bill_items').select('product_name'),
        ])
        setQboItems(items)
        const mapObj: Record<string, { id: string; name: string }> = {}
        for (const row of map) mapObj[row.product_name] = { id: row.qbo_item_id, name: row.qbo_item_name }
        setItemMap(mapObj)
        const allNames = new Set<string>()
        for (const r of priceRows.data ?? []) allNames.add(r.product_name)
        for (const r of billItemRows.data ?? []) allNames.add(r.product_name)
        setProducts([...allNames].sort())
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load QuickBooks items.')
      }
    }
    loadMappingData()
  }, [status?.connected])

  async function loadInvoices() {
    setInvoicesLoading(true)
    try {
      // Sync log rows aren't FK-linked to havelock_bills (record_id is shared
      // across bill/stock_entry/purchase_order types), so this joins them by
      // hand: latest sync attempt per bill, then the matching bill rows.
      const { data: logRows, error: logErr } = await supabase
        .from('havelock_qbo_sync_log')
        .select('record_id, status, qbo_id, error, created_at')
        .eq('record_type', 'bill')
        .order('created_at', { ascending: false })
        .limit(500)
      if (logErr) throw new Error(logErr.message)

      const latestByBillId = new Map<string, (typeof logRows)[number]>()
      for (const row of logRows ?? []) {
        if (!latestByBillId.has(row.record_id)) latestByBillId.set(row.record_id, row)
      }
      const billIds = [...latestByBillId.keys()]
      if (billIds.length === 0) {
        setInvoices([])
        return
      }

      const { data: billRows, error: billErr } = await supabase
        .from('havelock_bills')
        .select('id, report_date, bill_time, invoice_number, net_total')
        .in('id', billIds)
      if (billErr) throw new Error(billErr.message)

      const merged: PushedInvoice[] = (billRows ?? [])
        .map((bill) => {
          const log = latestByBillId.get(bill.id)!
          return {
            billId: bill.id,
            reportDate: bill.report_date,
            billTime: bill.bill_time,
            invoiceNumber: bill.invoice_number,
            netTotal: bill.net_total,
            status: log.status,
            qboId: log.qbo_id,
            error: log.error,
            createdAt: log.created_at,
          }
        })
        .sort((a, b) => (a.reportDate === b.reportDate ? (a.billTime < b.billTime ? 1 : -1) : a.reportDate < b.reportDate ? 1 : -1))
      setInvoices(merged)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load pushed invoices.')
    } finally {
      setInvoicesLoading(false)
    }
  }

  useEffect(() => {
    if (status?.connected) loadInvoices()
  }, [status?.connected])

  /** Re-pushes every currently-failed bill, one at a time — useful after
   *  fixing a systemic issue (e.g. a missing tax code) that made many bills
   *  fail the same way. Sequential (not Promise.all) because QBO's API
   *  throttles a burst of concurrent requests from one connection with a 429
   *  ThrottleExceeded, which firing them all at once reliably triggers. */
  async function handleRetryAllFailed() {
    const failed = invoices.filter((inv) => inv.status === 'error')
    if (failed.length === 0) return
    setRetryingAll(true)
    setRetryAllSummary(null)
    try {
      let success = 0
      for (const inv of failed) {
        try {
          const result = await syncBill(inv.billId)
          if (!result.error) success++
        } catch {
          // leave as failed — reflected in the final summary below
        }
        setRetryAllSummary({ total: failed.length, success })
      }
      await loadInvoices()
    } finally {
      setRetryingAll(false)
    }
  }

  const filteredProducts = useMemo(
    () => products.filter((p) => p.toLowerCase().includes(search.toLowerCase())),
    [products, search],
  )

  async function handleMapChange(productName: string, itemId: string) {
    if (!itemId) {
      await removeQboItemMap(productName)
      setItemMap((prev) => {
        const next = { ...prev }
        delete next[productName]
        return next
      })
      return
    }
    const item = qboItems.find((i) => i.id === itemId)
    if (!item) return
    await upsertQboItemMap(productName, item)
    setItemMap((prev) => ({ ...prev, [productName]: { id: item.id, name: item.name } }))
  }

  /** Maps every still-unmapped product to a QBO item with the same
   *  normalized name, when exactly one such item exists — a same-name
   *  match, not a fuzzy guess, so it never picks a wrong item. Anything
   *  left unmatched (no QBO item with that name, or more than one) stays
   *  for manual mapping. */
  async function handleAutoMap() {
    setAutoMapping(true)
    setAutoMapSummary(null)
    try {
      const byNormalizedName = new Map<string, QboItemOption[]>()
      for (const item of qboItems) {
        const key = normalizeProductName(item.name)
        const list = byNormalizedName.get(key) ?? []
        list.push(item)
        byNormalizedName.set(key, list)
      }

      let mapped = 0
      const newMappings: Record<string, { id: string; name: string }> = {}
      for (const product of products) {
        if (itemMap[product]) continue
        const candidates = byNormalizedName.get(normalizeProductName(product))
        if (!candidates || candidates.length !== 1) continue
        const item = candidates[0]
        await upsertQboItemMap(product, item)
        newMappings[product] = { id: item.id, name: item.name }
        mapped++
      }

      setItemMap((prev) => ({ ...prev, ...newMappings }))
      const remaining = products.filter((p) => !itemMap[p] && !newMappings[p]).length
      setAutoMapSummary({ mapped, remaining })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-mapping failed.')
    } finally {
      setAutoMapping(false)
    }
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1>QuickBooks</h1>
        <div className="sub">Connect QuickBooks Online and map products to QBO items.</div>
      </div>

      {error && <div className="empty">{error}</div>}

      {!status?.connected ? (
        <div>
          <p className="muted">
            Not connected yet. This links Havelock Orders to your QuickBooks Online company so
            sales, physical stock counts, and completed purchase orders can be pushed there —
            QuickBooks then becomes the place stock on hand is tracked.
          </p>
          <button className="btn" onClick={redirectToQboConsent}>
            Connect QuickBooks
          </button>
        </div>
      ) : (
        <>
          <div className="sub">
            Connected to realm <strong>{status.realmId}</strong> ({status.environment})
            {status.connectedByEmail ? ` by ${status.connectedByEmail}` : ''}.{' '}
            <button className="btn sm ghost" onClick={redirectToQboConsent}>
              Reconnect
            </button>
          </div>

          <div>
            <h2 style={{ fontSize: 16 }}>Product → QBO item mapping</h2>
            <p className="muted">
              Only products mapped here get pushed when you click "Push to QuickBooks" — unmapped
              products are skipped and listed as a warning instead of failing the whole sync.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
              <button className="btn sm ghost" onClick={handleAutoMap} disabled={autoMapping}>
                {autoMapping ? 'Auto-mapping…' : 'Auto-map by name'}
              </button>
              {autoMapSummary && (
                <span className="muted" style={{ fontSize: 13 }}>
                  Mapped {autoMapSummary.mapped} product{autoMapSummary.mapped === 1 ? '' : 's'} automatically
                  {autoMapSummary.remaining > 0
                    ? ` — ${autoMapSummary.remaining} still need${autoMapSummary.remaining === 1 ? 's' : ''} manual mapping (no exact name match found in QuickBooks).`
                    : '.'}
                </span>
              )}
            </div>
            <input
              className="input"
              placeholder="Search products…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>QBO item</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((product) => (
                    <tr key={product}>
                      <td className="wrap">{product}</td>
                      <td>
                        <select
                          className="input"
                          value={itemMap[product]?.id ?? ''}
                          onChange={(e) => handleMapChange(product, e.target.value)}
                        >
                          <option value="">— not mapped —</option>
                          {qboItems.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                              {item.qtyOnHand !== null ? ` (qty ${item.qtyOnHand})` : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 16 }}>Invoices pushed to QuickBooks</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                {invoices.some((inv) => inv.status === 'error') && (
                  <button className="btn sm ghost" onClick={handleRetryAllFailed} disabled={retryingAll}>
                    {retryingAll ? 'Retrying…' : 'Retry all failed'}
                  </button>
                )}
                <button className="btn sm ghost" onClick={loadInvoices} disabled={invoicesLoading}>
                  {invoicesLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
            </div>
            <p className="muted">
              Every bill that's been pushed as a Sales Receipt (or attempted), most recent first.
            </p>
            {retryAllSummary && (
              <p className="muted">
                Retried {retryAllSummary.total} bill{retryAllSummary.total === 1 ? '' : 's'} — {retryAllSummary.success} succeeded
                {retryAllSummary.success < retryAllSummary.total ? `, ${retryAllSummary.total - retryAllSummary.success} still failing.` : '.'}
              </p>
            )}
            {invoicesLoading ? (
              <p className="muted">Loading…</p>
            ) : invoices.length === 0 ? (
              <p className="muted">No bills have been pushed yet.</p>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Time</th>
                      <th>Invoice No.</th>
                      <th>Net Total</th>
                      <th>Status</th>
                      <th>QBO Sales Receipt Id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr key={inv.billId}>
                        <td>{inv.reportDate}</td>
                        <td>{inv.billTime}</td>
                        <td>{inv.invoiceNumber}</td>
                        <td className="num">{inv.netTotal.toLocaleString()}</td>
                        <td>
                          {inv.status === 'success' ? (
                            <span style={{ color: 'var(--green)' }}>Synced</span>
                          ) : (
                            <span style={{ color: 'var(--amber)' }} title={inv.error ?? undefined}>
                              Failed{inv.error ? `: ${inv.error}` : ''}
                            </span>
                          )}
                        </td>
                        <td>{inv.qboId ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
