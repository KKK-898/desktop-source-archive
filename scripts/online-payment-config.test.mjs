import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed, ref, watch } from 'vue'
import { requireMatchingRechargeReceipt, requireOnlinePaymentConfig, sameRechargeQuote } from '../src/online-payment-config.ts'

const noop = () => {}
const plan = (overrides = {}) => ({ id: 'recharge-60', enabled: true, sort: 1, payAmount: 20, baseCreditAmount: 60, bonusAmount: 5, creditAmount: 65, ...overrides })
const config = (overrides = {}) => ({ configured: true, enabled: true, balanceRechargeMultiplier: 3, plans: [plan()], ...overrides })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const coreReceipt = ({ sub2OrderId, snapshot }) => ({
  orderId: sub2OrderId,
  snapshot: {
    plan_id: snapshot.planId, pay_amount: snapshot.payAmount, base_credit_amount: snapshot.baseCreditAmount,
    bonus_amount: snapshot.bonusAmount, total_credit_amount: snapshot.totalCreditAmount,
  },
})
const tick = () => new Promise((resolve) => setImmediate(resolve))

// Run the production Vue declarations, including its auth watcher, with only I/O replaced.
const text = readFileSync(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
const script = text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('payment.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = [
  'selectedRechargePlanId', 'onlinePaymentConfig', 'isOnlinePaymentConfigLoading', 'onlinePaymentConfigError',
  'isRechargeLoading', 'rechargeError', 'rechargeNotice', 'activeRechargeFeedback', 'activePaymentPurpose',
  'activePaymentOrder', 'activePaymentCreditAmount', 'activeRechargeSnapshot', 'paymentQrCode', 'externalPaymentPageUrl',
  'onlinePaymentConfigRequestGeneration', 'onlinePaymentConfigRequest',
  'rechargePlans', 'onlinePaymentConfigMessage', 'rechargeOptions', 'selectedRechargeOption',
  'getOnlinePaymentRequestContext', 'invalidateOnlinePaymentConfig', 'loadOnlinePaymentConfig',
  'isOnlinePaymentPage', 'refreshOnlinePaymentConfigInBackground',
  'selectRechargeOption', 'formatRechargeAmount', 'getRechargeQuote', 'buildOnlinePaymentSnapshot', 'submitRecharge',
]
const declarations = source.statements.filter((node) => (
  ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.includes(item.name.getText(source))) ||
  ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(source) === 'watch' && node.expression.arguments[0]?.getText(source) === 'authToken'
))
const compiled = ts.transpileModule(`${declarations.map((node) => node.getText(source)).join('\n')}\nglobalThis.payment = { ${names.join(',')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function harness() {
  const requests = [], orders = [], snapshots = [], rendered = [], cancelled = [], bonusJobs = []
  const runtime = { selectedServerId: 'primary', softwareAdminApiBaseUrl: 'https://admin.test/api', apiBaseUrl: 'https://api.test/api/v1' }
  const context = vm.createContext({
    ref, computed, watch, requireMatchingRechargeReceipt, requireOnlinePaymentConfig, sameRechargeQuote,
    authToken: ref('test-auth'), authUser: ref({ id: 7, email: 'user@example.test' }), user: ref({ name: 'test' }),
    activePage: ref('在线充值-兑换'), getRuntimeDomainConfig: () => runtime,
    formatCny: (value) => `¥${value.toFixed(2)}`,
    getOnlinePaymentConfigFromSoftwareAdmin: (...args) => {
      const request = deferred()
      requests.push({ ...request, args })
      return request.promise
    },
    getErrorMessage: (error) => error.message, getPaymentErrorMessage: (error) => error.message,
    clearPaymentPanelDismissTimer: noop, stopPaymentPolling: noop, reportPageError: noop,
    createPaymentOrder: async (amount, token, options) => { const order = { id: orders.length + 1, amount, token, options }; orders.push(order); return order },
    getPaymentOrderId: (order) => order?.id || 0,
    registerOnlinePaymentOrderSnapshot: async (payload) => { snapshots.push(payload); return coreReceipt(payload) },
    cancelPaymentOrder: async (orderId, token) => { cancelled.push({ orderId, token }) },
    enqueuePendingRechargeBonusJob: (...args) => { bonusJobs.push(args) }, renderPaymentOrder: async (order) => { rendered.push(order) }, loadRechargeHistory: noop,
  })
  vm.runInContext(compiled, context)
  return { ...context.payment, context, runtime, requests, orders, snapshots, rendered, cancelled, bonusJobs }
}

async function settleRead(h, value = config()) {
  const pending = h.loadOnlinePaymentConfig({ silent: true })
  await Promise.resolve()
  h.requests.at(-1).resolve(value)
  await pending
}

test('only complete server quotes are accepted, including legacy responses without configured', () => {
  assert.equal(requireOnlinePaymentConfig(config()).plans[0].creditAmount, 65)
  const legacy = config()
  delete legacy.configured
  assert.equal(requireOnlinePaymentConfig(legacy).plans[0].payAmount, 20)
  for (const invalid of [null, {}, config({ configured: false }), config({ enabled: 'true' }), config({ balanceRechargeMultiplier: 0 }), config({ plans: null })]) {
    assert.throws(() => requireOnlinePaymentConfig(invalid))
  }
  for (const invalidPlan of [plan({ payAmount: NaN }), plan({ payAmount: '20' }), plan({ payAmount: 20.001 }), plan({ bonusAmount: -1 }), plan({ creditAmount: 64 }), plan({ baseCreditAmount: 61, creditAmount: 66 }), plan({ id: '' }), plan({ enabled: undefined })]) {
    assert.throws(() => requireOnlinePaymentConfig(config({ plans: [invalidPlan] })))
  }
  assert.throws(() => requireOnlinePaymentConfig(config({ plans: [plan(), plan()] })))
  assert.equal(requireOnlinePaymentConfig(config({ enabled: false })).plans.length, 0)
  assert.equal(requireOnlinePaymentConfig(config({ plans: [plan({ enabled: false })] })).plans.length, 0)
})

test('first load, failure, recovery, and later failure never expose local or retained purchasable prices', async () => {
  const h = harness()
  assert.equal(h.rechargeOptions.value.length, 0)
  assert.equal(h.selectedRechargeOption.value.id, '')
  const initial = h.loadOnlinePaymentConfig({ silent: true })
  assert.equal(h.isOnlinePaymentConfigLoading.value, true)
  assert.match(h.onlinePaymentConfigMessage.value, /正在读取/)
  await Promise.resolve()
  h.requests[0].reject(Error('simulated offline'))
  await initial
  assert.equal(h.rechargeOptions.value.length, 0)
  assert.match(h.onlinePaymentConfigMessage.value, /读取失败/)
  await settleRead(h)
  assert.equal(h.selectedRechargeOption.value.payAmount, 20)
  assert.equal(h.selectedRechargeOption.value.creditAmount, 65)
  assert.equal(h.onlinePaymentConfigMessage.value, '')
  const retry = h.loadOnlinePaymentConfig({ silent: true })
  assert.equal(h.onlinePaymentConfigMessage.value, '') // quiet background refresh
  await Promise.resolve()
  h.requests.at(-1).reject(Error('offline again'))
  await retry
  assert.equal(h.selectedRechargeOption.value.id, '')
  assert.equal(h.rechargePlans.value.length, 0)
  assert.equal(h.isOnlinePaymentConfigLoading.value, false)
  await h.submitRecharge()
  assert.equal(h.orders.length, 0)
})

test('disabled, empty, unconfigured and malformed server responses all close checkout', async () => {
  for (const value of [config({ enabled: false }), config({ plans: [] }), config({ configured: false }), config({ plans: [plan({ creditAmount: 999 })] })]) {
    const h = harness()
    await settleRead(h, value)
    assert.equal(h.selectedRechargeOption.value.id, '')
    assert.ok(h.onlinePaymentConfigMessage.value)
    await h.submitRecharge()
    assert.equal(h.orders.length, 0)
  }
})

test('background reads are shared and stale success/failure cannot overwrite a newer forced read', async () => {
  for (const oldFails of [false, true]) {
    const h = harness()
    const oldRead = h.loadOnlinePaymentConfig({ silent: true })
    const sharedRead = h.loadOnlinePaymentConfig({ silent: true })
    await Promise.resolve()
    assert.equal(h.requests.length, 1)
    const newRead = h.loadOnlinePaymentConfig({ silent: true, force: true })
    await Promise.resolve()
    h.requests[1].resolve(config())
    await newRead
    if (oldFails) h.requests[0].reject(Error('late failure'))
    else h.requests[0].resolve(config({ plans: [plan({ payAmount: 25, baseCreditAmount: 75, creditAmount: 80 })] }))
    await Promise.all([oldRead, sharedRead])
    assert.equal(h.selectedRechargeOption.value.payAmount, 20)
    assert.equal(h.onlinePaymentConfigMessage.value, '')
    assert.equal(h.isOnlinePaymentConfigLoading.value, false)
  }
})

test('login/token replacement starts a fresh read and rejects prior account responses', async () => {
  const h = harness()
  const oldRead = h.loadOnlinePaymentConfig({ silent: true })
  await Promise.resolve()
  h.context.authToken.value = 'new-auth' // production synchronous watcher invalidates the old request
  await Promise.resolve()
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].args[0], 'new-auth')
  const newRead = h.loadOnlinePaymentConfig({ silent: true })
  h.requests[1].resolve(config())
  await newRead
  h.requests[0].resolve(config({ enabled: false }))
  await oldRead
  assert.equal(h.selectedRechargeOption.value.payAmount, 20)
  h.context.authToken.value = ''
  assert.equal(h.rechargeOptions.value.length, 0)
  assert.match(h.onlinePaymentConfigMessage.value, /先登录/)
})

test('changed server context rejects the old response even before its UI event arrives', async () => {
  const h = harness()
  const oldRead = h.loadOnlinePaymentConfig({ silent: true })
  await Promise.resolve()
  h.runtime.selectedServerId = 'backup'
  const newRead = h.loadOnlinePaymentConfig({ silent: true })
  await Promise.resolve()
  h.requests[1].resolve(config())
  await newRead
  h.requests[0].resolve(config({ enabled: false }))
  await oldRead
  assert.equal(h.selectedRechargeOption.value.payAmount, 20)
})

test('an older completion cannot unlock checkout while the newer configuration is still loading', async () => {
  const h = harness()
  const oldRead = h.loadOnlinePaymentConfig({ silent: true })
  await Promise.resolve()
  const newRead = h.loadOnlinePaymentConfig({ silent: true, force: true })
  await Promise.resolve()
  h.requests[0].resolve(config())
  await oldRead
  assert.equal(h.isOnlinePaymentConfigLoading.value, true)
  assert.equal(h.selectedRechargeOption.value.id, '')
  h.requests[1].resolve(config())
  await newRead
  assert.equal(h.isOnlinePaymentConfigLoading.value, false)
})

test('checkout refresh failure closes purchase without creating an order', async () => {
  const h = harness()
  await settleRead(h)
  const checkout = h.submitRecharge()
  await Promise.resolve()
  h.requests.at(-1).reject(Error('configuration unavailable'))
  await checkout
  assert.equal(h.orders.length, 0)
  assert.equal(h.selectedRechargeOption.value.id, '')
  assert.match(h.rechargeError.value, /读取失败/)
})

test('account replacement during checkout cannot charge the old or new account', async () => {
  const h = harness()
  await settleRead(h)
  const checkout = h.submitRecharge()
  await Promise.resolve()
  h.context.authToken.value = 'other-account'
  await Promise.resolve()
  h.requests[1].resolve(config())
  await checkout
  assert.equal(h.orders.length, 0)
  const replacementRead = h.loadOnlinePaymentConfig({ silent: true })
  h.requests[2].resolve(config())
  await replacementRead
  assert.equal(h.selectedRechargeOption.value.payAmount, 20)
})

test('price, multiplier/credit, bonus changes and removed plans require another explicit checkout', async () => {
  for (const value of [
    config({ plans: [plan({ payAmount: 30, baseCreditAmount: 90, creditAmount: 95 })] }),
    config({ balanceRechargeMultiplier: 4, plans: [plan({ baseCreditAmount: 80, creditAmount: 85 })] }),
    config({ plans: [plan({ bonusAmount: 10, creditAmount: 70 })] }),
    config({ plans: [plan({ id: 'replacement' })] }),
    config({ enabled: false }), config({ plans: [] }), config({ plans: [plan({ enabled: false })] }),
  ]) {
    const h = harness()
    await settleRead(h)
    const checkout = h.submitRecharge()
    await Promise.resolve()
    h.requests.at(-1).resolve(value)
    await checkout
    assert.equal(h.orders.length, 0)
    assert.match(h.rechargeNotice.value, /重新选择并支付/)
    if (h.selectedRechargeOption.value.id) {
      const confirmed = h.submitRecharge()
      await Promise.resolve()
      h.requests.at(-1).resolve(value)
      await confirmed
      assert.equal(h.orders.length, 1)
      assert.equal(h.orders[0].amount, value.plans[0].payAmount)
    }
  }
})

test('quote equality compares every displayed payment/credit amount', () => {
  for (const field of ['payAmount', 'baseCreditAmount', 'bonusAmount', 'creditAmount']) {
    assert.equal(sameRechargeQuote(plan(), plan({ [field]: plan()[field] + 1 })), false)
  }
  assert.equal(sameRechargeQuote(plan(), plan()), true)
})

test('double clicks and the periodic poll cannot create extra requests/orders during checkout', async () => {
  const h = harness()
  await settleRead(h)
  const checkout = h.submitRecharge()
  const duplicate = h.submitRecharge()
  await h.refreshOnlinePaymentConfigInBackground()
  await Promise.resolve()
  assert.equal(h.requests.length, 2)
  h.selectRechargeOption({ id: 'different' })
  assert.equal(h.selectedRechargePlanId.value, 'recharge-60')
  h.requests[1].resolve(config())
  await Promise.all([checkout, duplicate])
  assert.equal(h.orders.length, 1)
  assert.equal(h.orders[0].amount, 20)
  assert.equal(h.orders[0].options.onlinePaymentPlanId, 'recharge-60')
  assert.deepEqual(Object.keys(h.orders[0].options), ['onlinePaymentPlanId'])
  assert.equal(h.snapshots[0].snapshot.totalCreditAmount, 65)
  assert.equal(h.rendered.length, 1)
  assert.equal(h.isRechargeLoading.value, false)
})

test('checkout supersedes an older in-flight background refresh', async () => {
  const h = harness()
  await settleRead(h)
  const background = h.loadOnlinePaymentConfig({ silent: true })
  await Promise.resolve()
  const checkout = h.submitRecharge()
  await Promise.resolve()
  assert.equal(h.requests.length, 3)
  h.requests[2].resolve(config())
  await checkout
  h.requests[1].reject(Error('late background failure'))
  await background
  assert.equal(h.orders.length, 1)
  assert.equal(h.selectedRechargeOption.value.payAmount, 20)
  assert.equal(h.onlinePaymentConfigMessage.value, '')
})

test('empty, incomplete, inconsistent and wrong-order receipts cannot confirm a quote', () => {
  const snapshot = { planId: 'recharge-60', payAmount: 20, baseCreditAmount: 60, bonusAmount: 5, totalCreditAmount: 65 }
  const valid = coreReceipt({ sub2OrderId: 1, snapshot })
  assert.deepEqual(requireMatchingRechargeReceipt(valid, snapshot, 1), snapshot)
  assert.deepEqual(requireMatchingRechargeReceipt({ record: snapshot }, snapshot, 1), snapshot)
  for (const value of [undefined, {}, { record: {} }, { ...valid, orderId: 2 },
    { snapshot: { ...valid.snapshot, bonus_amount: undefined } },
    { snapshot: { ...valid.snapshot, total_credit_amount: 70 } },
    { snapshot: { ...valid.snapshot, bonusAmount: 10 } },
  ]) assert.throws(() => requireMatchingRechargeReceipt(value, snapshot, 1))
})

test('missing confirmation or a changed bonus cancels the order before exposing any payment link', async () => {
  for (const registration of [undefined, {}, { record: {} }, { record: { planId: 'recharge-60', payAmount: 20, baseCreditAmount: 60, bonusAmount: 10, totalCreditAmount: 70 } }]) {
    const h = harness()
    await settleRead(h)
    h.context.registerOnlinePaymentOrderSnapshot = async (payload) => { h.snapshots.push(payload); return registration }
    const checkout = h.submitRecharge()
    await Promise.resolve()
    h.requests[1].resolve(config())
    await tick()
    assert.equal(h.cancelled.length, 1)
    assert.deepEqual(h.cancelled[0], { orderId: 1, token: 'test-auth' })
    assert.equal(h.requests.length, 3)
    h.requests[2].resolve(config({ plans: [plan({ bonusAmount: 10, creditAmount: 70 })] }))
    await checkout
    assert.equal(h.selectedRechargeOption.value.creditAmount, 70)
    assert.equal(h.rendered.length, 0)
    assert.equal(h.bonusJobs.length, 0)
    assert.equal(h.activeRechargeSnapshot.value, null)
    assert.equal(h.paymentQrCode.value, '')
    assert.equal(h.externalPaymentPageUrl.value, '')
    assert.match(h.rechargeError.value, /重新确认.*已取消/)
  }
})

test('legacy Admin receipts with all confirmed amounts still allow checkout', async () => {
  const h = harness()
  await settleRead(h)
  h.context.registerOnlinePaymentOrderSnapshot = async (payload) => ({ record: { ...payload.snapshot, sub2OrderId: String(payload.sub2OrderId) } })
  const checkout = h.submitRecharge()
  await Promise.resolve()
  h.requests[1].resolve(config())
  await checkout
  assert.equal(h.rendered.length, 1)
  assert.equal(h.cancelled.length, 0)
  assert.equal(h.activeRechargeSnapshot.value.totalCreditAmount, 65)
})

test('failed cancellation still keeps an unconfirmed order hidden and reports the unresolved cancellation', async () => {
  const h = harness()
  await settleRead(h)
  h.context.getOnlinePaymentConfigFromSoftwareAdmin = async () => config()
  h.context.registerOnlinePaymentOrderSnapshot = async () => ({})
  h.context.cancelPaymentOrder = async () => { throw Error('cancel unavailable') }
  await h.submitRecharge()
  assert.equal(h.rendered.length, 0)
  assert.equal(h.bonusJobs.length, 0)
  assert.equal(h.paymentQrCode.value, '')
  assert.equal(h.externalPaymentPageUrl.value, '')
  assert.match(h.rechargeError.value, /取消尚未确认/)
  assert.equal(h.isRechargeLoading.value, false)
})

test('account or route replacement during create/register cancels with the captured token and never renders', async () => {
  for (const phase of ['create', 'register']) {
    for (const change of ['account', 'route']) {
      const h = harness()
      await settleRead(h)
      h.context.getOnlinePaymentConfigFromSoftwareAdmin = async () => config()
      const pending = deferred()
      let payload
      if (phase === 'create') h.context.createPaymentOrder = async (amount, token) => { h.orders.push({ id: 1, amount, token }); return pending.promise }
      else h.context.registerOnlinePaymentOrderSnapshot = async (value) => { payload = value; h.snapshots.push(value); return pending.promise }
      const checkout = h.submitRecharge()
      await tick()
      if (change === 'account') h.context.authToken.value = 'different-account'
      else h.runtime.selectedServerId = 'backup'
      pending.resolve(phase === 'create' ? { id: 1, amount: 20 } : coreReceipt(payload))
      await checkout
      assert.deepEqual(h.cancelled, [{ orderId: 1, token: 'test-auth' }])
      assert.equal(h.rendered.length, 0)
      assert.equal(h.bonusJobs.length, 0)
      if (phase === 'create') assert.equal(h.snapshots.length, 0)
      assert.match(h.rechargeError.value, /已切换.*已取消/)
    }
  }
})
