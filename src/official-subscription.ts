import type { OfficialReferralPrepareResult, PaymentOrder } from './api'

export type OfficialPlanID = 'plus' | 'pro5x' | 'pro20x' | 'pro25x'

export interface OfficialSubscriptionPlan {
  id: OfficialPlanID
  name: string
  badge: string
  officialPrice: string
  localPrice: string
  tagline: string
  description: string
  highlights: string[]
  tone: OfficialPlanID
  featured?: boolean
}

const proHighlights = (speed: string) => [
  '我们最强大的前沿 Pro 模型',
  speed,
  '最高记忆容量和 100 GB 存储空间',
  '抢先体验新工具和模型',
  '3 档使用额度可选',
  '无广告',
]

// Sale prices are filled exclusively from the same authoritative API as the web store.
export const defaultOfficialSubscriptionPlans: OfficialSubscriptionPlan[] = [
  {
    id: 'plus', name: 'Plus', badge: '个人高效', officialPrice: '$20 / 月', localPrice: '',
    tagline: '适合日常高频使用 GPT 的个人账号。',
    description: '适合个人日常使用，覆盖 ChatGPT Plus 的核心模型、图像、记忆、Codex 与自定义 GPT 能力。',
    highlights: ['高级模型', '使用 Thinking 进行高级图像创建', '扩展容量的跨聊天记忆', 'Codex 编码智能体', '更高级别的深度研究', '项目和自定义 GPT'],
    tone: 'plus',
  },
  {
    id: 'pro5x', name: 'Pro 5x', badge: '进阶生产力', officialPrice: '$100 / 月', localPrice: '',
    tagline: 'Work 和 Codex 的使用额度更高。',
    description: '面向更重度的专业使用场景，适合持续编码、长文档处理、复杂推理和多任务工作流。',
    highlights: proHighlights('Work 和 Codex 的使用额度更高'), tone: 'pro5x', featured: true,
  },
  {
    id: 'pro20x', name: 'Pro 10x', badge: '高效专业', officialPrice: '$200 / 月', localPrice: '',
    tagline: '工作模式与 Codex 均享更快速度。',
    description: '面向高频专业使用，适合重度开发、复杂 Agent 流程、批量分析和高强度创作任务。',
    highlights: proHighlights('工作模式与 Codex 均享更快速度'), tone: 'pro20x',
  },
  {
    id: 'pro25x', name: 'Pro 25x', badge: '旗舰满血', officialPrice: '$500 / 月', localPrice: '',
    tagline: '工作模式与 Codex 均享最快速度。',
    description: '为超高频、长时间的专业任务准备，适合密集开发、复杂工作流和持续高强度创作。',
    highlights: proHighlights('工作模式与 Codex 均享最快速度'), tone: 'pro25x',
  },
]

export function normalizeOfficialSubscriptionPlan(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '').replace(/^chatgpt/, '').replace(/卡密$/, '')
  if (normalized === 'plus') return 'plus'
  if (['5x', 'pro5x', '5xpro'].includes(normalized)) return 'pro5x'
  // Retain the existing $200 SKU for old cards, coupons and paid receipts.
  if (['10x', 'pro10x', '10xpro', '20x', 'pro20x', '20xpro'].includes(normalized)) return 'pro20x'
  if (['25x', 'pro25x', '25xpro'].includes(normalized)) return 'pro25x'
  return normalized
}

export interface OfficialReferralSelection {
  ready: boolean
  step?: 'loading' | 'inviter' | 'coupons'
  inviterEmail: string
  couponIDs: number[]
  baseAmount: number
  inviteeDiscount: number
  couponFaceAmount: number
  couponDiscount: number
  payableAmount: number
}

export function quoteOfficialReferral(
  baseAmount: number,
  data: OfficialReferralPrepareResult | null,
  selectedCouponIDs: number[],
) {
  const cents = Number.isFinite(baseAmount) ? Math.max(0, Math.round(baseAmount * 100)) : 0
  const enabled = data?.config.enabled === true
  const inviteeCents = enabled && data?.relation?.status === 'preview'
    ? Math.min(cents, Math.max(0, Math.round(data.reward_preview.invitee_amount * 100))) : 0
  const selected = new Set(selectedCouponIDs)
  const faceCents = enabled ? (data?.coupons || [])
    .filter((coupon) => selected.has(coupon.id) && coupon.status === 'available' && normalizeOfficialSubscriptionPlan(coupon.plan_id) === normalizeOfficialSubscriptionPlan(data?.plan_id))
    .reduce((sum, coupon) => sum + Math.max(0, Math.round(coupon.face_amount * 100)), 0) : 0
  const couponCents = Math.min(Math.max(0, cents - inviteeCents), faceCents)
  return {
    baseAmount: cents / 100, inviteeDiscount: inviteeCents / 100,
    couponFaceAmount: faceCents / 100, couponDiscount: couponCents / 100,
    payableAmount: (cents - inviteeCents - couponCents) / 100,
  }
}

export function requireOfficialReferralReceipt(order: PaymentOrder, quote: OfficialReferralSelection) {
  const moneyEqual = (actual: unknown, expected: number) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) < 0.005
  if (!quote.ready || !moneyEqual(order.base_amount, quote.baseAmount) ||
      !moneyEqual(order.discount_amount ?? 0, quote.inviteeDiscount + quote.couponDiscount) ||
      !moneyEqual(order.amount, quote.payableAmount)) {
    throw new Error('订单优惠与确认金额不一致，请刷新套餐及邀请权益后重试；当前订单不会展示付款入口。')
  }
}
