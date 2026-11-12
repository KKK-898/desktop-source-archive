import type { OfficialSubscriptionSessionUploadRequest, PaymentOrder } from './api'
import { isOfficialSubscriptionDeliveryAccepted, isOfficialSubscriptionPaidOrder } from './official-subscription-delivery'

export interface OfficialSubscriptionRecoveryIdentity {
  email: string
  accountKey: string
  sessionJson: string
  sessionSource: string
  sessionUrl: string
}

export function isOfficialSubscriptionRecoveryOrder(order: PaymentOrder): boolean {
  const orderId = Number(order.order_id || order.id)
  const status = String(order.status || '').trim().toUpperCase()
  return Number.isSafeInteger(orderId) && orderId > 0
    && order.order_type === 'official_sub'
    && order.official_session_saved === false
    && ['PAID', 'RECHARGING', 'FAILED'].includes(status)
    && isOfficialSubscriptionPaidOrder(order)
}

export function normalizeOfficialSubscriptionRecoveryIdentity(
  result: Partial<GaogeDesktopCodexAccountSessionIdentifyResponse>,
): OfficialSubscriptionRecoveryIdentity {
  const email = String(result.email || '').trim().toLowerCase()
  const sessionJson = String(result.sessionJson || '').trim()
  if (!email || !sessionJson || result.isFullSessionJson !== true) {
    throw new Error('未识别到完整 Session，请重新登录需要订阅的 ChatGPT 账号并复制完整文本。')
  }
  return {
    email,
    accountKey: String(result.accountKey || '').trim(),
    sessionJson,
    sessionSource: 'desktop_paid_order_recovery',
    sessionUrl: 'https://chatgpt.com/api/auth/session',
  }
}

/** Only an explicit server receipt can finish recovery; no checkout API is called. */
export async function recoverOfficialSubscriptionSession(
  orderId: number,
  identity: OfficialSubscriptionRecoveryIdentity,
  services: {
    readOrder: (orderId: number) => Promise<PaymentOrder>
    submit: (orderId: number, payload: OfficialSubscriptionSessionUploadRequest) => Promise<unknown>
    isCurrent: () => boolean
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('订单编号无效，请刷新后重试。')
  if (!services.isCurrent()) return false
  const order = await services.readOrder(orderId)
  if (!services.isCurrent()) return false
  if (Number(order.order_id || order.id) !== orderId || order.order_type !== 'official_sub') {
    throw new Error('订单信息已变化，请刷新后重新选择。')
  }
  if (!isOfficialSubscriptionPaidOrder(order)) {
    throw new Error('当前订单不能补交资料，请刷新订单状态；已付款订单无需再次付款。')
  }
  // Another client or the provider callback may already have finished delivery.
  if (order.official_session_saved === true) return true
  if (!isOfficialSubscriptionRecoveryOrder(order)) {
    throw new Error('当前订单不能补交资料，请刷新订单状态；已付款订单无需再次付款。')
  }
  const result = await services.submit(orderId, {
    fill_missing_only: true,
    plan_id: order.official_plan_id || undefined,
    account_email: identity.email,
    account_key: identity.accountKey,
    session_json: identity.sessionJson,
    session_source: identity.sessionSource,
    session_url: identity.sessionUrl,
    order_no: order.out_trade_no || String(orderId),
    paid_at: order.paid_at || null,
  })
  if (!services.isCurrent()) return false
  if (!isOfficialSubscriptionDeliveryAccepted(result)) {
    throw new Error('服务器尚未确认保存成功，资料已保留在当前窗口，请重试；无需再次付款。')
  }
  return true
}
