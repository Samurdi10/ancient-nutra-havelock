import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { parseHavelockReportPdf } from '../lib/parseHavelockReport'
import type { Bill, ParsedReport } from '../types'

type RangePreset = 'today' | 'yesterday' | 'last7' | 'thismonth' | 'custom'

function currentTheme(): string {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function itemsSummary(bill: Bill): string {
  return bill.bill_items
    .map((item) => (item.quantity > 1 ? `${item.quantity} ${item.product_name}` : item.product_name))
    .join(', ')
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function computeRange(preset: RangePreset, customStart: string, customEnd: string): { start: string; end: string } {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (preset === 'yesterday') {
    const y = new Date(today)
    y.setDate(y.getDate() - 1)
    return { start: isoDate(y), end: isoDate(y) }
  }
  if (preset === 'last7') {
    const start = new Date(today)
    start.setDate(start.getDate() - 6)
    return { start: isoDate(start), end: isoDate(today) }
  }
  if (preset === 'thismonth') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1)
    return { start: isoDate(start), end: isoDate(today) }
  }
  if (preset === 'custom') return { start: customStart, end: customEnd }
  return { start: isoDate(today), end: isoDate(today) } // today
}

/** Parses a "2:40 PM" style time string into a 24-hour hour (0-23). */
function parseHour(billTime: string): number {
  const m = billTime.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i)
  if (!m) return 0
  let h = Number(m[1]) % 12
  if (m[3].toUpperCase() === 'PM') h += 12
  return h
}

