import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { parseHavelockReportPdf } from '../lib/parseHavelockReport'
import type { Bill, ParsedReport } from '../types'

function currentTheme(): string {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function itemsSummary(bill: Bill): string {
  return bill.bill_items
    .map((item) => (item.quantity > 1 ? `${item.quantity} ${item.product_name}` : item.product_name))
    .join(', ')
}

async function saveParsedReport(parsed: ParsedReport, sourceFile: string): Promise<void> {
  for (const bill of parsed.bills) {
    const { data: billRow, error: billError } = await supabase
      .from('bills')
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

    await supabase.from('bill_items').delete().eq('bill_id', billRow.id)
    const { error: itemsError } = await supabase.from('bill_items').insert(
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
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ report: ParsedReport; fileName: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function loadAvailableDates() {
    const { data, error } = await supabase
      .from('bills')
      .select('report_date')
      .order('report_date', { ascending: false })
    if (error) {
      setLoadError(error.message)
      return
    }
    const dates = [...new Set((data ?? []).map((r) => r.report_date as string))]
    setAvailableDates(dates)
    if (dates.length > 0 && !selectedDate) setSelectedDate(dates[0])
    if (dates.length === 0) setLoading(false)
  }

  async function loadBillsForDate(date: string) {
    setLoading(true)
    setLoadError(null)
    const { data, error } = await supabase
      .from('bills')
      .select('*, bill_items(*)')
      .eq('report_date', date)
      .order('bill_time', { ascending: true })
    if (error) setLoadError(error.message)
    else setBills((data ?? []) as Bill[])
    setLoading(false)
  }

  useEffect(() => {
    loadAvailableDates()
  }, [])

  useEffect(() => {
    if (selectedDate) loadBillsForDate(selectedDate)
  }, [selectedDate])

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
      await loadAvailableDates()
      setSelectedDate(preview.report.reportDate)
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

  function dateLabel(iso: string): string {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
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
            <div className="sub">
              {selectedDate ? dateLabel(selectedDate) : 'No reports uploaded yet'}
            </div>
          </div>
          <div className="tools">
            {availableDates.length > 0 && (
              <select
                className="input ctrl"
                style={{ width: 'auto' }}
                value={selectedDate ?? ''}
                onChange={(e) => setSelectedDate(e.target.value)}
              >
                {availableDates.map((d) => (
                  <option key={d} value={d}>
                    {dateLabel(d)}
                  </option>
                ))}
              </select>
            )}
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
            No daily report uploaded yet. Click "Upload daily report PDF" to get started.
          </div>
        ) : (
          <>
            <div className="kpis">
              <div className="kpi">
                <div className="k-lab">Total bills</div>
                <div className="k-val">{bills.length}</div>
                <div className="k-strip"></div>
              </div>
              <div className="kpi">
                <div className="k-lab">Total revenue</div>
                <div className="k-val">{totalRevenue.toLocaleString()}</div>
                <div className="k-sub">LKR net</div>
                <div className="k-strip"></div>
              </div>
              <div className="kpi">
                <div className="k-lab">Avg bill value</div>
                <div className="k-val">{avgBill.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                <div className="k-strip"></div>
              </div>
              <div className="kpi">
                <div className="k-lab">Avg items / bill</div>
                <div className="k-val">{avgItemsPerBill.toFixed(1)}</div>
                <div className="k-strip"></div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginBottom: 16 }}>
              <div className="panel">
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
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
                        <th>Payment method</th>
                        <th>Bills</th>
                        <th>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paymentBreakdown.map(([method, stats]) => (
                        <tr key={method}>
                          <td>{method}</td>
                          <td className="num">{stats.count}</td>
                          <td className="num">{stats.total.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
