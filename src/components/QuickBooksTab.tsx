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
      if (isOAuthCallback()) {
        const err = await completeOAuthCallback()
        if (err) setError(err)
      }
      await refreshStatus()
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
