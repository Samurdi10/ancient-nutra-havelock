import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import type { ParsedBill, ParsedBillItem, ParsedReport } from '../types'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

// The POS "Bill Wise Report" PDF is wider than one printable page, so its one
// logical table gets split into three column-groups, each printed as its own
// page (or run of pages): [Outlet, Date, Time, Invoice Number, Order Number],
// then [Order Item, Quantity, Gross Total, Discount, NBT, Service Charge, TDL,
// VAT], then [Net Total, Payment Method]. All three column-groups share the
// same underlying row order, so row i of the items table and row i of the
// totals table describe the same physical line — that's how this parser
// recombines them without ever seeing x/y-based column boundaries.
//
// Within the items/totals table, each invoice occupies one row per line item
// followed by one "closing" row: blank item name, and (on the totals table)
// the invoice's net total + payment method. The very last rows of the report
// are grand totals in the same blank-item shape, distinguished only by
// appearing after every invoice from the bill list has already been closed.

interface Row {
  text: string
  tokens: string[]
}

type TableKind = 'bills' | 'items' | 'totals' | null

const NUMERIC = /^[\d,]+(\.\d+)?$/
const TIME = /\d{1,2}:\d{2}\s*[AP]M/
const DATE = /\d{2}\/\d{2}\/\d{4}/

function toNumber(token: string): number {
  return Number(token.replace(/,/g, '')) || 0
}

function isBillsHeader(text: string): boolean {
  return /^Outlet\b/.test(text) && /\bDate\b/.test(text) && /\bTime\b/.test(text) && /Invoice Number/.test(text) && /Order Number/.test(text)
}

function isItemsHeader(text: string): boolean {
  // VAT sometimes prints on this column-group and sometimes on the totals
  // one (see isTotalsHeader) depending on how many columns fit per page, so
  // it isn't part of this check — Order Item/Quantity/Gross Total/Discount/
  // NBT are the columns that are always here.
  return /^Order Item\b/.test(text) && /Quantity/.test(text) && /Gross Total/.test(text) && /Discount/.test(text) && /NBT/.test(text)
}

function isTotalsHeader(text: string): boolean {
  // Not anchored to the start of the row: a VAT column sometimes lands here
  // instead of on the items header (see isItemsHeader), e.g. "VAT Net Total
  // Payment Method" instead of just "Net Total Payment Method".
  return /Net Total/.test(text) && /Payment Method/.test(text)
}

function isSummaryLine(text: string): boolean {
  return /Avg Bill:/.test(text)
}

function toIsoDate(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split('/')
  return `${y}-${m}-${d}`
}

/** Group a page's positioned text items into visual rows, top-to-bottom / left-to-right. */
async function extractRows(pdf: pdfjsLib.PDFDocumentProxy): Promise<Row[]> {
  const rows: Row[] = []
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    type PositionedItem = { str: string; x: number; y: number }
    const items: PositionedItem[] = content.items
      .filter((item): item is TextItem => 'transform' in item && item.str.trim().length > 0)
      .map((item) => ({
        str: item.str.trim(),
        x: item.transform[4],
        y: item.transform[5],
      }))

    // Cluster by y (PDF y grows upward, so sort rows top-first = y descending).
    const clusters: PositionedItem[][] = []
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
    const TOLERANCE = 2.5
    for (const item of sorted) {
      const cluster = clusters.find((c) => Math.abs(c[0].y - item.y) < TOLERANCE)
      if (cluster) cluster.push(item)
      else clusters.push([item])
    }
    for (const cluster of clusters) {
      cluster.sort((a, b) => a.x - b.x)
      // pdfjs sometimes reports two adjacent columns (e.g. an amount and the
      // payment method next to it) as one text item with an internal space
      // ("8,400.00 Cash"), which would otherwise fail numeric detection —
      // split every item on whitespace so tokens are always single words.
      const tokens = cluster.flatMap((i) => i.str.split(/\s+/).filter(Boolean))
      rows.push({ text: tokens.join(' '), tokens })
    }
  }
  return rows
}