function hourLabel(h: number): string {
  const period = h < 12 ? 'a' : 'p'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}${period}`
}

function escapeCsv(value: unknown): string {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(bills: Bill[], fileName: string) {
  const headers = ['Date', 'Time', 'Invoice No', 'Order No', 'Items', 'Net Total', 'Payment Method']
  const rows = bills.map((b) => [
    b.report_date,
    b.bill_time,
    b.invoice_number,
    b.order_number ?? '',
    itemsSummary(b),
    b.net_total,
    b.payment_method ?? '',
  ])
  const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

const PAYMENT_COLORS = ['c-blue', 'c-amber', 'c-green', 'c-teal', 'c-red', 'c-purple']

async function saveParsedReport(parsed: ParsedReport, sourceFile: string): Promise<void> {
  for (const bill of parsed.bills) {
    const { data: billRow, error: billError } = await supabase
      .from('havelock_bills')
      .upsert(
        {
          report_date: parsed.reportDate,
          outlet: bill.outlet,
          bill_time: bill.billTime,
          invoice_number: bill.invoiceNumber,
          order_number: bill.orderNumber,
          net_total: bill.netTotal,
          payment_method: bill.paymentMethod,
          source_file: sourceFile,
        },
        { onConflict: 'invoice_number' },
      )
      .select('id')
      .single()
    if (billError) throw billError

    await supabase.from('havelock_bill_items').delete().eq('bill_id', billRow.id)
    const { error: itemsError } = await supabase.from('havelock_bill_items').insert(
      bill.items.map((item) => ({
        bill_id: billRow.id,
        product_name: item.productName,
        quantity: item.quantity,
        gross_total: item.grossTotal,
        net_total: item.netTotal,
      })),
    )
    if (itemsError) throw itemsError
  }
}

export function HavelockReportPage() {
  const [theme, setTheme] = useState<string>(currentTheme())
  const [rangePreset, setRangePreset] = useState<RangePreset>('today')
  const [customStart, setCustomStart] = useState(() => isoDate(new Date()))
  const [customEnd, setCustomEnd] = useState(() => isoDate(new Date()))
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [topItemsMode, setTopItemsMode] = useState<'qty' | 'revenue'>('qty')

  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ report: ParsedReport; fileName: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const range = useMemo(() => computeRange(rangePreset, customStart, customEnd), [rangePreset, customStart, customEnd])

  async function loadBillsForRange(start: string, end: string) {
    setLoading(true)
    setLoadError(null)
    const { data, error } = await supabase
      .from('havelock_bills')
      .select('*, bill_items:havelock_bill_items(*)')
      .gte('report_date', start)
      .lte('report_date', end)
      .order('report_date', { ascending: true })
      .order('bill_time', { ascending: true })
    if (error) setLoadError(error.message)
    else setBills((data ?? []) as Bill[])
    setLoading(false)
  }

  useEffect(() => {
    loadBillsForRange(range.start, range.end)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end])

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.theme = next
    } catch {
      // localStorage may be unavailable; the toggle still applies for this session.
    }
    setTheme(next)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  async function handleFileChosen(file: File) {
    setParsing(true)
    setParseError(null)
    setPreview(null)
    try {
      const report = await parseHavelockReportPdf(file)
      if (report.bills.length === 0) {
        setParseError('No bills were found in this PDF. Make sure it is a Bill Wise Report export.')
      } else {
        setPreview({ report, fileName: file.name })
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to read this PDF.')
    } finally {
      setParsing(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleConfirmSave() {
    if (!preview) return
    setSaving(true)
    try {
      await saveParsedReport(preview.report, preview.fileName)
      setPreview(null)
      setRangePreset('custom')
      setCustomStart(preview.report.reportDate)
      setCustomEnd(preview.report.reportDate)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to save this report.')
    } finally {
      setSaving(false)
    }
  }

  const totalRevenue = useMemo(() => bills.reduce((s, b) => s + b.net_total, 0), [bills])
  const totalItemsQty = useMemo(
    () => bills.reduce((s, b) => s + b.bill_items.reduce((si, it) => si + it.quantity, 0), 0),
    [bills],
  )
  const avgBill = bills.length > 0 ? totalRevenue / bills.length : 0
  const avgItemsPerBill = bills.length > 0 ? totalItemsQty / bills.length : 0

  const paymentBreakdown = useMemo(() => {
    const byMethod = new Map<string, { count: number; total: number }>()
    for (const bill of bills) {
      const method = bill.payment_method ?? 'Unknown'
      const entry = byMethod.get(method) ?? { count: 0, total: 0 }
      entry.count += 1
      entry.total += bill.net_total
      byMethod.set(method, entry)
    }
    return [...byMethod.entries()].sort((a, b) => b[1].total - a[1].total)
  }, [bills])

  const productBreakdown = useMemo(() => {
    const byProduct = new Map<string, { quantity: number; revenue: number }>()
    for (const bill of bills) {
      for (const item of bill.bill_items) {
        const entry = byProduct.get(item.product_name) ?? { quantity: 0, revenue: 0 }
        entry.quantity += item.quantity
        entry.revenue += item.net_total
        byProduct.set(item.product_name, entry)
      }
    }
    return [...byProduct.entries()].sort((a, b) => b[1].quantity - a[1].quantity)
  }, [bills])

  const topItems = useMemo(() => {
    const sorted = [...productBreakdown].sort((a, b) =>
      topItemsMode === 'qty' ? b[1].quantity - a[1].quantity : b[1].revenue - a[1].revenue,
    )
    return sorted.slice(0, 8)
  }, [productBreakdown, topItemsMode])

  const topItemsMax = useMemo(
    () => Math.max(1, ...topItems.map(([, stats]) => (topItemsMode === 'qty' ? stats.quantity : stats.revenue))),
    [topItems, topItemsMode],
  )

  const hourlySales = useMemo(() => {
    const byHour = new Array(24).fill(0) as number[]
    for (const b of bills) byHour[parseHour(b.bill_time)] += b.net_total
    return byHour
  }, [bills])
  const hourlyMax = Math.max(1, ...hourlySales)

  function dateLabel(iso: string): string {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  function rangeLabel(): string {
    if (range.start === range.end) return dateLabel(range.start)
    return `${dateLabel(range.start)} – ${dateLabel(range.end)}`
  }

  function handleDownload() {
    downloadCsv(bills, `havelock-bills-${range.start}_to_${range.end}.csv`)
  }

  return (
    <div className="app">
      <aside className="rail">
        <div className="r-logo">
          <div className="r-brand">HAVELOCK</div>
          <div className="r-sub">Ancient Nutra · Daily Report</div>
        </div>
        <div className="r-sec">Reports</div>
        <button className="nav active">Daily Report</button>
        <div className="r-foot">
          <div className="r-av">AN</div>
          <div>
            <div className="r-uname">Havelock City Mall</div>
            <div className="r-urole">Outlet</div>
          </div>
          <button
            className="r-theme"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            ◑
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <h1>Daily Bill Report</h1>
            <div className="sub">{rangeLabel()}</div>
          </div>
          <div className="tools">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFileChosen(file)
              }}
            />
            <button className="btn ghost" onClick={handleDownload} disabled={bills.length === 0}>
              Download
            </button>
            <button
              className="btn pri"
              onClick={() => fileInputRef.current?.click()}
              disabled={parsing}
            >
              {parsing ? 'Reading PDF…' : '+ Upload daily report PDF'}
            </button>
            <button className="btn ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </div>

        <div className="range-tabs">
          <button
            className={`btn sm ${rangePreset === 'today' ? 'pri' : 'ghost'}`}
            onClick={() => setRangePreset('today')}
          >
            📅 Today
          </button>
          <button
            className={`btn sm ${rangePreset === 'yesterday' ? 'pri' : 'ghost'}`}
            onClick={() => setRangePreset('yesterday')}
          >
            📅 Yesterday
          </button>
          <button
            className={`btn sm ${rangePreset === 'last7' ? 'pri' : 'ghost'}`}
            onClick={() => setRangePreset('last7')}
          >
            📅 Last 07 Days
          </button>
          <button
            className={`btn sm ${rangePreset === 'thismonth' ? 'pri' : 'ghost'}`}
            onClick={() => setRangePreset('thismonth')}
          >
            📅 This Month
          </button>
          <button
            className={`btn sm ${rangePreset === 'custom' ? 'pri' : 'ghost'}`}
            onClick={() => setRangePreset('custom')}
          >
            📅 Custom
          </button>
          {rangePreset === 'custom' && (
            <div className="range-custom">
              <input
                className="input"
                type="date"
                value={customStart}
                max={customEnd}
                onChange={(e) => setCustomStart(e.target.value)}
              />
              <span className="muted" style={{ padding: 0 }}>
                to
              </span>
              <input
                className="input"
                type="date"
                value={customEnd}
                min={customStart}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </div>
          )}
        </div>

        {parseError && <p className="error">{parseError}</p>}
        {loadError && <p className="error">{loadError}</p>}

        {preview && (
          <div className="modal-backdrop">
            <div className="modal-card">
              <h2>Review before saving — {dateLabel(preview.report.reportDate)}</h2>
              <p className="subtitle">
                Parsed {preview.report.bills.length} bill
                {preview.report.bills.length === 1 ? '' : 's'} from {preview.fileName}.
                {preview.report.stated.totalBill !== null &&
                  ` PDF states Total Bill: ${preview.report.stated.totalBill}.`}
              </p>
              {preview.report.warnings.length > 0 && (
                <div className="panel" style={{ padding: 14, borderColor: 'var(--amber)' }}>
                  {preview.report.warnings.map((w, i) => (
                    <p key={i} className="error" style={{ color: 'var(--amber)', margin: '4px 0' }}>
                      ⚠ {w}
                    </p>
                  ))}
                </div>
              )}
              <div className="panel">
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Invoice No.</th>
                        <th>Items</th>
                        <th>Net Total</th>
                        <th>Payment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.report.bills.map((bill) => (
                        <tr key={bill.invoiceNumber}>
                          <td>{bill.billTime}</td>
                          <td>{bill.invoiceNumber}</td>
                          <td className="wrap">
                            {bill.items
                              .map((it) => (it.quantity > 1 ? `${it.quantity} ${it.productName}` : it.productName))
                              .join(', ')}
                          </td>
                          <td className="num">{bill.netTotal.toLocaleString()}</td>
                          <td>{bill.paymentMethod}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setPreview(null)} disabled={saving}>
                  Cancel
                </button>
                <button className="btn pri" onClick={handleConfirmSave} disabled={saving}>
                  {saving ? 'Saving…' : `Save ${preview.report.bills.length} bills`}
                </button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <p className="muted">Loading…</p>
        ) : bills.length === 0 ? (
          <div className="empty">
            <div className="e-icon">🧾</div>
            No bills in this range yet. Click "Upload daily report PDF" to get started.
          </div>
        ) : (
          <>
            <div className="stat-cards">
              <div className="stat-card c-amber">
                <div className="s-top">
                  <div className="s-lab">Revenue</div>
                  <div className="s-ic">💰</div>
                </div>
                <div className="s-val">LKR {totalRevenue.toLocaleString()}</div>
                <div className="s-sub">Total bills - {bills.length}</div>
              </div>
              <div className="stat-card c-blue">
                <div className="s-top">
                  <div className="s-lab">Total Bills</div>
                  <div className="s-ic">🧾</div>
                </div>
                <div className="s-val">{bills.length}</div>
                <div className="s-sub">{totalItemsQty} items sold</div>
              </div>
              <div className="stat-card c-green">
                <div className="s-top">
                  <div className="s-lab">Avg Invoice</div>
                  <div className="s-ic">✅</div>
                </div>
                <div className="s-val">
                  LKR {avgBill.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
                <div className="s-sub">per bill</div>
              </div>
              <div className="stat-card c-teal">
                <div className="s-top">
                  <div className="s-lab">Avg Items</div>
                  <div className="s-ic">📦</div>
                </div>
                <div className="s-val">{avgItemsPerBill.toFixed(1)}</div>
                <div className="s-sub">per bill</div>
              </div>
            </div>

            <div className="stat-cards">
              {paymentBreakdown.map(([method, stats], i) => (
                <div key={method} className={`stat-card sm ${PAYMENT_COLORS[i % PAYMENT_COLORS.length]}`}>
                  <div className="s-top">
                    <div className="s-lab">{method}</div>
                    <div className="s-ic">💳</div>
                  </div>
                  <div className="s-val">LKR {stats.total.toLocaleString()}</div>
                  <div className="s-sub">
                    {stats.count} bill{stats.count === 1 ? '' : 's'}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div className="panel">
                <div className="panel-head">
                  <h3>🛒 Top Selling Items</h3>
                  <div className="toggle-pair">
                    <button
                      className={topItemsMode === 'qty' ? 'active' : ''}
                      onClick={() => setTopItemsMode('qty')}
                    >
                      Qty
                    </button>
                    <button
                      className={topItemsMode === 'revenue' ? 'active' : ''}
                      onClick={() => setTopItemsMode('revenue')}
                    >
                      Revenue
                    </button>
                  </div>
                </div>
                <div className="panel-body">
                  <div className="bar-list">
                    {topItems.map(([name, stats]) => {
                      const value = topItemsMode === 'qty' ? stats.quantity : stats.revenue
                      const widthPct = (value / topItemsMax) * 100
                      return (
                        <div key={name} className="bar-row">
                          <span className="b-name" title={name}>
                            {name}
                          </span>
                          <div className="b-track">
                            <div className="b-fill" style={{ width: `${widthPct}%` }} />
                          </div>
                          <span className="b-val">
                            {topItemsMode === 'qty' ? value : `LKR ${value.toLocaleString()}`}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h3>🕐 Hourly Sales</h3>
                </div>
                <div className="panel-body">
                  <div className="hourly-chart">
                    {hourlySales.map((value, hour) => (
                      <div key={hour} className="h-col" title={`${hourLabel(hour)}: LKR ${value.toLocaleString()}`}>
                        <div className="h-bar" style={{ height: `${(value / hourlyMax) * 100}%` }} />
                        <span className="h-lab">{hourLabel(hour)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Time</th>
                      <th>Invoice No.</th>
                      <th>Order No.</th>
                      <th>Items</th>
                      <th>Net Total</th>
                      <th>Payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bills.map((bill) => (
                      <tr key={bill.id}>
                        <td>{bill.report_date}</td>
                        <td>{bill.bill_time}</td>
                        <td>{bill.invoice_number}</td>
                        <td>{bill.order_number}</td>
                        <td className="wrap">{itemsSummary(bill)}</td>
                        <td className="num">{bill.net_total.toLocaleString()}</td>
                        <td>{bill.payment_method}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel">
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Qty sold</th>
                      <th>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productBreakdown.map(([name, stats]) => (
                      <tr key={name}>
                        <td className="wrap">{name}</td>
                        <td className="num">{stats.quantity}</td>
                        <td className="num">{stats.revenue.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
