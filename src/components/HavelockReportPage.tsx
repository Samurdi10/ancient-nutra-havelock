import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { parseHavelockReportPdf } from '../lib/parseHavelockReport'
import { QuickBooksTab } from './QuickBooksTab'
import { QboPushButton } from './QboPushButton'
import { isOAuthCallback, syncBill } from '../lib/qbo'
import type {
  Bill,
  ParsedReport,
  StockEntry,
  StockEntryItem,
  PurchaseOrder,
  AttendanceLog,
  AuditLogEntry,
} from '../types'

const AUDIT_VIEWER_EMAILS = ['info@silkrouteventures.com', 'marketing@esilkroute.com.lk']

/** Best-effort audit log write — an audit-log failure should never block the
 *  actual price/stock change it's describing. */
async function logAudit(
  entityType: 'product_price' | 'stock_entry' | 'attendance',
  action: 'created' | 'updated' | 'deleted',
  summary: string,
  details: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('havelock_audit_log').insert({ entity_type: entityType, action, summary, details })
  if (error) console.warn('audit log:', error.message)
}

type RangePreset = 'today' | 'yesterday' | 'last7' | 'thismonth' | 'month' | 'custom'

function currentTheme(): string {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** One line per item, each carrying its own price — e.g. "2 Ashwagandha - 60 capsules — LKR 4,500". */
function itemLines(bill: Bill): string[] {
  return bill.bill_items.map((item) => {
    const name = item.quantity > 1 ? `${item.quantity} ${item.product_name}` : item.product_name
    return `${name} — LKR ${item.net_total.toLocaleString()}`
  })
}

/** Formats a Date as "yyyy-mm-dd" using its LOCAL calendar date — not
 *  toISOString(), which converts to UTC first and silently shifts the date
 *  by a day in timezones ahead of UTC (e.g. midnight July 1 in Sri Lanka,
 *  UTC+5:30, is still June 30 in UTC). */
function isoDate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Loosely normalizes a product name for matching POS names against the website's — collapses whitespace/case/punctuation differences, not a fuzzy/NLP match. */
function normalizeProductName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function computeRange(
  preset: RangePreset,
  customStart: string,
  customEnd: string,
  selectedMonth: string,
): { start: string; end: string } {
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
  if (preset === 'month') {
    const [y, m] = selectedMonth.split('-').map(Number)
    const start = new Date(y, m - 1, 1)
    const end = new Date(y, m, 0) // day 0 of next month = last day of this month
    return { start: isoDate(start), end: isoDate(end) }
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

function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function formatDuration(timeIn: string, timeOut: string | null): string {
  if (!timeOut) return 'In progress'
  const ms = new Date(timeOut).getTime() - new Date(timeIn).getTime()
  const totalMinutes = Math.max(0, Math.round(ms / 60000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${minutes}m`
}

/** Converts an ISO timestamp to the local "yyyy-MM-ddTHH:mm" a
 *  datetime-local input needs, using LOCAL time components (not
 *  toISOString(), which would shift the wall-clock time to UTC). */
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function downloadCsv(bills: Bill[], fileName: string) {
  const headers = ['Date', 'Time', 'Invoice No', 'Order No', 'Items', 'Net Total', 'Payment Method']
  const rows = bills.map((b) => [
    b.report_date,
    b.bill_time,
    b.invoice_number,
    b.order_number ?? '',
    itemLines(b).join('\n'),
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

async function saveParsedReport(parsed: ParsedReport, sourceFile: string): Promise<string[]> {
  const billIds: string[] = []
  for (const bill of parsed.bills) {
    const { data: billRow, error: billError } = await supabase
      .from('havelock_bills')
      .upsert(
        {
          report_date: bill.date,
          outlet: bill.outlet,
          bill_time: bill.billTime,
          invoice_number: bill.invoiceNumber,
          order_number: bill.orderNumber,
          net_total: bill.netTotal,
          payment_method: bill.paymentMethod,
          source_file: sourceFile,
        },
        { onConflict: 'report_date,invoice_number' },
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
    billIds.push(billRow.id)
  }
  return billIds
}

interface PriceRow {
  product_name: string
  price: number
  compare_at_price: number | null
}

interface DraftStockItem {
  productName: string
  quantity: number
  rate: number
  manufacturingDate: string | null
  expiryDate: string | null
}

interface DraftPoItem {
  itemCode: string | null
  productName: string
  rate: number
  quantity: number
  unit: string
  discountValue: number
  taxAmount: number
  taxCombination: string
}

function computePoItemTotals(item: DraftPoItem): { netTotal: number; total: number } {
  const netTotal = item.rate * item.quantity
  const total = netTotal - item.discountValue + item.taxAmount
  return { netTotal, total }
}

export function HavelockReportPage({ userEmail }: { userEmail: string | null }) {
  const canViewAudit = !!userEmail && AUDIT_VIEWER_EMAILS.includes(userEmail.toLowerCase())
  const [theme, setTheme] = useState<string>(currentTheme())
  const [activeSection, setActiveSection] = useState<
    'report' | 'prices' | 'stock' | 'po' | 'attendance' | 'qbo' | 'audit'
  >(isOAuthCallback() ? 'qbo' : 'report')
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [priceRows, setPriceRows] = useState<PriceRow[]>([])
  const [priceSearch, setPriceSearch] = useState('')
  const [priceError, setPriceError] = useState<string | null>(null)
  const [editingPriceProduct, setEditingPriceProduct] = useState<string | null>(null)
  const [editPriceValue, setEditPriceValue] = useState('')
  const [editCompareAtValue, setEditCompareAtValue] = useState('')
  const [showAddProduct, setShowAddProduct] = useState(false)
  const [newProductName, setNewProductName] = useState('')
  const [newProductPrice, setNewProductPrice] = useState('')
  const [newProductCompareAt, setNewProductCompareAt] = useState('')
  const [stockEntries, setStockEntries] = useState<StockEntry[]>([])
  const [stockLoading, setStockLoading] = useState(true)
  const [stockError, setStockError] = useState<string | null>(null)
  const [showStockForm, setShowStockForm] = useState(false)
  const [savingStockEntry, setSavingStockEntry] = useState(false)
  const [stockEntryDate, setStockEntryDate] = useState(() => isoDate(new Date()))
  const [stockRefDocNo, setStockRefDocNo] = useState('')
  const [stockRemarks, setStockRemarks] = useState('')
  const [stockItemSearch, setStockItemSearch] = useState('')
  const [draftStockItems, setDraftStockItems] = useState<DraftStockItem[]>([])
  const [expandedStockEntryId, setExpandedStockEntryId] = useState<string | null>(null)
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [poLoading, setPoLoading] = useState(true)
  const [poError, setPoError] = useState<string | null>(null)
  const [showPoForm, setShowPoForm] = useState(false)
  const [savingPo, setSavingPo] = useState(false)
  const [poDate, setPoDate] = useState(() => isoDate(new Date()))
  const [poRefDocNo, setPoRefDocNo] = useState('')
  const [poFromLocation, setPoFromLocation] = useState('Ancient Nutra - Havelock City Mall')
  const [poToLocation, setPoToLocation] = useState('Ancient Nutra - Havelock City Mall')
  const [poSupplierName, setPoSupplierName] = useState('')
  const [poSupplierRegNo, setPoSupplierRegNo] = useState('')
  const [poRemarks, setPoRemarks] = useState('')
  const [poItemSearch, setPoItemSearch] = useState('')
  const [draftPoItems, setDraftPoItems] = useState<DraftPoItem[]>([])
  const [attendanceLogs, setAttendanceLogs] = useState<AttendanceLog[]>([])
  const [attendanceLoading, setAttendanceLoading] = useState(true)
  const [attendanceError, setAttendanceError] = useState<string | null>(null)
  const [clockInName, setClockInName] = useState('')
  const [clockInPlace, setClockInPlace] = useState('Havelock City Mall')
  const [editingAttendanceId, setEditingAttendanceId] = useState<string | null>(null)
  const [editTimeInValue, setEditTimeInValue] = useState('')
  const [editTimeOutValue, setEditTimeOutValue] = useState('')
  const [rangePreset, setRangePreset] = useState<RangePreset>('today')
  const [customStart, setCustomStart] = useState(() => isoDate(new Date()))
  const [customEnd, setCustomEnd] = useState(() => isoDate(new Date()))
  const [selectedMonth, setSelectedMonth] = useState(() => isoDate(new Date()).slice(0, 7))
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [topItemsMode, setTopItemsMode] = useState<'qty' | 'revenue'>('qty')
  const [productPrices, setProductPrices] = useState<Map<string, number>>(new Map())

  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ report: ParsedReport; fileName: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [qboPushResult, setQboPushResult] = useState<{ total: number; success: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const range = useMemo(
    () => computeRange(rangePreset, customStart, customEnd, selectedMonth),
    [rangePreset, customStart, customEnd, selectedMonth],
  )

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

  async function loadPrices() {
    const { data } = await supabase
      .from('havelock_product_prices')
      .select('product_name, price, compare_at_price')
      .order('product_name', { ascending: true })
    const rows = (data ?? []) as PriceRow[]
    const map = new Map<string, number>()
    for (const row of rows) map.set(normalizeProductName(row.product_name), row.price)
    setProductPrices(map)
    setPriceRows(rows)
  }

  useEffect(() => {
    loadPrices()
  }, [])

  const filteredPriceRows = useMemo(() => {
    const q = priceSearch.trim().toLowerCase()
    if (!q) return priceRows
    return priceRows.filter((r) => r.product_name.toLowerCase().includes(q))
  }, [priceRows, priceSearch])

  function startEditPrice(row: PriceRow) {
    setEditingPriceProduct(row.product_name)
    setEditPriceValue(String(row.price))
    setEditCompareAtValue(row.compare_at_price !== null ? String(row.compare_at_price) : '')
  }

  function cancelEditPrice() {
    setEditingPriceProduct(null)
  }

  async function saveEditPrice() {
    if (!editingPriceProduct) return
    setPriceError(null)
    const price = Number(editPriceValue)
    const compareAtPrice = editCompareAtValue.trim() ? Number(editCompareAtValue) : null
    const oldRow = priceRows.find((r) => r.product_name === editingPriceProduct)
    const { error } = await supabase
      .from('havelock_product_prices')
      .update({ price, compare_at_price: compareAtPrice })
      .eq('product_name', editingPriceProduct)
    if (error) {
      setPriceError(error.message)
      return
    }
    await logAudit('product_price', 'updated', `Changed price of "${editingPriceProduct}" from LKR ${oldRow?.price ?? '?'} to LKR ${price}`, {
      product_name: editingPriceProduct,
      old_price: oldRow?.price ?? null,
      new_price: price,
      old_compare_at_price: oldRow?.compare_at_price ?? null,
      new_compare_at_price: compareAtPrice,
    })
    setEditingPriceProduct(null)
    await loadPrices()
  }

  async function handleAddProduct() {
    if (!newProductName.trim() || !newProductPrice.trim()) return
    setPriceError(null)
    const price = Number(newProductPrice)
    const compareAtPrice = newProductCompareAt.trim() ? Number(newProductCompareAt) : null
    const { error } = await supabase.from('havelock_product_prices').insert({
      product_name: newProductName.trim(),
      price,
      compare_at_price: compareAtPrice,
    })
    if (error) {
      setPriceError(error.message)
      return
    }
    await logAudit('product_price', 'created', `Added product "${newProductName.trim()}" at LKR ${price}`, {
      product_name: newProductName.trim(),
      price,
      compare_at_price: compareAtPrice,
    })
    setShowAddProduct(false)
    setNewProductName('')
    setNewProductPrice('')
    setNewProductCompareAt('')
    await loadPrices()
  }

  const currentStockByProduct = useMemo(() => {
    const map = new Map<string, number>()
    // stockEntries is sorted most-recent-first, so the first entry seen per
    // product is its latest recorded physical count.
    for (const entry of stockEntries) {
      for (const item of entry.stock_entry_items) {
        if (!map.has(item.product_name)) map.set(item.product_name, item.quantity)
      }
    }
    return map
  }, [stockEntries])

  async function loadStockEntries() {
    setStockLoading(true)
    setStockError(null)
    const { data, error } = await supabase
      .from('havelock_stock_entries')
      .select('*, stock_entry_items:havelock_stock_entry_items(*)')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) setStockError(error.message)
    else setStockEntries((data ?? []) as StockEntry[])
    setStockLoading(false)
  }

  useEffect(() => {
    loadStockEntries()
  }, [])

  async function loadAuditLogs() {
    setAuditLoading(true)
    setAuditError(null)
    const { data, error } = await supabase
      .from('havelock_audit_log')
      .select('id, entity_type, action, summary, details, changed_by_email, created_at')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) setAuditError(error.message)
    else setAuditLogs((data ?? []) as AuditLogEntry[])
    setAuditLoading(false)
  }

  useEffect(() => {
    if (canViewAudit) loadAuditLogs()
  }, [canViewAudit])

  const stockItemMatches = useMemo(() => {
    const q = stockItemSearch.trim().toLowerCase()
    if (!q) return []
    return priceRows.filter((r) => r.product_name.toLowerCase().includes(q)).slice(0, 8)
  }, [priceRows, stockItemSearch])

  function addDraftStockItem(row: PriceRow) {
    setDraftStockItems((prev) => {
      if (prev.some((it) => it.productName === row.product_name)) return prev
      return [
        ...prev,
        { productName: row.product_name, quantity: 1, rate: row.price, manufacturingDate: null, expiryDate: null },
      ]
    })
    setStockItemSearch('')
  }

  function updateDraftStockItem(index: number, patch: Partial<DraftStockItem>) {
    setDraftStockItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }

  function removeDraftStockItem(index: number) {
    setDraftStockItems((prev) => prev.filter((_, i) => i !== index))
  }

  function resetStockForm() {
    setStockEntryDate(isoDate(new Date()))
    setStockRefDocNo('')
    setStockRemarks('')
    setStockItemSearch('')
    setDraftStockItems([])
  }

  async function handleConfirmStockEntry() {
    if (draftStockItems.length === 0) return
    setSavingStockEntry(true)
    setStockError(null)
    try {
      const total = draftStockItems.reduce((s, it) => s + it.quantity * it.rate, 0)
      const { data: entryRow, error: entryError } = await supabase
        .from('havelock_stock_entries')
        .insert({
          entry_date: stockEntryDate,
          ref_doc_no: stockRefDocNo || null,
          remarks: stockRemarks || null,
          total,
        })
        .select('id, entry_no')
        .single()
      if (entryError) throw entryError

      const { error: itemsError } = await supabase.from('havelock_stock_entry_items').insert(
        draftStockItems.map((it) => ({
          entry_id: entryRow.id,
          product_name: it.productName,
          quantity: it.quantity,
          rate: it.rate,
          total: it.quantity * it.rate,
          manufacturing_date: it.manufacturingDate,
          expiry_date: it.expiryDate,
        })),
      )
      if (itemsError) throw itemsError

      await logAudit('stock_entry', 'created', `Created stock entry ${entryRow.entry_no} (${stockEntryDate}, ${draftStockItems.length} items, LKR ${total.toLocaleString()})`, {
        entry_no: entryRow.entry_no,
        entry_date: stockEntryDate,
        ref_doc_no: stockRefDocNo || null,
        total,
        items: draftStockItems,
      })

      setShowStockForm(false)
      resetStockForm()
      await loadStockEntries()
    } catch (err) {
      setStockError(err instanceof Error ? err.message : 'Failed to save this stock entry.')
    } finally {
      setSavingStockEntry(false)
    }
  }

  async function handleDeleteStockEntry(id: string) {
    const entry = stockEntries.find((e) => e.id === id)
    if (entry) {
      await logAudit(
        'stock_entry',
        'deleted',
        `Deleted stock entry ${entry.entry_no} (${entry.entry_date}, ${entry.stock_entry_items.length} items, LKR ${entry.total.toLocaleString()})`,
        {
          entry_no: entry.entry_no,
          entry_date: entry.entry_date,
          total: entry.total,
          items: entry.stock_entry_items,
        },
      )
    }
    await supabase.from('havelock_stock_entries').delete().eq('id', id)
    loadStockEntries()
  }

  function updateStockItemLocal(entryId: string, itemId: string, patch: Partial<StockEntryItem>) {
    setStockEntries((prev) =>
      prev.map((entry) =>
        entry.id !== entryId
          ? entry
          : {
              ...entry,
              stock_entry_items: entry.stock_entry_items.map((it) =>
                it.id === itemId ? { ...it, ...patch } : it,
              ),
            },
      ),
    )
  }

  async function saveStockItemEdit(entryId: string, itemId: string) {
    const entry = stockEntries.find((e) => e.id === entryId)
    const item = entry?.stock_entry_items.find((it) => it.id === itemId)
    if (!entry || !item) return
    const total = item.quantity * item.rate
    const { error } = await supabase
      .from('havelock_stock_entry_items')
      .update({ quantity: item.quantity, expiry_date: item.expiry_date, total })
      .eq('id', itemId)
    if (error) {
      setStockError(error.message)
      return
    }
    const entryTotal = entry.stock_entry_items.reduce((s, it) => s + (it.id === itemId ? total : it.total), 0)
    const { error: entryError } = await supabase
      .from('havelock_stock_entries')
      .update({ total: entryTotal })
      .eq('id', entryId)
    if (entryError) {
      setStockError(entryError.message)
      return
    }
    setStockEntries((prev) =>
      prev.map((e) =>
        e.id !== entryId
          ? e
          : {
              ...e,
              total: entryTotal,
              stock_entry_items: e.stock_entry_items.map((it) => (it.id === itemId ? { ...it, total } : it)),
            },
      ),
    )
  }

  async function loadPurchaseOrders() {
    setPoLoading(true)
    setPoError(null)
    const { data, error } = await supabase
      .from('havelock_purchase_orders')
      .select('*, purchase_order_items:havelock_purchase_order_items(*)')
      .order('po_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) setPoError(error.message)
    else setPurchaseOrders((data ?? []) as PurchaseOrder[])
    setPoLoading(false)
  }

  useEffect(() => {
    loadPurchaseOrders()
  }, [])

  const poItemMatches = useMemo(() => {
    const q = poItemSearch.trim().toLowerCase()
    if (!q) return []
    return priceRows.filter((r) => r.product_name.toLowerCase().includes(q)).slice(0, 8)
  }, [priceRows, poItemSearch])

  function addDraftPoItem(row: PriceRow) {
    setDraftPoItems((prev) => {
      if (prev.some((it) => it.productName === row.product_name)) return prev
      return [
        ...prev,
        {
          itemCode: null,
          productName: row.product_name,
          rate: 0,
          quantity: 1,
          unit: 'Numbers',
          discountValue: 0,
          taxAmount: 0,
          taxCombination: 'VAT',
        },
      ]
    })
    setPoItemSearch('')
  }

  function updateDraftPoItem(index: number, patch: Partial<DraftPoItem>) {
    setDraftPoItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }

  function removeDraftPoItem(index: number) {
    setDraftPoItems((prev) => prev.filter((_, i) => i !== index))
  }

  function resetPoForm() {
    setPoDate(isoDate(new Date()))
    setPoRefDocNo('')
    setPoFromLocation('Ancient Nutra - Havelock City Mall')
    setPoToLocation('Ancient Nutra - Havelock City Mall')
    setPoSupplierName('')
    setPoSupplierRegNo('')
    setPoRemarks('')
    setPoItemSearch('')
    setDraftPoItems([])
  }

  async function handleConfirmPo() {
    if (draftPoItems.length === 0) return
    setSavingPo(true)
    setPoError(null)
    try {
      const totals = draftPoItems.map(computePoItemTotals)
      const netTotal = totals.reduce((s, t) => s + t.netTotal, 0)
      const totalDiscount = draftPoItems.reduce((s, it) => s + it.discountValue, 0)
      const totalTax = draftPoItems.reduce((s, it) => s + it.taxAmount, 0)
      const total = totals.reduce((s, t) => s + t.total, 0)

      const { data: poRow, error: poInsertError } = await supabase
        .from('havelock_purchase_orders')
        .insert({
          po_date: poDate,
          ref_doc_no: poRefDocNo || null,
          from_location: poFromLocation,
          to_location: poToLocation,
          supplier_name: poSupplierName || null,
          supplier_reg_no: poSupplierRegNo || null,
          remarks: poRemarks || null,
          net_total: netTotal,
          total_discount: totalDiscount,
          total_tax: totalTax,
          total,
        })
        .select('id')
        .single()
      if (poInsertError) throw poInsertError

      const { error: itemsError } = await supabase.from('havelock_purchase_order_items').insert(
        draftPoItems.map((it, i) => ({
          po_id: poRow.id,
          item_code: it.itemCode,
          product_name: it.productName,
          rate: it.rate,
          quantity: it.quantity,
          unit: it.unit,
          net_total: totals[i].netTotal,
          discount_value: it.discountValue,
          tax_amount: it.taxAmount,
          tax_combination: it.taxCombination,
          total: totals[i].total,
        })),
      )
      if (itemsError) throw itemsError

      setShowPoForm(false)
      resetPoForm()
      await loadPurchaseOrders()
    } catch (err) {
      setPoError(err instanceof Error ? err.message : 'Failed to save this purchase order.')
    } finally {
      setSavingPo(false)
    }
  }

  async function handleDeletePo(id: string) {
    await supabase.from('havelock_purchase_orders').delete().eq('id', id)
    loadPurchaseOrders()
  }

  async function handleUpdatePoStatus(id: string, status: PurchaseOrder['status']) {
    await supabase.from('havelock_purchase_orders').update({ status }).eq('id', id)
    loadPurchaseOrders()
  }

  async function loadAttendanceLogs() {
    setAttendanceLoading(true)
    setAttendanceError(null)
    const { data, error } = await supabase
      .from('havelock_attendance_logs')
      .select('*')
      .order('time_in', { ascending: false })
    if (error) setAttendanceError(error.message)
    else setAttendanceLogs((data ?? []) as AttendanceLog[])
    setAttendanceLoading(false)
  }

  useEffect(() => {
    loadAttendanceLogs()
  }, [])

  async function handleClockIn() {
    if (!clockInName.trim()) return
    setAttendanceError(null)
    const { error } = await supabase.from('havelock_attendance_logs').insert({
      staff_name: clockInName.trim(),
      place: clockInPlace.trim() || 'Havelock City Mall',
    })
    if (error) {
      setAttendanceError(error.message)
      return
    }
    setClockInName('')
    await loadAttendanceLogs()
  }

  async function handleClockOut(id: string) {
    setAttendanceError(null)
    const { error } = await supabase
      .from('havelock_attendance_logs')
      .update({ time_out: new Date().toISOString() })
      .eq('id', id)
    if (error) setAttendanceError(error.message)
    else await loadAttendanceLogs()
  }

  function startEditAttendance(log: AttendanceLog) {
    setEditingAttendanceId(log.id)
    setEditTimeInValue(toDatetimeLocal(log.time_in))
    setEditTimeOutValue(log.time_out ? toDatetimeLocal(log.time_out) : '')
  }

  function cancelEditAttendance() {
    setEditingAttendanceId(null)
  }

  async function saveEditAttendance() {
    if (!editingAttendanceId) return
    const original = attendanceLogs.find((l) => l.id === editingAttendanceId)
    if (!original) return
    setAttendanceError(null)
    const newTimeIn = new Date(editTimeInValue).toISOString()
    const newTimeOut = editTimeOutValue ? new Date(editTimeOutValue).toISOString() : null
    const { error } = await supabase
      .from('havelock_attendance_logs')
      .update({ time_in: newTimeIn, time_out: newTimeOut })
      .eq('id', editingAttendanceId)
    if (error) {
      setAttendanceError(error.message)
      return
    }
    await logAudit(
      'attendance',
      'updated',
      `Changed ${original.staff_name}'s clock in/out on ${original.log_date} (in: ${formatClockTime(original.time_in)} → ${formatClockTime(newTimeIn)}, out: ${original.time_out ? formatClockTime(original.time_out) : '—'} → ${newTimeOut ? formatClockTime(newTimeOut) : '—'})`,
      {
        staff_name: original.staff_name,
        log_date: original.log_date,
        old_time_in: original.time_in,
        new_time_in: newTimeIn,
        old_time_out: original.time_out,
        new_time_out: newTimeOut,
      },
    )
    setEditingAttendanceId(null)
    await loadAttendanceLogs()
  }

  async function handleDeleteAttendance(id: string) {
    const log = attendanceLogs.find((l) => l.id === id)
    if (log) {
      await logAudit(
        'attendance',
        'deleted',
        `Deleted attendance record for ${log.staff_name} on ${log.log_date} (in: ${formatClockTime(log.time_in)}, out: ${log.time_out ? formatClockTime(log.time_out) : '—'})`,
        {
          staff_name: log.staff_name,
          log_date: log.log_date,
          time_in: log.time_in,
          time_out: log.time_out,
        },
      )
    }
    await supabase.from('havelock_attendance_logs').delete().eq('id', id)
    loadAttendanceLogs()
  }

  const openAttendanceLogs = useMemo(() => attendanceLogs.filter((l) => l.time_out === null), [attendanceLogs])

  function handleDownloadPrices() {
    const headers = ['Product', 'Price', 'Compare At Price']
    const csvRows = filteredPriceRows.map((r) => [r.product_name, r.price, r.compare_at_price ?? ''])
    const csv = [headers, ...csvRows].map((row) => row.map(escapeCsv).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'havelock-product-prices.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  function currentPriceFor(productName: string): number | null {
    return productPrices.get(normalizeProductName(productName)) ?? null
  }

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
    setQboPushResult(null)
    try {
      const billIds = await saveParsedReport(preview.report, preview.fileName)
      setPreview(null)
      setRangePreset('custom')
      setCustomStart(preview.report.dateRange.start)
      setCustomEnd(preview.report.dateRange.end)

      // Auto-push every saved bill to QuickBooks — no manual "Push to
      // QuickBooks" step. Best-effort: a push failure (e.g. an unmapped
      // product) never undoes the save, it just shows up in the summary.
      const results = await Promise.allSettled(billIds.map((id) => syncBill(id)))
      const success = results.filter((r) => r.status === 'fulfilled' && !r.value.error).length
      setQboPushResult({ total: billIds.length, success })
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
        <button
          className={activeSection === 'report' ? 'nav active' : 'nav'}
          onClick={() => setActiveSection('report')}
        >
          Daily Report
        </button>
        <button
          className={activeSection === 'prices' ? 'nav active' : 'nav'}
          onClick={() => setActiveSection('prices')}
        >
          Price List
        </button>
        <button
          className={activeSection === 'stock' ? 'nav active' : 'nav'}
          onClick={() => setActiveSection('stock')}
        >
          Stock Entries
        </button>
        <button
          className={activeSection === 'po' ? 'nav active' : 'nav'}
          onClick={() => setActiveSection('po')}
        >
          Purchase Orders
        </button>
        <button
          className={activeSection === 'attendance' ? 'nav active' : 'nav'}
          onClick={() => setActiveSection('attendance')}
        >
          Attendance
        </button>
        <button
          className={activeSection === 'qbo' ? 'nav active' : 'nav'}
          onClick={() => setActiveSection('qbo')}
        >
          QuickBooks
        </button>
        {canViewAudit && (
          <button
            className={activeSection === 'audit' ? 'nav active' : 'nav'}
            onClick={() => setActiveSection('audit')}
          >
            Audit Log
          </button>
        )}
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
        {activeSection === 'attendance' ? (
          <>
            <div className="topbar">
              <div>
                <h1>Attendance Log</h1>
                <div className="sub">
                  {openAttendanceLogs.length} currently clocked in · {attendanceLogs.length} total records
                </div>
              </div>
              <div className="tools">
                <button className="btn ghost" onClick={handleSignOut}>
                  Sign out
                </button>
              </div>
            </div>

            {attendanceError && <p className="error">{attendanceError}</p>}

            <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="fld" style={{ flex: 1, minWidth: 180 }}>
                  Name
                  <input
                    className="input"
                    value={clockInName}
                    onChange={(e) => setClockInName(e.target.value)}
                    placeholder="Staff name"
                  />
                </label>
                <label className="fld" style={{ flex: 1, minWidth: 180 }}>
                  Place
                  <input className="input" value={clockInPlace} onChange={(e) => setClockInPlace(e.target.value)} />
                </label>
                <button className="btn pri" onClick={handleClockIn} disabled={!clockInName.trim()}>
                  Clock In
                </button>
              </div>
            </div>

            {openAttendanceLogs.length > 0 && (
              <div className="panel" style={{ marginBottom: 16 }}>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Place</th>
                        <th>Time In</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {openAttendanceLogs.map((log) => (
                        <tr key={log.id}>
                          <td>{log.staff_name}</td>
                          <td>{log.place}</td>
                          <td>{formatClockTime(log.time_in)}</td>
                          <td>
                            <button className="btn sm pri" onClick={() => handleClockOut(log.id)}>
                              Clock Out
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {attendanceLoading ? (
              <p className="muted">Loading…</p>
            ) : attendanceLogs.length === 0 ? (
              <div className="empty">
                <div className="e-icon">🕒</div>
                No attendance records yet. Clock in above to get started.
              </div>
            ) : (
              <div className="panel">
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Place</th>
                        <th>Date</th>
                        <th>Time In</th>
                        <th>Time Out</th>
                        <th>Duration</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {attendanceLogs.map((log) =>
                        editingAttendanceId === log.id ? (
                          <tr key={log.id}>
                            <td>{log.staff_name}</td>
                            <td>{log.place}</td>
                            <td>{log.log_date}</td>
                            <td>
                              <input
                                className="input"
                                type="datetime-local"
                                value={editTimeInValue}
                                onChange={(e) => setEditTimeInValue(e.target.value)}
                              />
                            </td>
                            <td>
                              <input
                                className="input"
                                type="datetime-local"
                                value={editTimeOutValue}
                                onChange={(e) => setEditTimeOutValue(e.target.value)}
                              />
                            </td>
                            <td>{formatDuration(log.time_in, log.time_out)}</td>
                            <td style={{ display: 'flex', gap: 6 }}>
                              <button className="btn sm pri" onClick={saveEditAttendance}>
                                Save
                              </button>
                              <button className="btn sm ghost" onClick={cancelEditAttendance}>
                                Cancel
                              </button>
                            </td>
                          </tr>
                        ) : (
                          <tr key={log.id}>
                            <td>{log.staff_name}</td>
                            <td>{log.place}</td>
                            <td>{log.log_date}</td>
                            <td>{formatClockTime(log.time_in)}</td>
                            <td>{log.time_out ? formatClockTime(log.time_out) : '—'}</td>
                            <td>{formatDuration(log.time_in, log.time_out)}</td>
                            <td style={{ display: 'flex', gap: 6 }}>
                              <button className="btn sm ghost" onClick={() => startEditAttendance(log)}>
                                Edit
                              </button>
                              <button className="btn sm ghost" onClick={() => handleDeleteAttendance(log.id)}>
                                Delete
                              </button>
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : activeSection === 'po' ? (
          <>
            <div className="topbar">
              <div>
                <h1>Purchase Orders</h1>
                <div className="sub">{purchaseOrders.length} purchase orders</div>
              </div>
              <div className="tools">
                <button
                  className="btn pri"
                  onClick={() => {
                    resetPoForm()
                    setShowPoForm(true)
                  }}
                >
                  + Request PO
                </button>
                <button className="btn ghost" onClick={handleSignOut}>
                  Sign out
                </button>
              </div>
            </div>

            {poError && <p className="error">{poError}</p>}

            {showPoForm && (
              <div className="modal-backdrop">
                <div className="modal-card" style={{ maxWidth: 1000 }}>
                  <h2>Request Purchase Order</h2>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <label className="fld">
                      PO Date
                      <input className="input" type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
                    </label>
                    <label className="fld">
                      Ref Doc No
                      <input
                        className="input"
                        value={poRefDocNo}
                        onChange={(e) => setPoRefDocNo(e.target.value)}
                        placeholder="Optional"
                      />
                    </label>
                    <label className="fld">
                      From (Location)
                      <input
                        className="input"
                        value={poFromLocation}
                        onChange={(e) => setPoFromLocation(e.target.value)}
                      />
                    </label>
                    <label className="fld">
                      To (Location)
                      <input className="input" value={poToLocation} onChange={(e) => setPoToLocation(e.target.value)} />
                    </label>
                    <label className="fld">
                      Supplier name
                      <input
                        className="input"
                        value={poSupplierName}
                        onChange={(e) => setPoSupplierName(e.target.value)}
                        placeholder="e.g. Main Warehouse"
                      />
                    </label>
                    <label className="fld">
                      Supplier Reg No
                      <input
                        className="input"
                        value={poSupplierRegNo}
                        onChange={(e) => setPoSupplierRegNo(e.target.value)}
                        placeholder="Optional"
                      />
                    </label>
                  </div>
                  <label className="fld">
                    Remarks
                    <input className="input" value={poRemarks} onChange={(e) => setPoRemarks(e.target.value)} placeholder="Optional" />
                  </label>

                  <div style={{ position: 'relative' }}>
                    <label className="fld">
                      Add item
                      <input
                        className="input"
                        value={poItemSearch}
                        onChange={(e) => setPoItemSearch(e.target.value)}
                        placeholder="Search products…"
                      />
                    </label>
                    {poItemMatches.length > 0 && (
                      <div className="panel" style={{ position: 'absolute', zIndex: 5, width: '100%' }}>
                        {poItemMatches.map((row) => (
                          <button
                            key={row.product_name}
                            className="btn ghost"
                            style={{ display: 'flex', justifyContent: 'space-between', width: '100%', borderRadius: 0 }}
                            onClick={() => addDraftPoItem(row)}
                          >
                            <span>{row.product_name}</span>
                            <span>LKR {row.price.toLocaleString()}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="panel">
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Item Code</th>
                            <th>Item Name</th>
                            <th>Rate</th>
                            <th>Qty</th>
                            <th>Unit</th>
                            <th>Discount</th>
                            <th>Tax Amount</th>
                            <th>Net Total</th>
                            <th>Total</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {draftPoItems.length === 0 ? (
                            <tr>
                              <td colSpan={10} className="muted">
                                No items added yet — search above to add one.
                              </td>
                            </tr>
                          ) : (
                            draftPoItems.map((it, idx) => {
                              const { netTotal, total } = computePoItemTotals(it)
                              return (
                                <tr key={it.productName}>
                                  <td>
                                    <input
                                      className="input"
                                      style={{ width: 90 }}
                                      value={it.itemCode ?? ''}
                                      onChange={(e) => updateDraftPoItem(idx, { itemCode: e.target.value || null })}
                                    />
                                  </td>
                                  <td className="wrap">{it.productName}</td>
                                  <td>
                                    <input
                                      className="input"
                                      type="number"
                                      min="0"
                                      style={{ width: 90 }}
                                      value={it.rate}
                                      onChange={(e) => updateDraftPoItem(idx, { rate: Number(e.target.value) })}
                                    />
                                  </td>
                                  <td>
                                    <input
                                      className="input"
                                      type="number"
                                      min="0"
                                      style={{ width: 80 }}
                                      value={it.quantity}
                                      onChange={(e) => updateDraftPoItem(idx, { quantity: Number(e.target.value) })}
                                    />
                                  </td>
                                  <td>
                                    <input
                                      className="input"
                                      style={{ width: 90 }}
                                      value={it.unit}
                                      onChange={(e) => updateDraftPoItem(idx, { unit: e.target.value })}
                                    />
                                  </td>
                                  <td>
                                    <input
                                      className="input"
                                      type="number"
                                      min="0"
                                      style={{ width: 90 }}
                                      value={it.discountValue}
                                      onChange={(e) => updateDraftPoItem(idx, { discountValue: Number(e.target.value) })}
                                    />
                                  </td>
                                  <td>
                                    <input
                                      className="input"
                                      type="number"
                                      min="0"
                                      style={{ width: 90 }}
                                      value={it.taxAmount}
                                      onChange={(e) => updateDraftPoItem(idx, { taxAmount: Number(e.target.value) })}
                                    />
                                  </td>
                                  <td className="num">{netTotal.toLocaleString()}</td>
                                  <td className="num">{total.toLocaleString()}</td>
                                  <td>
                                    <button className="btn sm ghost" onClick={() => removeDraftPoItem(idx)}>
                                      Remove
                                    </button>
                                  </td>
                                </tr>
                              )
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="topbar" style={{ marginBottom: 0 }}>
                    <div className="sub">
                      Total: LKR{' '}
                      {draftPoItems.reduce((s, it) => s + computePoItemTotals(it).total, 0).toLocaleString()}
                    </div>
                  </div>

                  <div className="modal-actions">
                    <button
                      className="btn ghost"
                      onClick={() => {
                        setShowPoForm(false)
                        resetPoForm()
                      }}
                      disabled={savingPo}
                    >
                      Cancel
                    </button>
                    <button className="btn pri" onClick={handleConfirmPo} disabled={savingPo || draftPoItems.length === 0}>
                      {savingPo ? 'Saving…' : 'Confirm'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {poLoading ? (
              <p className="muted">Loading…</p>
            ) : purchaseOrders.length === 0 ? (
              <div className="empty">
                <div className="e-icon">📦</div>
                No purchase orders yet. Click "+ Request PO" to get started.
              </div>
            ) : (
              <div className="panel">
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>PO No</th>
                        <th>Date</th>
                        <th>Supplier</th>
                        <th>Items</th>
                        <th>Total</th>
                        <th>Status</th>
                        <th>QuickBooks</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {purchaseOrders.map((po) => (
                        <tr key={po.id}>
                          <td>{po.po_no}</td>
                          <td>{po.po_date}</td>
                          <td>{po.supplier_name}</td>
                          <td className="wrap">
                            {po.purchase_order_items
                              .map((it) => `${it.quantity} ${it.unit} ${it.product_name}`)
                              .join(', ')}
                          </td>
                          <td className="num">LKR {po.total.toLocaleString()}</td>
                          <td>
                            <select
                              className="input"
                              style={{ width: 'auto' }}
                              value={po.status}
                              onChange={(e) => handleUpdatePoStatus(po.id, e.target.value as PurchaseOrder['status'])}
                            >
                              <option value="Pending">Pending</option>
                              <option value="Approved">Approved</option>
                              <option value="Rejected">Rejected</option>
                              <option value="Completed">Completed</option>
                            </select>
                          </td>
                          <td>
                            <QboPushButton
                              recordType="purchase_order"
                              recordId={po.id}
                              disabled={po.status !== 'Completed'}
                              disabledReason="Only Completed purchase orders can be pushed to QuickBooks."
                            />
                          </td>
                          <td>
                            <button className="btn sm ghost" onClick={() => handleDeletePo(po.id)}>
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : activeSection === 'stock' ? (
          <>
            <div className="topbar">
              <div>
                <h1>Physical Stock Entries</h1>
                <div className="sub">{stockEntries.length} entries</div>
              </div>
              <div className="tools">
                <button
                  className="btn pri"
                  onClick={() => {
                    resetStockForm()
                    setShowStockForm(true)
                  }}
                >
                  + New Physical Stock Entry
                </button>
                <button className="btn ghost" onClick={handleSignOut}>
                  Sign out
                </button>
              </div>
            </div>

            {stockError && <p className="error">{stockError}</p>}

            {showStockForm && (
              <div className="modal-backdrop">
                <div className="modal-card" style={{ maxWidth: 960 }}>
                  <h2>Create Physical Stock Entry</h2>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div>
                      <label className="fld">
                        Entry Date
                        <input
                          className="input"
                          type="date"
                          value={stockEntryDate}
                          onChange={(e) => setStockEntryDate(e.target.value)}
                        />
                      </label>
                    </div>
                    <div>
                      <label className="fld">
                        Ref Doc No
                        <input
                          className="input"
                          value={stockRefDocNo}
                          onChange={(e) => setStockRefDocNo(e.target.value)}
                          placeholder="Optional"
                        />
                      </label>
                    </div>
                  </div>
                  <label className="fld">
                    Remarks
                    <input
                      className="input"
                      value={stockRemarks}
                      onChange={(e) => setStockRemarks(e.target.value)}
                      placeholder="Optional"
                    />
                  </label>

                  <div style={{ position: 'relative' }}>
                    <label className="fld">
                      Add item manually
                      <input
                        className="input"
                        value={stockItemSearch}
                        onChange={(e) => setStockItemSearch(e.target.value)}
                        placeholder="Search products…"
                      />
                    </label>
                    {stockItemMatches.length > 0 && (
                      <div className="panel" style={{ position: 'absolute', zIndex: 5, width: '100%' }}>
                        {stockItemMatches.map((row) => (
                          <button
                            key={row.product_name}
                            className="btn ghost"
                            style={{ display: 'flex', justifyContent: 'space-between', width: '100%', borderRadius: 0 }}
                            onClick={() => addDraftStockItem(row)}
                          >
                            <span>{row.product_name}</span>
                            <span>LKR {row.price.toLocaleString()}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="panel">
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Item Name</th>
                            <th>Qty</th>
                            <th>Rate</th>
                            <th>Mfg Date</th>
                            <th>Expiry Date</th>
                            <th>Total</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {draftStockItems.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="muted">
                                No items added yet — search above to add one.
                              </td>
                            </tr>
                          ) : (
                            draftStockItems.map((it, idx) => (
                              <tr key={it.productName}>
                                <td className="wrap">{it.productName}</td>
                                <td>
                                  <input
                                    className="input"
                                    type="number"
                                    min="0"
                                    style={{ width: 80 }}
                                    value={it.quantity}
                                    onChange={(e) => updateDraftStockItem(idx, { quantity: Number(e.target.value) })}
                                  />
                                </td>
                                <td>
                                  <input
                                    className="input"
                                    type="number"
                                    min="0"
                                    style={{ width: 100 }}
                                    value={it.rate}
                                    onChange={(e) => updateDraftStockItem(idx, { rate: Number(e.target.value) })}
                                  />
                                </td>
                                <td>
                                  <input
                                    className="input"
                                    type="date"
                                    style={{ width: 150 }}
                                    value={it.manufacturingDate ?? ''}
                                    onChange={(e) =>
                                      updateDraftStockItem(idx, { manufacturingDate: e.target.value || null })
                                    }
                                  />
                                </td>
                                <td>
                                  <input
                                    className="input"
                                    type="date"
                                    style={{ width: 150 }}
                                    value={it.expiryDate ?? ''}
                                    onChange={(e) => updateDraftStockItem(idx, { expiryDate: e.target.value || null })}
                                  />
                                </td>
                                <td className="num">{(it.quantity * it.rate).toLocaleString()}</td>
                                <td>
                                  <button className="btn sm ghost" onClick={() => removeDraftStockItem(idx)}>
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="topbar" style={{ marginBottom: 0 }}>
                    <div className="sub">
                      Total: LKR{' '}
                      {draftStockItems.reduce((s, it) => s + it.quantity * it.rate, 0).toLocaleString()}
                    </div>
                  </div>

                  <div className="modal-actions">
                    <button
                      className="btn ghost"
                      onClick={() => {
                        setShowStockForm(false)
                        resetStockForm()
                      }}
                      disabled={savingStockEntry}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn pri"
                      onClick={handleConfirmStockEntry}
                      disabled={savingStockEntry || draftStockItems.length === 0}
                    >
                      {savingStockEntry ? 'Saving…' : 'Confirm'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {stockLoading ? (
              <p className="muted">Loading…</p>
            ) : stockEntries.length === 0 ? (
              <div className="empty">
                <div className="e-icon">📋</div>
                No stock entries yet. Click "New Physical Stock Entry" to get started.
              </div>
            ) : (
              <div className="panel">
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Entry No</th>
                        <th>Date</th>
                        <th>Ref Doc No</th>
                        <th>Remarks</th>
                        <th>Items</th>
                        <th>Nearest Expiry</th>
                        <th>Total</th>
                        <th>QuickBooks</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {stockEntries.map((entry) => {
                        const expiries = entry.stock_entry_items
                          .map((it) => it.expiry_date)
                          .filter((d): d is string => d !== null)
                          .sort()
                        const nearestExpiry = expiries[0] ?? null
                        const isExpanded = expandedStockEntryId === entry.id
                        return (
                        <Fragment key={entry.id}>
                        <tr>
                          <td>{entry.entry_no}</td>
                          <td>{entry.entry_date}</td>
                          <td>{entry.ref_doc_no}</td>
                          <td className="wrap">{entry.remarks}</td>
                          <td className="wrap">
                            <button
                              className="btn sm ghost"
                              onClick={() => setExpandedStockEntryId(isExpanded ? null : entry.id)}
                            >
                              {entry.stock_entry_items.length} item{entry.stock_entry_items.length === 1 ? '' : 's'}{' '}
                              {isExpanded ? '▲ hide' : '▼ view'}
                            </button>
                          </td>
                          <td>{nearestExpiry ?? '—'}</td>
                          <td className="num">LKR {entry.total.toLocaleString()}</td>
                          <td>
                            <QboPushButton recordType="stock_entry" recordId={entry.id} />
                          </td>
                          <td>
                            <button className="btn sm ghost" onClick={() => handleDeleteStockEntry(entry.id)}>
                              Delete
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={9} style={{ padding: '0 0 16px 0', background: 'var(--surface)' }}>
                              <table className="tbl" style={{ margin: '0 0 0 24px', width: 'calc(100% - 24px)' }}>
                                <thead>
                                  <tr>
                                    <th>Product Name</th>
                                    <th>Quantity</th>
                                    <th>Expiry Date</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {entry.stock_entry_items.map((it) => (
                                    <tr key={it.id}>
                                      <td className="wrap">{it.product_name}</td>
                                      <td>
                                        <input
                                          className="input"
                                          type="number"
                                          style={{ width: 90 }}
                                          value={it.quantity}
                                          onChange={(e) =>
                                            updateStockItemLocal(entry.id, it.id, {
                                              quantity: Number(e.target.value) || 0,
                                            })
                                          }
                                          onBlur={() => saveStockItemEdit(entry.id, it.id)}
                                        />
                                      </td>
                                      <td>
                                        <input
                                          className="input"
                                          type="date"
                                          value={it.expiry_date ?? ''}
                                          onChange={(e) =>
                                            updateStockItemLocal(entry.id, it.id, {
                                              expiry_date: e.target.value || null,
                                            })
                                          }
                                          onBlur={() => saveStockItemEdit(entry.id, it.id)}
                                        />
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                        </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : activeSection === 'prices' ? (
          <>
            <div className="topbar">
              <div>
                <h1>Product Price List</h1>
                <div className="sub">
                  {filteredPriceRows.length} of {priceRows.length} products · from Ancient Nutra website
                </div>
              </div>
              <div className="tools">
                <input
                  className="input search-input"
                  placeholder="Search products…"
                  value={priceSearch}
                  onChange={(e) => setPriceSearch(e.target.value)}
                />
                <button className="btn pri" onClick={() => setShowAddProduct(true)}>
                  + Add product
                </button>
                <button className="btn ghost" onClick={handleDownloadPrices} disabled={priceRows.length === 0}>
                  Download
                </button>
              </div>
            </div>

            {priceError && <p className="error">{priceError}</p>}

            {showAddProduct && (
              <div className="modal-backdrop">
                <div className="modal-card" style={{ maxWidth: 480 }}>
                  <h2>Add product</h2>
                  <label className="fld">
                    Product name
                    <input
                      className="input"
                      value={newProductName}
                      onChange={(e) => setNewProductName(e.target.value)}
                    />
                  </label>
                  <label className="fld">
                    Price
                    <input
                      className="input"
                      type="number"
                      min="0"
                      value={newProductPrice}
                      onChange={(e) => setNewProductPrice(e.target.value)}
                    />
                  </label>
                  <label className="fld">
                    Compare-at price (optional)
                    <input
                      className="input"
                      type="number"
                      min="0"
                      value={newProductCompareAt}
                      onChange={(e) => setNewProductCompareAt(e.target.value)}
                    />
                  </label>
                  <div className="modal-actions">
                    <button
                      className="btn ghost"
                      onClick={() => {
                        setShowAddProduct(false)
                        setNewProductName('')
                        setNewProductPrice('')
                        setNewProductCompareAt('')
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn pri"
                      onClick={handleAddProduct}
                      disabled={!newProductName.trim() || !newProductPrice.trim()}
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>
            )}

            {priceRows.length === 0 ? (
              <div className="empty">
                <div className="e-icon">🏷️</div>
                No prices loaded yet.
              </div>
            ) : (
              <div className="panel">
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Price</th>
                        <th>Compare-at Price</th>
                        <th>Current Stock</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPriceRows.map((row) => {
                        const isEditing = editingPriceProduct === row.product_name
                        const stock = currentStockByProduct.get(row.product_name)
                        return (
                          <tr key={row.product_name}>
                            <td className="wrap">{row.product_name}</td>
                            {isEditing ? (
                              <>
                                <td>
                                  <input
                                    className="input"
                                    type="number"
                                    min="0"
                                    style={{ width: 110 }}
                                    value={editPriceValue}
                                    onChange={(e) => setEditPriceValue(e.target.value)}
                                  />
                                </td>
                                <td>
                                  <input
                                    className="input"
                                    type="number"
                                    min="0"
                                    style={{ width: 110 }}
                                    value={editCompareAtValue}
                                    onChange={(e) => setEditCompareAtValue(e.target.value)}
                                    placeholder="Optional"
                                  />
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="num">LKR {row.price.toLocaleString()}</td>
                                <td className="num">
                                  {row.compare_at_price !== null
                                    ? `LKR ${row.compare_at_price.toLocaleString()}`
                                    : '—'}
                                </td>
                              </>
                            )}
                            <td className="num">{stock !== undefined ? stock.toLocaleString() : '—'}</td>
                            <td>
                              {isEditing ? (
                                <div className="row-actions">
                                  <button className="btn sm pri" onClick={saveEditPrice}>
                                    Save
                                  </button>
                                  <button className="btn sm ghost" onClick={cancelEditPrice}>
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button className="btn sm ghost" onClick={() => startEditPrice(row)}>
                                  Edit
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : activeSection === 'qbo' ? (
          <QuickBooksTab />
        ) : activeSection === 'audit' ? (
          <>
            <div className="topbar">
              <div>
                <h1>Audit Log</h1>
                <div className="sub">{auditLogs.length} amendment{auditLogs.length === 1 ? '' : 's'} recorded</div>
              </div>
              <div className="tools">
                <button className="btn ghost" onClick={handleSignOut}>
                  Sign out
                </button>
              </div>
            </div>

            {auditError && <p className="error">{auditError}</p>}

            {auditLoading ? (
              <p className="muted">Loading…</p>
            ) : auditLogs.length === 0 ? (
              <p className="muted">No amendments recorded yet.</p>
            ) : (
              <div className="panel">
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Area</th>
                        <th>Action</th>
                        <th>Summary</th>
                        <th>Changed by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.map((log) => (
                        <tr key={log.id}>
                          <td>{new Date(log.created_at).toLocaleString()}</td>
                          <td>
                            {log.entity_type === 'product_price'
                              ? 'Price List'
                              : log.entity_type === 'stock_entry'
                                ? 'Stock Entry'
                                : 'Attendance'}
                          </td>
                          <td>{log.action}</td>
                          <td className="wrap">{log.summary}</td>
                          <td>{log.changed_by_email ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
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
            className={`btn sm ${rangePreset === 'month' ? 'pri' : 'ghost'}`}
            onClick={() => setRangePreset('month')}
          >
            📅 Monthly
          </button>
          {rangePreset === 'month' && (
            <input
              className="input"
              type="month"
              value={selectedMonth}
              max={isoDate(new Date()).slice(0, 7)}
              onChange={(e) => setSelectedMonth(e.target.value)}
            />
          )}
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
        {qboPushResult && (
          <p className={qboPushResult.success === qboPushResult.total ? 'muted' : 'error'}>
            {qboPushResult.success === qboPushResult.total
              ? `Pushed all ${qboPushResult.total} bill${qboPushResult.total === 1 ? '' : 's'} to QuickBooks.`
              : `Pushed ${qboPushResult.success}/${qboPushResult.total} bills to QuickBooks — check the QuickBooks tab for details on the rest.`}
          </p>
        )}

        {preview && (
          <div className="modal-backdrop">
            <div className="modal-card">
              <h2>
                Review before saving —{' '}
                {preview.report.dateRange.start === preview.report.dateRange.end
                  ? dateLabel(preview.report.dateRange.start)
                  : `${dateLabel(preview.report.dateRange.start)} – ${dateLabel(preview.report.dateRange.end)}`}
              </h2>
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
                        {preview.report.dateRange.start !== preview.report.dateRange.end && <th>Date</th>}
                        <th>Time</th>
                        <th>Invoice No.</th>
                        <th>Items</th>
                        <th>Net Total</th>
                        <th>Payment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.report.bills.map((bill, idx) => (
                        <tr key={`${bill.invoiceNumber}-${idx}`}>
                          {preview.report.dateRange.start !== preview.report.dateRange.end && (
                            <td>{dateLabel(bill.date)}</td>
                          )}
                          <td>{bill.billTime}</td>
                          <td>{bill.invoiceNumber}</td>
                          <td className="wrap">
                            {bill.items.map((it, idx) => (
                              <div key={idx}>
                                {it.quantity > 1 ? `${it.quantity} ${it.productName}` : it.productName} — LKR{' '}
                                {it.netTotal.toLocaleString()}
                              </div>
                            ))}
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
                      <th>QuickBooks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bills.map((bill) => (
                      <tr key={bill.id}>
                        <td>{bill.report_date}</td>
                        <td>{bill.bill_time}</td>
                        <td>{bill.invoice_number}</td>
                        <td>{bill.order_number}</td>
                        <td className="wrap">
                          {itemLines(bill).map((line, idx) => (
                            <div key={idx}>{line}</div>
                          ))}
                        </td>
                        <td className="num">{bill.net_total.toLocaleString()}</td>
                        <td>{bill.payment_method}</td>
                        <td>
                          <QboPushButton recordType="bill" recordId={bill.id} />
                        </td>
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
                      <th>Current Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productBreakdown.map(([name, stats]) => {
                      const price = currentPriceFor(name)
                      return (
                        <tr key={name}>
                          <td className="wrap">{name}</td>
                          <td className="num">{stats.quantity}</td>
                          <td className="num">{stats.revenue.toLocaleString()}</td>
                          <td className="num">{price !== null ? `LKR ${price.toLocaleString()}` : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
          </>
        )}
      </main>
    </div>
  )
}