interface BillListEntry {
  outlet: string
  time: string
  invoiceNumber: string
  orderNumber: string | null
}

function parseBillsRow(
  row: Row,
  state: { outlet: string; date: string | null },
): BillListEntry | null {
  const timeMatch = row.text.match(TIME)
  if (!timeMatch) return null
  const nums = row.text.match(/\d{6,}/g)
  if (!nums || nums.length === 0) return null
  const invoiceNumber = nums[0]
  const orderNumber = nums[1] ?? null

  const prefix = row.text.slice(0, timeMatch.index).trim()
  const dateMatch = prefix.match(DATE)
  if (dateMatch) state.date = toIsoDate(dateMatch[0])
  const outletText = prefix.replace(DATE, '').trim()
  if (outletText) state.outlet = outletText

  return { outlet: state.outlet, time: timeMatch[0], invoiceNumber, orderNumber }
}

interface ItemsRowParsed {
  productName: string | null
  quantity: number | null
  grossTotal: number | null
  /** How many trailing numeric tokens this row had (used to detect grand-total rows). */
  numericCount: number
}

function parseItemsRow(row: Row): ItemsRowParsed {
  // Product names can contain bare numbers ("60 capsules", "Karavila... - 60
  // capsules"), so only the *trailing contiguous run* of numeric tokens is the
  // Quantity/Gross Total/tax columns — not every numeric token in the row.
  let split = row.tokens.length
  while (split > 0 && NUMERIC.test(row.tokens[split - 1])) split--
  const numericTokens = row.tokens.slice(split)
  const nameTokens = row.tokens.slice(0, split)
  const productName = nameTokens.join(' ').trim() || null
  return {
    productName,
    quantity: numericTokens[0] !== undefined ? toNumber(numericTokens[0]) : null,
    grossTotal: numericTokens[1] !== undefined ? toNumber(numericTokens[1]) : null,
    numericCount: numericTokens.length,
  }
}

interface TotalsRowParsed {
  netTotal: number | null
  paymentMethod: string | null
}

function parseTotalsRow(row: Row): TotalsRowParsed {
  // Net Total is always the LAST numeric token: some reports print an extra
  // VAT column before it ("VAT Net Total Payment Method"), so taking the
  // first numeric token would grab VAT (usually 0) instead.
  const numericTokens = row.tokens.filter((t) => NUMERIC.test(t))
  const netTotal = numericTokens.length > 0 ? toNumber(numericTokens[numericTokens.length - 1]) : null
  const paymentTokens = row.tokens.filter((t) => !NUMERIC.test(t))
  const paymentMethod = paymentTokens.join(' ').trim() || null
  return { netTotal, paymentMethod }
}

