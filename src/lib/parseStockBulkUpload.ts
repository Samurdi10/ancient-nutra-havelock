import ExcelJS from 'exceljs'

export interface ParsedStockRow {
  category: string | null
  productName: string
  quantity: number
  /** null means "no rate in the source file — look it up from the price list". */
  rate: number | null
  manufacturingDate: string | null
  expiryDate: string | null
}

/** Normalizes a date cell (ISO, dd/mm/yyyy, or a JS Date already) to "yyyy-mm-dd", or null if unparseable. */
function normalizeDateCell(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  const parsed = new Date(s)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  return null
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
    const idx = header.findIndex((h) => pattern.test(h.trim()))
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
    const values = row.values as unknown[]
    table.push(
      values.slice(1).map((v) => {
        if (v === null || v === undefined) return ''
        if (v instanceof Date) return v.toISOString().slice(0, 10)
        return String(v)
      }),
    )
  })
  if (table.length === 0) return { source: 'template', rows: [], warnings: ['This sheet is empty.'] }
  return rowsFromTable(table[0], table.slice(1))
}

function looksLikeHtml(text: string): boolean {
  return /Current Stock Summary Report|<table|<html/i.test(text.slice(0, 2000))
}

function isZipSignature(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 4))
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

export async function parseStockBulkUpload(file: File): Promise<ParsedStockUpload> {
  const buffer = await file.arrayBuffer()
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
