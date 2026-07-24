import { useEffect, useState } from 'react'
import {
  fetchLatestSyncStatuses,
  syncBill,
  syncStockEntry,
  syncPurchaseOrder,
  type QboSyncRecordType,
  type QboSyncStatus,
} from '../lib/qbo'

const SYNC_FN: Record<QboSyncRecordType, (id: string) => Promise<{ qboId?: string; unmappedProducts?: string[] }>> = {
  bill: syncBill,
  stock_entry: syncStockEntry,
  purchase_order: syncPurchaseOrder,
}

/** Per-row "Push to QuickBooks" button + status badge. Manual, one record at
 *  a time, so a bad sync is reviewable before it lands in the accounting
 *  system — matches this app's existing review-before-save pattern. */
export function QboPushButton({
  recordType,
  recordId,
  disabled,
  disabledReason,
}: {
  recordType: QboSyncRecordType
  recordId: string
  disabled?: boolean
  disabledReason?: string
}) {
  const [status, setStatus] = useState<QboSyncStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)

  useEffect(() => {
    fetchLatestSyncStatuses(recordType, [recordId])
      .then((byId) => setStatus(byId[recordId] ?? null))
      .catch(() => undefined)
  }, [recordType, recordId])

  async function handlePush() {
    setBusy(true)
    setWarning(null)
    try {
      const result = await SYNC_FN[recordType](recordId)
      if (result.unmappedProducts && result.unmappedProducts.length > 0) {
        setWarning(`Skipped (not mapped to a QBO item): ${result.unmappedProducts.join(', ')}`)
      }
      setStatus({
        status: 'success',
        qboId: result.qboId ?? null,
        error: null,
        createdAt: new Date(0).toISOString(),
      })
    } catch (err) {
      setStatus({
        status: 'error',
        qboId: null,
        error: err instanceof Error ? err.message : 'Sync failed.',
        createdAt: new Date(0).toISOString(),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <button
        className="btn sm ghost"
        onClick={handlePush}
        disabled={busy || disabled || status?.status === 'success'}
        title={disabled ? disabledReason : undefined}
      >
        {busy
          ? 'Pushing…'
          : status?.status === 'success'
            ? 'Synced to QB'
            : status?.status === 'error'
              ? 'Retry QB push'
              : 'Push to QuickBooks'}
      </button>
      {status?.status === 'error' && <span className="muted" style={{ fontSize: 12 }}>{status.error}</span>}
      {warning && <span className="muted" style={{ fontSize: 12 }}>{warning}</span>}
    </div>
  )
}
