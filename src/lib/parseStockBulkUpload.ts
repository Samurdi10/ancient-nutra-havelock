import ExcelJS from 'exceljs'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

export interface ParsedStockRow {
  category: string | null
  productName: string
  quantity: number
  /** null means "no rate in the source file — look it up from the price list". */
  rate: number | null
  manufacturingDate: string | null
  expiryDate: string | null
}

/** Normalizes a date cell (ISO, yyyy.mm.dd, dd/mm/yyyy, or a JS Date already)
 *  to "yyyy-mm-dd", or null if unparseable. */
function normalizeDateCell(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const ymdDot = s.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/)
  if (ymdDot) return `${ymdDot[1]}-${ymdDot[2].padStart(2, '0')}-${ymdDot[3].padStart(2, '0')}`
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  const parsed = new Date(s)
  if (Number.isNaN(parsed.getTime())) return null
  // Local calendar components, not toISOString() — that converts to UTC
  // first and silently shifts the date by a day in timezones ahead of UTC.
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface ParsedStockUpload {
  source: 'omak-stock-summary' | 'template'
  rows: ParsedStockRow[]
  warnings: string[]
}

/** OMAK's "Current Stock Summary" export is actually HTML (despite the .xls name):
 *  grouped by "Category: X" headings, each with a table of [Product, Quantity, Unit]. */
function parseOmakStockSummaryHtml(html: string): ParsedStockUpload {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const rows: ParsedStockRow[] = []
  let currentCategory: string | null = null

  const nodes = doc.body.querySelectorAll('b.ml-3, table.rpt-table tr')
  for (const el of nodes) {
    if (el.tagName === 'B') {
      const text = el.textContent?.trim() ?? ''
      if (text.startsWith('Category:')) currentCategory = text.replace('Category:', '').trim()
      continue
    }
    const cells = el.querySelectorAll('td')
    if (cells.length < 2) continue
    const productName = cells[0].textContent?.trim() ?? ''
    const quantity = Number((cells[1].textContent ?? '0').trim().replace(/,/g, '')) || 0
    if (!productName) continue
    rows.push({
      category: currentCategory,
      productName,
      quantity,
      rate: null,
      manufacturingDate: null,
      expiryDate: null,
    })
  }

  return { source: 'omak-stock-summary', rows, warnings: [] }
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        inQuotes = false
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((v) => v.trim().length > 0)) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  row.push(field)
  if (row.some((v) => v.trim().length > 0)) rows.push(row)
  return rows
}

// Patterns are tried in priority order (first match across the whole header
// wins) so a more specific column — e.g. "Closing Stock", the actual on-hand
// quantity in an inventory ledger export — is preferred over a generic but
// misleading one that happens to appear earlier, like "Inward Qty (IN)".
function columnIndex(header: string[], patterns: RegExp[]): number {
  for (const pattern of patterns) {
    // findIndex visits every index including holes (unlike map/forEach), so
    // a defensive `?? ''` here is real protection, not just belt-and-suspenders.
    const idx = header.findIndex((h) => pattern.test((h ?? '').trim()))
    if (idx !== -1) return idx
  }
  return -1
}

function rowsFromTable(header: string[], dataRows: string[][]): ParsedStockUpload {
  // "Product Name (Description)" must win over "Item Code (SKU Code)" — both
  // contain the word "item"/"product" depending on the exact wording, but only
  // one is the actual product name.
  const nameCol = columnIndex(header, [/product name|description/i, /^item$/i, /product|item/i])
  // "Closing Stock" (current on-hand qty) must win over "Inward Qty (IN)" /
  // "Outward Qty (OUT)" / "Expired Qty", which also match a bare /qty/ pattern.
  const qtyCol = columnIndex(header, [/closing stock/i, /^qty$|^quantity$/i, /qty|quantity/i])
  // "Cost Per Unit" (real cost) is preferred over a generic "Rate"/"Price" column.
  const rateCol = columnIndex(header, [/cost per unit/i, /rate|price/i])
  const mfgCol = columnIndex(header, [/manufactur|mfg/i])
  const expCol = columnIndex(header, [/expiry|expire|exp date/i])
  const warnings: string[] = []
  if (nameCol === -1 || qtyCol === -1) {
    warnings.push(
      'Could not find a product name and quantity column in this file. Expected headers like "Product Name" + "Quantity", or "Product Name (Description)" + "Closing Stock".',
    )
    return { source: 'template', rows: [], warnings }
  }
  const rows: ParsedStockRow[] = []
  for (const r of dataRows) {
    const productName = (r[nameCol] ?? '').trim()
    if (!productName) continue
    const quantity = Number((r[qtyCol] ?? '0').replace(/,/g, '')) || 0
    const rate = rateCol !== -1 && r[rateCol]?.trim() ? Number(r[rateCol].replace(/,/g, '')) : null
    const manufacturingDate = mfgCol !== -1 ? normalizeDateCell(r[mfgCol] ?? '') : null
    const expiryDate = expCol !== -1 ? normalizeDateCell(r[expCol] ?? '') : null
    rows.push({ category: null, productName, quantity, rate, manufacturingDate, expiryDate })
  }
  return { source: 'template', rows, warnings }
}

