export interface BillItem {
  id: string
  bill_id: string
  sku: string | null
  product_name: string
  quantity: number
  gross_total: number
  net_total: number
}

export interface Bill {
  id: string
  report_date: string
  outlet: string
  bill_time: string
  invoice_number: string
  order_number: string | null
  net_total: number
  payment_method: string | null
  source_file: string | null
  created_by_email: string | null
  created_at: string
  bill_items: BillItem[]
}

/** One parsed bill, before it has been saved to Supabase. */
export interface ParsedBill {
  outlet: string
  billTime: string
  invoiceNumber: string
  orderNumber: string | null
  netTotal: number
  paymentMethod: string | null
  items: ParsedBillItem[]
}

export interface ParsedBillItem {
  productName: string
  quantity: number
  grossTotal: number
  netTotal: number
}

export interface ParsedReport {
  reportDate: string
  bills: ParsedBill[]
  /** From the PDF's own "Total Bill / Avg Bill" summary line, for cross-checking. */
  stated: {
    totalBill: number | null
    avgBill: number | null
    avgBillQty: number | null
  }
  warnings: string[]
}

export interface StockEntryItem {
  id: string
  entry_id: string
  product_name: string
  quantity: number
  rate: number
  total: number
  manufacturing_date: string | null
  expiry_date: string | null
}

export interface StockEntry {
  id: string
  entry_no: string
  entry_date: string
  ref_doc_no: string | null
  remarks: string | null
  total: number
  created_by_email: string | null
  created_at: string
  stock_entry_items: StockEntryItem[]
}
