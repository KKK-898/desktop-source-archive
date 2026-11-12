import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultOfficialSubscriptionPlans, normalizeOfficialSubscriptionPlan, quoteOfficialReferral, requireOfficialReferralReceipt } from '../src/official-subscription.ts'

const referral = {
  config: { enabled: true }, account_email: 'buyer@example.test', plan_id: 'pro25x',
  relation: { status: 'preview', inviter_email: 'friend@example.test' },
  reward_preview: { plan_id: 'pro25x', invitee_amount: 50, inviter_amount: 50 },
  coupons: [
    { id: 1, plan_id: 'pro25x', face_amount: 50, status: 'available' },
    { id: 2, plan_id: 'pro5x', face_amount: 500, status: 'available' },
    { id: 3, plan_id: 'pro25x', face_amount: 100, status: 'used' },
    { id: 4, plan_id: 'pro25x', face_amount: 4000, status: 'available' },
  ],
}

test('Pro 25x aliases never resolve to Pro 5x and prices require server configuration', () => {
  for (const alias of ['Pro 25x', 'pro25x', '25x-pro', 'ChatGPT 25x Pro', 'pro_25x']) {
    assert.equal(normalizeOfficialSubscriptionPlan(alias), 'pro25x')
  }
  assert.equal(normalizeOfficialSubscriptionPlan('pro5x'), 'pro5x')
  assert.equal(normalizeOfficialSubscriptionPlan('pro20x'), 'pro20x')
  for (const alias of ['Pro 10x', 'pro10x', '10x-pro', 'ChatGPT 10x Pro']) assert.equal(normalizeOfficialSubscriptionPlan(alias), 'pro20x')
  assert.equal(normalizeOfficialSubscriptionPlan('pro125x'), 'pro125x')
  assert.deepEqual(defaultOfficialSubscriptionPlans.map((plan) => plan.id), ['plus', 'pro5x', 'pro20x', 'pro25x'])
  assert.ok(defaultOfficialSubscriptionPlans.every((plan) => plan.localPrice === ''))
  assert.equal(defaultOfficialSubscriptionPlans.at(-1).officialPrice, '$500 / 月')
  assert.equal(defaultOfficialSubscriptionPlans.find((plan) => plan.id === 'pro20x').name, 'Pro 10x')
})

test('first invitation discounts 3800 to 3750 and only matching available coupons can stack', () => {
  assert.equal(quoteOfficialReferral(3800, referral, []).payableAmount, 3750)
  const quote = quoteOfficialReferral(3800, referral, [1, 1, 2, 3])
  assert.equal(quote.couponFaceAmount, 50)
  assert.equal(quote.inviteeDiscount, 50)
  assert.equal(quote.payableAmount, 3700)
})

test('returning accounts do not reuse the first invitation discount', () => {
  const quote = quoteOfficialReferral(3800, { ...referral, relation: { status: 'qualified' } }, [1])
  assert.equal(quote.inviteeDiscount, 0)
  assert.equal(quote.payableAmount, 3750)
  const disabled = quoteOfficialReferral(3800, { ...referral, config: { enabled: false } }, [1])
  assert.equal(disabled.payableAmount, 3800)
})

test('full coupon coverage stops at zero and records the unrefundable excess', () => {
  const quote = quoteOfficialReferral(3800, referral, [4])
  assert.equal(quote.payableAmount, 0)
  assert.equal(quote.couponFaceAmount - quote.couponDiscount, 250)
  const selection = { ...quote, ready: true, inviterEmail: 'friend@example.test', couponIDs: [4] }
  assert.doesNotThrow(() => requireOfficialReferralReceipt({ amount: 0, base_amount: 3800, discount_amount: 3800 }, selection))
})

test('payment receipt must prove the same server-side discount before showing any payment link', () => {
  const selection = { ...quoteOfficialReferral(3800, referral, []), ready: true, inviterEmail: 'friend@example.test', couponIDs: [] }
  assert.doesNotThrow(() => requireOfficialReferralReceipt({ amount: 3750, base_amount: 3800, discount_amount: 50 }, selection))
  for (const invalid of [
    { amount: 3800 },
    { amount: 3800, base_amount: 3800, discount_amount: 0 },
    { amount: 3750, base_amount: 780, discount_amount: 50 },
    { amount: 3750, base_amount: 3800, discount_amount: 100 },
  ]) assert.throws(() => requireOfficialReferralReceipt(invalid, selection))
})
