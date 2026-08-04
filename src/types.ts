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
  /** ISO yyyy-mm-dd — a single PDF can span more than one calendar day (its
   *  "Date Range" line may cover 2 dates), so this is per-bill, not per-report. */
  date: string
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
  /** Min/max across all bills' dates — usually the same day, but a single PDF
   *  can span 2 calendar days (see ParsedBill.date), so this is a range. */
  dateRange: { start: string; end: string }
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

export type PoStatus = 'Pending' | 'Approved' | 'Rejected' | 'Completed'

export interface PurchaseOrderItem {
  id: string
  po_id: string
  item_code: string | null
  product_name: string
  rate: number
  quantity: number
  unit: string
  net_total: number
  discount_value: number
  tax_amount: number
  tax_combination: string
  total: number
}

export interface PurchaseOrder {
  id: string
  po_no: string
  po_date: string
  ref_doc_no: string | null
  from_location: string
  to_location: string
  supplier_name: string | null
  supplier_reg_no: string | null
  status: PoStatus
  remarks: string | null
  net_total: number
  total_discount: number
  total_tax: number
  total: number
  created_by_email: string | null
  created_at: string
  purchase_order_items: PurchaseOrderItem[]
}

export interface AuditLogEntry {
  id: string
  entity_type: 'product_price' | 'stock_entry' | 'attendance'
  action: 'created' | 'updated' | 'deleted'
  summary: string
  details: Record<string, unknown> | null
  changed_by_email: string | null
  created_at: string
}

export interface AttendanceLog {
  id: string
  staff_name: string
  place: string
  log_date: string
  time_in: string
  time_out: string | null
  created_by_email: string | null
  created_at: string
}