export async function parseHavelockReportPdf(file: File): Promise<ParsedReport> {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const rows = await extractRows(pdf)

  const warnings: string[] = []
  const billList: BillListEntry[] = []
  const itemsRows: ItemsRowParsed[] = []
  const totalsRows: TotalsRowParsed[] = []
  const stated = { totalBill: null as number | null, avgBill: null as number | null, avgBillQty: null as number | null }

  let currentTable: TableKind = null
  const billState = { outlet: '', date: null as string | null }
  // A long product name sometimes wraps onto its own line with no numeric
  // columns at all (e.g. "MetaSystem (Pre & Post Meal Fat Burning" / "System)
  // 1  10,500.00 ..."). That wrap line has no counterpart row on the totals
  // page, so treating it as its own item row desyncs the items/totals row
  // alignment for everything after it — buffer it and prepend it to the next
  // real item row instead.
  let pendingNamePrefix = ''

  for (const row of rows) {
    if (isBillsHeader(row.text)) {
      currentTable = 'bills'
      continue
    }
    if (isItemsHeader(row.text)) {
      currentTable = 'items'
      continue
    }
    if (isTotalsHeader(row.text)) {
      currentTable = 'totals'
      continue
    }
    if (isSummaryLine(row.text)) {
      const totalBillMatch = row.text.match(/Total Bill:\s*(\d+)/)
      const avgBillMatch = row.text.match(/Avg Bill:\s*([\d.]+)/)
      const avgQtyMatch = row.text.match(/Avg Bill Qty:\s*([\d.]+)/)
      if (totalBillMatch) stated.totalBill = Number(totalBillMatch[1])
      if (avgBillMatch) stated.avgBill = Number(avgBillMatch[1])
      if (avgQtyMatch) stated.avgBillQty = Number(avgQtyMatch[1])
      continue
    }
    if (currentTable === 'bills') {
      const entry = parseBillsRow(row, billState)
      if (entry) billList.push(entry)
    } else if (currentTable === 'items') {
      const parsed = parseItemsRow(row)
      if (parsed.productName && parsed.numericCount === 0) {
        pendingNamePrefix = pendingNamePrefix ? `${pendingNamePrefix} ${parsed.productName}` : parsed.productName
        continue
      }
      if (pendingNamePrefix) {
        parsed.productName = parsed.productName ? `${pendingNamePrefix} ${parsed.productName}` : pendingNamePrefix
        pendingNamePrefix = ''
      }
      itemsRows.push(parsed)
    } else if (currentTable === 'totals') {
      totalsRows.push(parseTotalsRow(row))
    }
  }

  if (itemsRows.length !== totalsRows.length) {
    warnings.push(
      `Items table has ${itemsRows.length} rows but totals table has ${totalsRows.length} — the PDF layout may not match what this parser expects. Review carefully before saving.`,
    )
  }

  const expectedBills = billList.length
  const bills: ParsedBill[] = []
  let currentItems: ParsedBillItem[] = []
  const rowCount = Math.min(itemsRows.length, totalsRows.length)

  for (let i = 0; i < rowCount && bills.length < expectedBills; i++) {
    const itemRow = itemsRows[i]
    const totalsRow = totalsRows[i]
    if (itemRow.productName) {
      currentItems.push({
        productName: itemRow.productName,
        quantity: itemRow.quantity ?? 1,
        grossTotal: itemRow.grossTotal ?? 0,
        netTotal: totalsRow.netTotal ?? itemRow.grossTotal ?? 0,
      })
      continue
    }
    // Blank item name: either an invoice-closing row (has a payment method) or
    // one of the trailing grand-total rows (no payment method — never a real
    // closing row since every real bill records how it was paid).
    if (totalsRow.paymentMethod) {
      const entry = billList[bills.length]
      bills.push({
        outlet: entry.outlet,
        billTime: entry.time,
        invoiceNumber: entry.invoiceNumber,
        orderNumber: entry.orderNumber,
        netTotal: totalsRow.netTotal ?? currentItems.reduce((s, it) => s + it.netTotal, 0),
        paymentMethod: totalsRow.paymentMethod,
        items: currentItems,
      })
      currentItems = []
    }
  }

  if (bills.length !== expectedBills) {
    warnings.push(
      `Expected ${expectedBills} bills from the bill list, but only matched ${bills.length} against the items table. Review carefully before saving.`,
    )
  }

  const parsedTotal = bills.reduce((s, b) => s + b.netTotal, 0)
  if (stated.avgBill !== null && bills.length > 0) {
    const computedAvg = parsedTotal / bills.length
    if (Math.abs(computedAvg - stated.avgBill) > 1) {
      warnings.push(
        `Computed average bill (${computedAvg.toFixed(2)}) does not match the PDF's stated average (${stated.avgBill}) — totals may be off.`,
      )
    }
  }

  const reportDate = billState.date ?? new Date().toISOString().slice(0, 10)

  return { reportDate, bills, stated, warnings }
}