function parseCsvTemplate(text: string): ParsedStockUpload {
  const table = parseCsvRows(text)
  if (table.length === 0) return { source: 'template', rows: [], warnings: ['This file is empty.'] }
  return rowsFromTable(table[0], table.slice(1))
}

async function parseXlsxTemplate(buffer: ArrayBuffer): Promise<ParsedStockUpload> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) return { source: 'template', rows: [], warnings: ['This workbook has no sheets.'] }
  const table: string[][] = []
  sheet.eachRow((row) => {
    // ExcelJS's row.values is a sparse array — unset cells are real holes,
    // not `null` entries. A plain .map() silently skips holes (leaving them
    // as holes in the result too), which then crashes columnIndex's
    // .findIndex() downstream (unlike .map, it does visit holes, passing
    // `undefined`). Indexing directly, rather than mapping, avoids that.
    const values = row.values as unknown[]
    const cells: string[] = []
    for (let i = 1; i < values.length; i++) {
      const v = values[i]
      if (v === null || v === undefined) cells.push('')
      else if (v instanceof Date) cells.push(v.toISOString().slice(0, 10))
      else cells.push(String(v))
    }
    table.push(cells)
  })
  if (table.length === 0) return { source: 'template', rows: [], warnings: ['This sheet is empty.'] }
  return rowsFromTable(table[0], table.slice(1))
}

interface PosItem {
  str: string
  x: number
  width: number
  y: number
}

/** Reconstructs a table (rows of cell strings) from a PDF's positioned text,
 *  since PDFs have no real cell structure — only text with x/y coordinates.
 *  Text is grouped into rows by y, then within a row, adjacent text is merged
 *  into one cell unless the gap between them is wide enough to be a real
 *  column boundary (a plain word-space is a few points; a column gutter is
 *  much wider). This is a generic best-effort extraction — unlike the Bill
 *  Wise Report parser, there's no known fixed layout to rely on here. */
async function extractPdfTable(buffer: ArrayBuffer): Promise<string[][]> {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const table: string[][] = []
  const GAP_THRESHOLD = 8

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    const items: PosItem[] = content.items
      .filter((item): item is TextItem => 'transform' in item && item.str.trim().length > 0)
      .map((item) => ({ str: item.str.trim(), x: item.transform[4], width: item.width, y: item.transform[5] }))

    const clusters: PosItem[][] = []
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
    const TOLERANCE = 2.5
    for (const item of sorted) {
      const cluster = clusters.find((c) => Math.abs(c[0].y - item.y) < TOLERANCE)
      if (cluster) cluster.push(item)
      else clusters.push([item])
    }

    for (const cluster of clusters) {
      cluster.sort((a, b) => a.x - b.x)
      const cells: string[] = []
      let cellParts: string[] = []
      let cellEnd = -Infinity
      for (const item of cluster) {
        if (cellParts.length > 0 && item.x - cellEnd > GAP_THRESHOLD) {
          cells.push(cellParts.join(' '))
          cellParts = []
        }
        cellParts.push(item.str)
        cellEnd = item.x + item.width
      }
      if (cellParts.length > 0) cells.push(cellParts.join(' '))
      table.push(cells)
    }
  }
  return table
}

async function parsePdfTemplate(buffer: ArrayBuffer): Promise<ParsedStockUpload> {
  const table = (await extractPdfTable(buffer)).filter((row) => row.some((cell) => cell.trim().length > 0))
  if (table.length === 0) {
    return { source: 'template', rows: [], warnings: ['This PDF has no readable table content.'] }
  }
  // Scan for the header row rather than assuming row 0, since a title/date
  // line (e.g. "Current Stock Summary Report") often precedes the real table.
  for (let i = 0; i < table.length; i++) {
    const nameCol = columnIndex(table[i], [/product name|description/i, /^item$/i, /product|item/i])
    const qtyCol = columnIndex(table[i], [/closing stock/i, /^qty$|^quantity$/i, /qty|quantity/i])
    if (nameCol !== -1 && qtyCol !== -1) {
      return rowsFromTable(table[i], table.slice(i + 1))
    }
  }
  return {
    source: 'template',
    rows: [],
    warnings: [
      'Could not find a header row with product name and quantity columns in this PDF. Review the file layout, or export as CSV/Excel instead.',
    ],
  }
}

function looksLikeHtml(text: string): boolean {
  return /Current Stock Summary Report|<table|<html/i.test(text.slice(0, 2000))
}

function isZipSignature(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 4))
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

function isPdfSignature(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 5))
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 // "%PDF"
}

export async function parseStockBulkUpload(file: File): Promise<ParsedStockUpload> {
  const buffer = await file.arrayBuffer()
  if (isPdfSignature(buffer)) {
    return parsePdfTemplate(buffer)
  }
  const asText = new TextDecoder('utf-8').decode(buffer.slice(0, 4000))

  if (looksLikeHtml(asText)) {
    const fullText = new TextDecoder('utf-8').decode(buffer)
    return parseOmakStockSummaryHtml(fullText)
  }
  if (isZipSignature(buffer)) {
    return parseXlsxTemplate(buffer)
  }
  return parseCsvTemplate(new TextDecoder('utf-8').decode(buffer))
}
