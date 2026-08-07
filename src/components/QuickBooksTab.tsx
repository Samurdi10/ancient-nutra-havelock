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
  type QboStatus,
  type QboItemOption,
} from '../lib/qbo'

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
        const [items, map, priceRows] = await Promise.all([
          listQboItems(),
          fetchQboItemMap(),
          supabase.from('havelock_product_prices').select('product_name').order('product_name'),
        ])
        setQboItems(items)
        const mapObj: Record<string, { id: string; name: string }> = {}
        for (const row of map) mapObj[row.product_name] = { id: row.qbo_item_id, name: row.qbo_item_name }
        setItemMap(mapObj)
        setProducts((priceRows.data ?? []).map((r) => r.product_name))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load QuickBooks items.')
      }
    }
    loadMappingData()
  }, [status?.connected])

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
        </>
      )}
    </div>
  )
}
