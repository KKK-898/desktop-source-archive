import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { ref, toRaw } from 'vue'
import { requireOfficialReferralReceipt } from '../src/official-subscription.ts'
import {
  deliverOfficialSubscriptionSession,
  isOfficialSubscriptionDeliveryAccepted,
  isOfficialSubscriptionPaidOrder,
  normalizeOfficialSubscriptionReceipt,
  requireOfficialSubscriptionSessionSaved,
} from '../src/official-subscription-delivery.ts'

// Execute the actual Vue/API functions with their external services replaced.
function loadFunctions(path, names, globals = {}) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8')
  const script = path.endsWith('.vue') ? text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1] : text
  const source = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = names.map((name) => {
    const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
    assert.ok(declaration, `${name} exists`)
    return declaration.getText(source)
  })
  const compiled = ts.transpileModule(`${functions.join('\n')}\nglobalThis.functions = { ${names.join(',')} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const context = vm.createContext({ exports: {}, ...globals })
  vm.runInContext(compiled, context)
  return context
}

const vuePath = '../src/components/新版主题.vue'
const noop = () => {}
const plan = { id: 'pro5x', name: 'Pro 5x', localPrice: 100 }
const account = { email: 'test@example.test', accountKey: 'private-account-key', sessionJson: '{"accessToken":"test-secret"}', sessionSource: 'live_chatgpt_session', sessionUrl: 'https://chatgpt.com/api/auth/session' }

test('payment requires explicit durable receipt, never a truthy compatibility response', () => {
  for (const value of [undefined, false, 1, 'true']) {
    assert.throws(() => requireOfficialSubscriptionSessionSaved({ official_session_saved: value }), /暂不能付款/)
  }
  assert.doesNotThrow(() => requireOfficialSubscriptionSessionSaved({ official_session_saved: true }))
})

test('local recovery serialization strips credentials, Session, and payment links', () => {
  const receipt = normalizeOfficialSubscriptionReceipt({
    userId: '7', orderId: 23, planId: 'pro5x', planName: 'Pro 5x', amount: 100,
    sessionJson: account.sessionJson, session_json: account.sessionJson, accountKey: account.accountKey,
    token: 'private-auth', account: account.email, pay_url: 'https://pay.example.test/private',
  })
  assert.deepEqual(Object.keys(receipt).sort(), ['amount', 'createdAt', 'orderId', 'outTradeNo', 'planId', 'planName', 'userId'])
  assert.doesNotMatch(JSON.stringify(receipt), /test-secret|private-|example\.test/)
  assert.equal(normalizeOfficialSubscriptionReceipt({ ...receipt, orderId: NaN }), null)
})

test('core acceptance succeeds without needing a second upload', async () => {
  let secondaryCalls = 0
  assert.equal(await deliverOfficialSubscriptionSession(async () => ({ submitted: true }), async () => { secondaryCalls++; throw Error('unavailable') }), true)
  assert.equal(secondaryCalls, 0)
})

test('fallback must confirm stored Session and both failures remain retryable', async () => {
  assert.equal(await deliverOfficialSubscriptionSession(async () => { throw Error('offline') }, async () => ({ request: { hasSessionText: true } })), true)
  assert.equal(await deliverOfficialSubscriptionSession(async () => ({}), async () => ({ request: { hasSessionText: false } })), false)
  assert.equal(await deliverOfficialSubscriptionSession(async () => { throw Error('offline') }, async () => { throw Error('offline') }), false)
  assert.equal(isOfficialSubscriptionDeliveryAccepted({ submitted: 'true' }), false)
})

test('official payment receipt does not wait for fulfillment completion', () => {
  for (const status of ['paid', 'PAID', 'RECHARGING', 'COMPLETED']) assert.equal(isOfficialSubscriptionPaidOrder({ status }), true)
  for (const status of ['PENDING', 'FAILED', 'CANCELLED', 'EXPIRED']) assert.equal(isOfficialSubscriptionPaidOrder({ status }), false)
  assert.equal(isOfficialSubscriptionPaidOrder({ status: 'FAILED', paid_at: '2026-09-26T00:00:00Z' }), true)
})

function checkoutHarness(createOrder) {
  const calls = []
  const context = loadFunctions(vuePath, ['openOfficialOnlinePayment', 'createOfficialSubscriptionRequestContext'], {
    clearPaymentPanelDismissTimer: noop, stopPaymentPolling: noop,
    officialIdentifiedAccount: ref(account), selectedOfficialPlan: ref(plan), authToken: ref('auth'),
    officialReferralSelection: ref({ ready: true, inviterEmail: '', couponIDs: [], baseAmount: 100, inviteeDiscount: 0, couponDiscount: 0, couponFaceAmount: 0, payableAmount: 100 }),
    authUser: ref({ id: 7 }), getPaymentOrderId: (order) => order?.order_id || order?.id || 0,
    officialSubscriptionError: ref(''), officialSubscriptionNotice: ref(''), activePaymentPurpose: ref(''),
    showOfficialPaymentDialog: ref(true), isOfficialSubscribing: ref(false), activeOfficialSubscriptionRequest: ref(null),
    paymentQrCode: ref(''), externalPaymentPageUrl: ref(''), activePaymentCreditAmount: ref(0),
    activePaymentOrder: ref(null), activePaymentPageUrl: ref(''), getRandomText: () => 'stable-random',
    createPaymentOrder: async (...args) => { calls.push(args); return createOrder(...args) },
    requireOfficialSubscriptionSessionSaved,
    requireOfficialReferralReceipt,
    getPaymentOrderAmount: (order) => order.amount,
    rememberOfficialSubscriptionReceipt: () => calls.push('saved'),
    renderPaymentOrder: async () => calls.push('render'), notify: noop, reportPageError: noop,
    refreshActivePaymentOrder: async () => calls.push('refresh'),
    getPaymentErrorMessage: (error) => error.message,
  })
  return { context, calls }
}

test('checkout sends Session before opening payment, and preserves one idempotency key on failure', async () => {
  const { context, calls } = checkoutHarness(async () => ({ id: 23, amount: 100 }))
  await context.functions.openOfficialOnlinePayment()
  const pending = context.activeOfficialSubscriptionRequest.value
  assert.equal(calls[0][2].officialSubscriptionSession.session_json, account.sessionJson)
  assert.equal(calls.includes('render'), false)
  assert.equal(calls.includes('saved'), false)
  assert.match(context.officialSubscriptionError.value, /暂不能付款/)
  await context.functions.openOfficialOnlinePayment()
  assert.equal(context.activeOfficialSubscriptionRequest.value, pending)
  assert.equal(calls[0][2].idempotencyKey, calls[1][2].idempotencyKey)
})

test('checkout renders only after saving the server receipt and verifying the confirmed quote', async () => {
  const { context, calls } = checkoutHarness(async () => ({ id: 23, amount: 100, base_amount: 100, discount_amount: 0, official_session_saved: true }))
  await context.functions.openOfficialOnlinePayment()
  assert.deepEqual(calls.slice(1), ['saved', 'render'])
  assert.equal(context.showOfficialPaymentDialog.value, false)
})

test('late checkout failure cannot clear a different account payment', async () => {
  let rejectOrder
  const { context, calls } = checkoutHarness(() => new Promise((_, reject) => { rejectOrder = reject }))
  const checkout = context.functions.openOfficialOnlinePayment()
  context.authToken.value = 'another-auth'
  context.authUser.value = { id: 8 }
  context.activeOfficialSubscriptionRequest.value = { ownerId: '8', orderId: 24 }
  const nextOrder = { id: 24, status: 'PENDING' }
  context.activePaymentOrder.value = nextOrder
  rejectOrder(new Error('old request failed'))
  await checkout
  assert.equal(toRaw(context.activePaymentOrder.value), nextOrder)
  assert.equal(context.officialSubscriptionError.value, '')
  assert.equal(calls.includes('render'), false)
})

test('checkout does not create an order until referral selection is verified', async () => {
  const { context, calls } = checkoutHarness(async () => ({}))
  context.officialReferralSelection.value.ready = false
  await context.functions.openOfficialOnlinePayment()
  assert.equal(calls.length, 0)
  assert.match(context.officialSubscriptionError.value, /确认邀请/)
})

test('checkout forwards invitation and coupons and refreshes a fully covered order without a QR code', async () => {
  const { context, calls } = checkoutHarness(async () => ({ id: 23, amount: 0, base_amount: 100, discount_amount: 100, status: 'PAID', official_session_saved: true }))
  context.officialReferralSelection.value = { ready: true, inviterEmail: 'friend@example.test', couponIDs: [42], baseAmount: 100, inviteeDiscount: 50, couponDiscount: 50, couponFaceAmount: 50, payableAmount: 0 }
  await context.functions.openOfficialOnlinePayment()
  assert.equal(calls[0][0], 100)
  assert.equal(calls[0][2].officialReferral.inviter_email, 'friend@example.test')
  assert.deepEqual(Array.from(calls[0][2].officialReferral.coupon_ids), [42])
  assert.deepEqual(calls.slice(1), ['saved', 'refresh'])
  assert.equal(context.activeOfficialSubscriptionRequest.value.amount, 0)
  assert.equal(context.showOfficialPaymentDialog.value, false)
})

test('server discount mismatch never exposes a payment link', async () => {
  const { context, calls } = checkoutHarness(async () => ({ id: 23, amount: 100, base_amount: 100, discount_amount: 0, official_session_saved: true }))
  context.officialReferralSelection.value.inviteeDiscount = 50
  context.officialReferralSelection.value.payableAmount = 50
  await context.functions.openOfficialOnlinePayment()
  assert.equal(calls.includes('render'), false)
  assert.equal(calls.includes('saved'), false)
  assert.match(context.officialSubscriptionError.value, /优惠与确认金额不一致/)
})

test('fully coupon-paid subscriptions keep zero in payment and local history', () => {
  const context = loadFunctions(vuePath, ['normalizeOfficialSubscriptionRecord', 'normalizeOfficialSubscriptionRecordFromPayment'], {
    normalizeOfficialSubscriptionProgress: () => 'subscribing', normalizeOfficialPlanKey: (value) => value,
    getPaymentOrderId: (order) => order.id, isOfficialSubscriptionPaidOrder,
    getPaymentOrderTime: (order) => order.paid_at, findOfficialPlanByAmount: () => null,
    officialSubscriptionPlans: ref([{ id: 'pro25x', name: 'Pro 25x' }]),
    officialIdentifiedAccountLabel: () => account.email, officialIdentifiedAccount: ref(account),
  })
  const record = context.functions.normalizeOfficialSubscriptionRecordFromPayment(
    { id: 23, status: 'PAID', amount: 0, pay_amount: 0, paid_at: '2026-09-30T00:00:00Z' },
    { amount: 3800, planId: 'pro25x', planName: 'Pro 25x', account: account.email },
  )
  assert.equal(record.amount, 0)
  assert.equal(context.functions.normalizeOfficialSubscriptionRecord(record).amount, 0)
  assert.equal(context.functions.normalizeOfficialSubscriptionRecord({ ...record, amount: -1 }), null)
  assert.equal(context.functions.normalizeOfficialSubscriptionRecord({ ...record, amount: null }), null)
})

test('API sends pre-payment Session and native software origin without retired Admin endpoints', async () => {
  const calls = []
  const context = loadFunctions('../src/api.ts', [
    'createPaymentOrder', 'submitOfficialSubscriptionToSoftwareAdmin', 'submitOfficialSubscriptionCardSecretToSoftwareAdmin',
  ], {
    createApiRequestId: () => 'request', getPayOrigin: () => 'https://pay.example.test',
    apiRequest: (...args) => { calls.push(args); return Promise.resolve({}) },
  })
  await context.functions.createPaymentOrder(100, 'auth', { orderType: 'official_sub', officialPlanId: 'pro5x', officialSubscriptionSession: { session_json: account.sessionJson }, idempotencyKey: 'keep-this-key' })
  assert.equal(JSON.parse(calls[0][1].body).official_subscription_session.session_json, account.sessionJson)
  assert.equal(calls[0][1].headers['Idempotency-Key'], 'keep-this-key')
  await context.functions.submitOfficialSubscriptionToSoftwareAdmin({ sessionText: account.sessionJson }, 'auth')
  await context.functions.submitOfficialSubscriptionCardSecretToSoftwareAdmin({ sessionText: account.sessionJson }, 'auth')
  assert.deepEqual(calls.slice(1).map((call) => call[0]), ['/desktop/subscriptions', '/desktop/subscriptions/card-secret'])
  for (const call of calls.slice(1)) {
    assert.equal(JSON.parse(call[1].body).subscriptionOrigin, 'software')
    assert.equal(call[3].serviceScope, 'core')
  }
})

function paidHarness(accepted) {
  const state = { orderId: 23, planId: 'pro5x', planName: 'Pro 5x', account: account.email, sessionJson: account.sessionJson }
  const calls = []
  const context = loadFunctions(vuePath, ['refreshActivePaymentOrder'], {
    activePaymentOrder: ref({ id: 23, out_trade_no: 'trade-23' }), activePaymentPurpose: ref('official-subscription'),
    activeOfficialSubscriptionRequest: ref(state), authToken: ref('auth'), authUser: ref({ id: 7 }), paymentOrderRefreshInFlight: false,
    isPaymentRefreshing: ref(false), getPaymentOrderId: (order) => order?.id,
    verifyPaymentOrderByOutTradeNo: async () => ({ id: 23, status: 'PAID', paid_at: '2026-09-26T00:00:00Z' }),
    isPaymentCompleted: (status) => status === 'COMPLETED', isOfficialSubscriptionPaidOrder,
    stopPaymentPolling: noop, persistInvoiceOrder: noop, persistOfficialSubscriptionRecord: noop,
    submitOfficialSubscriptionSessionForOrder: async () => accepted,
    syncCurrentUser: async () => {}, syncUsageDashboardStats: async () => {},
    officialSubscriptionError: ref(''), officialSubscriptionNotice: ref(''), selectedOfficialPlan: ref(plan),
    officialIdentifiedAccountLabel: () => account.email,
    hidePaymentPanel: () => calls.push('hide'), resumePendingOfficialSubscriptionOrders: async () => calls.push('recover'),
    notify: noop, reportPageError: noop, getPaymentErrorMessage: (error) => error.message,
  })
  return { context, calls, state }
}

test('paid but undelivered order retains Session and refresh panel for retry', async () => {
  const { context, calls, state } = paidHarness(false)
  await context.functions.refreshActivePaymentOrder()
  assert.equal(toRaw(context.activeOfficialSubscriptionRequest.value), state)
  assert.equal(calls.includes('hide'), false)
  assert.match(context.officialSubscriptionError.value, /无需再次付款/)
  assert.equal(context.paymentOrderRefreshInFlight, false)
})

test('paid and durable order clears sensitive context after confirmed acceptance', async () => {
  const { context, calls } = paidHarness(true)
  await context.functions.refreshActivePaymentOrder()
  assert.equal(context.activeOfficialSubscriptionRequest.value, null)
  assert.deepEqual(calls, ['hide', 'recover'])
  assert.equal(context.officialSubscriptionError.value, '')
})

test('late polling response cannot transfer a saved receipt or Session to another order', async () => {
  const { context, calls } = paidHarness(true)
  let resolvePoll
  context.verifyPaymentOrderByOutTradeNo = () => new Promise((resolve) => { resolvePoll = resolve })
  const polling = context.functions.refreshActivePaymentOrder()
  const nextOrder = { id: 24, status: 'PENDING', official_session_saved: true }
  const nextSession = { orderId: 24, sessionJson: 'other-private-session' }
  context.activePaymentOrder.value = nextOrder
  context.activeOfficialSubscriptionRequest.value = nextSession
  resolvePoll({ id: 23, status: 'PAID' })
  await polling
  assert.equal(toRaw(context.activePaymentOrder.value), nextOrder)
  assert.equal(toRaw(context.activeOfficialSubscriptionRequest.value), nextSession)
  assert.deepEqual(calls, [])
})

test('Session from another pending order is never used for a fallback upload', async () => {
  let uploads = 0
  const context = loadFunctions(vuePath, ['submitOfficialSubscriptionSessionForOrder'], {
    activeOfficialSubscriptionRequest: ref({ orderId: 24, sessionJson: 'other-private-session' }),
    authToken: ref('auth'), officialSubscriptionOwnerParams: () => ({ userId: '7' }),
    getPaymentOrderId: (order) => order?.id || 0,
    deliverOfficialSubscriptionSession: async () => { uploads++; return true },
  })
  assert.equal(await context.functions.submitOfficialSubscriptionSessionForOrder({ id: 23, status: 'PAID' }), false)
  assert.equal(uploads, 0)
})

test('restart recovery needs only order references and retains failed queries', async () => {
  const receipt = normalizeOfficialSubscriptionReceipt({ userId: '7', orderId: 23, outTradeNo: 'trade-23', planId: 'pro5x', amount: 100 })
  let saved = []
  let verified = ''
  const context = loadFunctions(vuePath, ['resumePendingOfficialSubscriptionOrders'], {
    authToken: ref('auth'), authUser: ref({ id: 7 }), officialSubscriptionRecoveryInFlight: false,
    pendingOfficialSubscriptionReceipts: () => [receipt], loadOfficialSubscriptionRecoveryOrders: async () => {},
    verifyPaymentOrderByOutTradeNo: async (trade) => { verified = trade; throw Error('offline') },
    isPaymentCompleted: () => false, isPaymentClosed: () => false, isOfficialSubscriptionPaidOrder,
    OFFICIAL_SUBSCRIPTION_RECEIPTS_STORAGE_KEY: 'test', writeStoredInvoiceArray: (_, items) => { saved = items },
    listOfficialSubscriptionsFromSoftwareAdmin: async () => [], officialSubscriptionOwnerParams: () => ({ userId: '7' }),
    normalizeOfficialSubscriptionRecordFromSoftwareAdmin: () => null, mergeOfficialSubscriptionRecords: noop,
    reportPageError: noop,
  })
  await context.functions.resumePendingOfficialSubscriptionOrders()
  assert.equal(verified, 'trade-23')
  assert.equal(saved[0], receipt)
  assert.equal(context.officialSubscriptionRecoveryInFlight, false)
})

test('recovery queries server orders even when the old client left no local receipt', async () => {
  let recoveryQueries = 0
  let recordQueries = 0
  const context = loadFunctions(vuePath, ['resumePendingOfficialSubscriptionOrders'], {
    authToken: ref('auth'), authUser: ref({ id: 7 }), officialSubscriptionRecoveryInFlight: false,
    pendingOfficialSubscriptionReceipts: () => [],
    loadOfficialSubscriptionRecoveryOrders: async () => { recoveryQueries++ },
    OFFICIAL_SUBSCRIPTION_RECEIPTS_STORAGE_KEY: 'test', writeStoredInvoiceArray: noop,
    listOfficialSubscriptionsFromSoftwareAdmin: async () => { recordQueries++; return [] },
    officialSubscriptionOwnerParams: () => ({ userId: '7' }),
    normalizeOfficialSubscriptionRecordFromSoftwareAdmin: () => null, mergeOfficialSubscriptionRecords: noop,
    reportPageError: noop,
  })
  await context.functions.resumePendingOfficialSubscriptionOrders()
  assert.equal(recoveryQueries, 1)
  assert.equal(recordQueries, 1)
})

test('missing Session recovery uses explicit server evidence and excludes completed/refunded orders', async () => {
  const orders = [
    { id: 23, order_type: 'official_sub', status: 'PAID', official_session_saved: false },
    { id: 24, order_type: 'official_sub', status: 'FAILED', paid_at: '2026-09-30', official_session_saved: false },
    { id: 25, order_type: 'official_sub', status: 'PAID', official_session_saved: true },
    { id: 26, order_type: 'official_sub', status: 'PAID' },
    { id: 27, order_type: 'official_sub', status: 'COMPLETED', official_session_saved: false },
    { id: 28, order_type: 'official_sub', status: 'REFUNDED', official_session_saved: false },
    { id: 29, order_type: 'balance', status: 'PAID', official_session_saved: false },
  ]
  const context = loadFunctions(vuePath, ['loadOfficialSubscriptionRecoveryOrders'], {
    authToken: ref('auth'), authUser: ref({ id: 7 }), officialSubscriptionRecoveryOrders: ref([]),
    listAllPaymentOrders: async () => orders,
    isOfficialSubscriptionPaidOrder, isPaymentCompleted: (status) => status === 'COMPLETED',
  })
  await context.functions.loadOfficialSubscriptionRecoveryOrders()
  assert.deepEqual(Array.from(context.officialSubscriptionRecoveryOrders.value, (order) => order.id), [23, 24])
  context.listAllPaymentOrders = async () => { context.authUser.value = { id: 8 }; return orders }
  context.officialSubscriptionRecoveryOrders.value = []
  await context.functions.loadOfficialSubscriptionRecoveryOrders()
  assert.equal(context.officialSubscriptionRecoveryOrders.value.length, 0)
})

function uploadHarness(primary) {
  const state = { ownerId: '7', orderId: 23, planId: 'pro5x', planName: 'Pro 5x', account: account.email, sessionJson: account.sessionJson }
  const calls = []
  const context = loadFunctions(vuePath, ['submitOfficialSubscriptionSessionForOrder'], {
    activeOfficialSubscriptionRequest: ref(state), authToken: ref('auth'), authUser: ref({ id: 7 }),
    officialSubscriptionOwnerParams: () => ({ userId: '7', email: 'payer@example.test', username: 'payer' }),
    getPaymentOrderId: (order) => order?.id || 0,
    getPaymentOrderTime: () => '2026-09-30T00:00:00Z', getPaymentOrderAmount: (order) => order.amount,
    deliverOfficialSubscriptionSession, updateVersionText: ref('1.5.9'),
    submitOfficialSubscriptionSession: async (...args) => { calls.push(['primary', ...args]); return primary(...args) },
    submitOfficialSubscriptionToSoftwareAdmin: async (...args) => { calls.push(['fallback', ...args]); return { request: { hasSessionText: true } } },
    rememberOfficialSubscriptionReceipt: () => calls.push(['receipt']),
  })
  return { context, calls }
}

test('account switch during upload cannot send an old Session through a new account fallback', async () => {
  let rejectPrimary
  const { context, calls } = uploadHarness(() => new Promise((_, reject) => { rejectPrimary = reject }))
  const upload = context.functions.submitOfficialSubscriptionSessionForOrder({ id: 23, amount: 100, status: 'PAID', official_session_saved: false })
  context.authUser.value = { id: 8 }
  context.authToken.value = 'another-auth'
  context.activeOfficialSubscriptionRequest.value = null
  rejectPrimary(new Error('timeout'))
  assert.equal(await upload, false)
  assert.deepEqual(calls.map((call) => call[0]), ['primary'])
  assert.equal(calls[0][3], 'auth')
})

test('late primary acceptance cannot save an order receipt under another account', async () => {
  let resolvePrimary
  const { context, calls } = uploadHarness(() => new Promise((resolve) => { resolvePrimary = resolve }))
  const upload = context.functions.submitOfficialSubscriptionSessionForOrder({ id: 23, amount: 100, status: 'PAID' })
  context.authUser.value = { id: 8 }
  context.authToken.value = 'another-auth'
  resolvePrimary({ saved: true })
  assert.equal(await upload, false)
  assert.deepEqual(calls.map((call) => call[0]), ['primary'])
})

test('server missing Session cannot be overridden by a stale local saved-order marker', async () => {
  const { context, calls } = uploadHarness(async () => ({ submitted: true }))
  context.officialSubscriptionSavedOrderIds = new Set([23])
  assert.equal(await context.functions.submitOfficialSubscriptionSessionForOrder({ id: 23, amount: 0, status: 'PAID', official_session_saved: false }), true)
  assert.deepEqual(calls.map((call) => call[0]), ['primary', 'receipt'])
})

test('an existing account subscription cannot hide a missing Session on a renewal order', () => {
  const context = loadFunctions(vuePath, ['isOfficialSubscriptionRecordCompleted'], {
    managedAccounts: ref([{ account: { hasActiveSubscription: true } }]),
  })
  assert.equal(context.functions.isOfficialSubscriptionRecordCompleted({ hasSessionText: false }), false)
})
