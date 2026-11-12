import type { OnlinePaymentConfig, OnlinePaymentPlan, OnlinePaymentSnapshot } from './api'

type RechargeQuote = Pick<OnlinePaymentPlan, 'payAmount' | 'baseCreditAmount' | 'bonusAmount' | 'creditAmount'>

function isMoney(value: unknown, allowZero = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    (allowZero ? value >= 0 : value > 0) &&
    Math.abs(value * 100 - Math.round(value * 100)) < 0.000001
}

// Accept prices only from a complete server response. Never fill missing plans or amounts locally.
export function requireOnlinePaymentConfig(value: unknown): OnlinePaymentConfig {
  const config = value as Partial<OnlinePaymentConfig> & { configured?: boolean }
  if (!config || typeof config !== 'object' || typeof config.enabled !== 'boolean' || !Array.isArray(config.plans)) {
    throw new Error('在线支付配置格式不完整，请稍后重试。')
  }
  if (config.configured === false) {
    throw new Error('在线支付尚未配置，请联系管理员。')
  }
  const multiplier = config.balanceRechargeMultiplier ?? config.balance_recharge_multiplier
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error('在线支付额度配置无效，请联系管理员。')
  }
  const ids = new Set<string>()
  const plans: OnlinePaymentPlan[] = []
  if (config.enabled) {
    for (const plan of config.plans) {
      if (plan?.enabled === false) continue
      if (!plan || plan.enabled !== true || typeof plan.id !== 'string' || !plan.id.trim() || ids.has(plan.id) ||
        !isMoney(plan.payAmount) || !isMoney(plan.baseCreditAmount) || !isMoney(plan.bonusAmount, true) ||
        !isMoney(plan.creditAmount) || Math.abs(plan.baseCreditAmount + plan.bonusAmount - plan.creditAmount) > 0.000001 ||
        Math.abs(Math.round(plan.payAmount * multiplier * 100) / 100 - plan.baseCreditAmount) > 0.000001) {
        throw new Error('在线支付套餐配置无效，请联系管理员。')
      }
      ids.add(plan.id)
      plans.push({ ...plan })
    }
  }
  return { ...config, enabled: config.enabled, balanceRechargeMultiplier: multiplier, plans }
}

export function sameRechargeQuote(previous: RechargeQuote, current: RechargeQuote): boolean {
  return previous.payAmount === current.payAmount &&
    previous.baseCreditAmount === current.baseCreditAmount &&
    previous.bonusAmount === current.bonusAmount &&
    previous.creditAmount === current.creditAmount
}

// The receipt is authoritative: a successful HTTP response alone does not confirm the quoted credit.
export function requireMatchingRechargeReceipt(value: unknown, expected: OnlinePaymentSnapshot, orderId: number): OnlinePaymentSnapshot {
  const response = value as Record<string, unknown> | null
  const raw = response?.snapshot ?? response?.record
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('订单充值配置未获服务端确认，请重新确认后支付。')
  }
  const record = raw as Record<string, unknown>
  const field = (camel: string, snake: string) => {
    if (record[camel] !== undefined && record[snake] !== undefined && record[camel] !== record[snake]) {
      throw new Error('订单充值配置返回不一致，请重新确认后支付。')
    }
    return record[camel] ?? record[snake]
  }
  const receiptOrderId = response?.orderId ?? response?.order_id ?? record.sub2OrderId ?? record.sub2_order_id
  const planId = field('planId', 'plan_id')
  const payAmount = field('payAmount', 'pay_amount')
  const baseCreditAmount = field('baseCreditAmount', 'base_credit_amount')
  const bonusAmount = field('bonusAmount', 'bonus_amount')
  const totalCreditAmount = field('totalCreditAmount', 'total_credit_amount')
  if (receiptOrderId !== undefined && String(receiptOrderId) !== String(orderId) ||
    typeof planId !== 'string' || !planId || !isMoney(payAmount) || !isMoney(baseCreditAmount) ||
    !isMoney(bonusAmount, true) || !isMoney(totalCreditAmount) ||
    Math.abs(baseCreditAmount + bonusAmount - totalCreditAmount) > 0.000001) {
    throw new Error('订单充值配置确认无效，请重新确认后支付。')
  }
  if (planId !== expected.planId || !sameRechargeQuote({ ...expected, creditAmount: expected.totalCreditAmount }, {
    payAmount, baseCreditAmount, bonusAmount, creditAmount: totalCreditAmount,
  })) {
    throw new Error('订单充值金额或额度已变化，请重新确认后支付。')
  }
  return { ...expected, planId, payAmount, baseCreditAmount, bonusAmount, totalCreditAmount }
}
