export interface OfficialSubscriptionReceipt {
  userId: string
  orderId: number
  outTradeNo: string
  planId: string
  planName: string
  amount: number
  createdAt: string
}

/** Keep only order references locally. Session/account credentials belong on the server. */
export function normalizeOfficialSubscriptionReceipt(value: unknown): OfficialSubscriptionReceipt | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const orderId = Number(item.orderId)
  const userId = String(item.userId || '').trim()
  const planId = String(item.planId || '').trim()
  const amount = Number(item.amount)
  if (!Number.isSafeInteger(orderId) || orderId <= 0 || !userId || !planId || !Number.isFinite(amount) || amount < 0) return null
  return {
    userId,
    orderId,
    outTradeNo: String(item.outTradeNo || '').trim(),
    planId,
    planName: String(item.planName || '').trim(),
    amount,
    createdAt: String(item.createdAt || '').trim(),
  }
}

export function requireOfficialSubscriptionSessionSaved(order: { official_session_saved?: unknown }) {
  if (order.official_session_saved !== true) {
    throw new Error('服务器尚未确认安全保存订阅资料，暂不能付款。请联系管理员升级订阅服务后重试。')
  }
}

export function isOfficialSubscriptionPaidOrder(order: { status?: string; paid_at?: string | null }) {
  const status = String(order.status || '').trim().toUpperCase()
  return ['PAID', 'RECHARGING', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FINISHED', 'TRADE_SUCCESS'].includes(status)
    || (status === 'FAILED' && Boolean(order.paid_at))
}

export function isOfficialSubscriptionDeliveryAccepted(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  if (result.saved === true || result.submitted === true) return true
  return [result.request, result.order].some((record) => (
    Boolean(record) && typeof record === 'object'
    && (record as Record<string, unknown>).hasSessionText === true
  ))
}

/** A successful HTTP response without a durable acceptance receipt is not delivery. */
export async function deliverOfficialSubscriptionSession(
  primary: () => Promise<unknown>,
  fallback: () => Promise<unknown>,
): Promise<boolean> {
  for (const submit of [primary, fallback]) {
    try {
      if (isOfficialSubscriptionDeliveryAccepted(await submit())) return true
    } catch {
      // The caller keeps the order and in-memory Session until one receiver confirms it.
    }
  }
  return false
}
