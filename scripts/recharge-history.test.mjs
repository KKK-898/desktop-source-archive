import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'

const text = readFileSync(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
const script = text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('history.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const noop = () => {}
const completed = (overrides = {}) => ({
  id: 42, amount: 60, pay_amount: 20, order_type: 'balance', status: 'COMPLETED',
  paid_at: '2026-09-28T10:00:00Z', ...overrides,
})
const gift = (overrides = {}) => ({
  id: 84, code: 'bonus-42', type: 'balance_bonus', value: 5, status: 'used',
  used_at: '2026-09-28T10:01:00Z', ...overrides,
})
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

function loadDeclarations(names, exports, bindings, declarationSource = source) {
  const declarations = declarationSource.statements.filter((node) => (
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.includes(item.name.getText(declarationSource)))
  ))
  const compiled = ts.transpileModule(`${declarations.map((node) => node.getText(declarationSource)).join('\n')}
globalThis.subject = { ${exports.join(',')} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const context = vm.createContext({ exports: {}, ...bindings })
  vm.runInContext(compiled, context)
  return { context, ...context.subject }
}

function historyHarness() {
  const requests = []
  const runtime = { selectedServerId: 'primary', apiBaseUrl: 'https://api.test/api/v1', softwareAdminApiBaseUrl: 'https://admin.test/api' }
  const names = [
    'rechargeHistoryOrders', 'rechargeHistoryRedeems', 'rechargeHistoryError', 'isRechargeHistoryLoading',
    'rechargeHistoryRequestGeneration', 'balanceHistoryRows', 'rechargePaymentHistoryRows',
    'formatRechargeHistoryAmount', 'rechargeHistoryStatusClass', 'rechargeHistoryStatusText',
    'getRechargeHistoryCreditAmount', 'getRechargeHistoryBonusAmount', 'toRechargeOrderHistoryRow',
    'paymentHistorySourceText', 'toRechargePaymentHistoryRow', 'redeemHistorySourceText', 'toRechargeRedeemHistoryRow',
    'getPaymentOrderId', 'getPaymentOrderAmount', 'getPaymentOrderRechargeAmount',
    'getOnlinePaymentRequestContext', 'loadRechargeHistory', 'listAllPaymentOrders',
  ]
  const exported = names.filter((name) => !['getRechargeHistoryBonusAmount', 'rechargeHistoryRequestGeneration'].includes(name))
  const h = loadDeclarations(names, exported, {
    ref: Vue.ref, computed: Vue.computed, authToken: Vue.ref('account-a'),
    getRuntimeDomainConfig: () => runtime,
    parseTimestampMillis: (value) => Date.parse(value),
    formatFullTime: (value) => value || '-',
    formatRechargeAmount: (value) => String(value), formatCny: (value) => `¥${value.toFixed(2)}`,
    isPaymentCompleted: (status) => status === 'COMPLETED',
    // Changing today's quote must not recalculate a historical gift or credit.
    rechargePlans: Vue.ref([{ payAmount: 20, baseCreditAmount: 90, bonusAmount: 999, creditAmount: 1089 }]),
    onlinePaymentConfig: Vue.ref({ balanceRechargeMultiplier: 9 }), getRechargeQuote: (plan) => plan,
    listPaymentOrders: (token, options) => {
      const request = { ...deferred(), kind: options.orderType, token, options }
      requests.push(request)
      return request.promise
    },
    listRedeemHistory: (token, options) => {
      const request = { ...deferred(), kind: 'redeem', token, options }
      requests.push(request)
      return request.promise
    },
    reportPageError: noop,
  })
  return { ...h, requests, runtime }
}

function resolveHistoryBatch(requests, orders, redeems = []) {
  for (const request of requests) {
    request.resolve(request.kind === 'redeem' ? redeems : {
      items: request.kind === 'balance' ? orders : [], pages: 1, total: orders.length,
    })
  }
}

test('a completed recharge keeps cash and base credit separate from the actually applied gift', () => {
  const h = historyHarness()
  const row = h.toRechargeOrderHistoryRow(completed({ bonus_amount: 5, bonus_applied_at: gift().used_at }))
  assert.equal(row.rechargeAmount, '¥20.00')
  assert.equal(row.creditAmount, '+60刀')
  assert.equal(row.bonusAmount, '+5刀')
  assert.equal(row.bonusAppliedAt, gift().used_at)
  assert.equal(h.toRechargeOrderHistoryRow(completed({ bonus_amount: 5 })).bonusAmount, '+5刀')
})

test('legacy, zero, invalid and promised-only bonuses do not appear or use current package prices', () => {
  const h = historyHarness()
  for (const bonus_amount of [undefined, null, 0, -5, NaN, Infinity, '5', true]) {
    const row = h.toRechargeOrderHistoryRow(completed({
      bonus_amount, bonus_applied_at: gift().used_at,
      provider_snapshot: { online_payment: { bonus_amount: 999 } },
    }))
    assert.equal(row.bonusAmount, '')
    assert.equal(row.bonusAppliedAt, '')
    assert.equal(row.creditAmount, '+60刀')
  }
  assert.equal(h.toRechargeOrderHistoryRow(completed({ status: 'PENDING', bonus_amount: 5 })), null)
  assert.equal(h.toRechargeOrderHistoryRow(completed({ order_type: 'platform_sub', bonus_amount: 5 })), null)
  assert.equal(h.getRechargeHistoryCreditAmount(completed({ amount: undefined })), 0)
})

test('positive balance_bonus ledger entries become gifts, not adjustments or concurrency', () => {
  const h = historyHarness()
  const row = h.toRechargeRedeemHistoryRow(gift())
  assert.equal(row.source, '赠送')
  assert.equal(row.kind, 'bonus')
  assert.equal(row.added, '+5刀')
  assert.equal(row.time, gift().used_at)
  assert.equal(row.status, '成功')
  assert.equal(h.toRechargeRedeemHistoryRow(gift({ type: 'admin_balance' })).source, '后台调整')
  assert.equal(h.toRechargeRedeemHistoryRow(gift({ type: 'balance' })).source, '卡密兑换')
  assert.equal(h.toRechargeRedeemHistoryRow(gift({ type: 'concurrency' })), null)
  for (const value of [0, -5, NaN, Infinity]) assert.equal(h.toRechargeRedeemHistoryRow(gift({ value })), null)
  assert.equal(h.toRechargeRedeemHistoryRow(gift({ status: 'pending' })), null)
})

test('credit history creates a gift only from its ledger, never again from the payment order', () => {
  const h = historyHarness()
  h.rechargeHistoryOrders.value = [completed({ bonus_amount: 5 })]
  h.rechargeHistoryRedeems.value = [gift()]
  assert.equal(h.balanceHistoryRows.value.length, 2)
  assert.equal(h.balanceHistoryRows.value.filter((row) => row.kind === 'bonus').length, 1)
  assert.equal(h.balanceHistoryRows.value.find((row) => row.source === '在线支付').added, '+60刀')
  assert.equal(h.rechargePaymentHistoryRows.value.length, 1)
})

test('a late pre-bonus history response cannot replace the refreshed settled gift', async () => {
  const h = historyHarness()
  const oldLoad = h.loadRechargeHistory()
  assert.equal(h.requests[2].options.includeBalanceBonus, true)
  const oldRequests = h.requests.slice()
  const newLoad = h.loadRechargeHistory({ silent: true })
  resolveHistoryBatch(h.requests.slice(3), [completed({ bonus_amount: 5 })], [gift()])
  await newLoad
  assert.equal(h.rechargePaymentHistoryRows.value[0].bonusAmount, '+5刀')
  assert.equal(h.isRechargeHistoryLoading.value, false)
  resolveHistoryBatch(oldRequests, [completed()])
  await oldLoad
  assert.equal(h.rechargePaymentHistoryRows.value[0].bonusAmount, '+5刀')
  assert.equal(h.balanceHistoryRows.value.filter((row) => row.kind === 'bonus').length, 1)
})

test('an old response cannot clear the loading state or errors of a newer read', async () => {
  const h = historyHarness()
  const oldLoad = h.loadRechargeHistory()
  const newLoad = h.loadRechargeHistory()
  h.requests[0].reject(Error('old payment failure'))
  h.requests[1].resolve({ items: [], pages: 1 })
  h.requests[2].reject(Error('old ledger failure'))
  await oldLoad
  assert.equal(h.isRechargeHistoryLoading.value, true)
  assert.equal(h.rechargeHistoryError.value, '')
  resolveHistoryBatch(h.requests.slice(3), [completed({ bonus_amount: 5 })], [gift()])
  await newLoad
  assert.equal(h.isRechargeHistoryLoading.value, false)
  assert.equal(h.rechargeHistoryError.value, '')
})

test('old account and route responses cannot populate the new context', async () => {
  for (const change of ['account', 'route']) {
    const h = historyHarness()
    const pending = h.loadRechargeHistory()
    if (change === 'account') h.context.authToken.value = 'account-b'
    else h.runtime.selectedServerId = 'backup'
    resolveHistoryBatch(h.requests, [completed({ bonus_amount: 5 })], [gift()])
    await pending
    assert.equal(h.rechargeHistoryOrders.value.length, 0)
    assert.equal(h.rechargeHistoryRedeems.value.length, 0)
    assert.equal(h.isRechargeHistoryLoading.value, false)
  }
})

test('all pages in one history read use the captured authentication token', async () => {
  const h = historyHarness()
  const pending = h.loadRechargeHistory()
  const first = h.requests[0]
  h.context.authToken.value = 'account-b'
  first.resolve({ items: [completed()], pages: 2 })
  h.requests[1].resolve({ items: [], pages: 1 })
  h.requests[2].resolve([])
  await tick()
  assert.equal(h.requests[3].token, 'account-a')
  h.requests[3].resolve({ items: [], pages: 2 })
  await pending
  assert.equal(h.rechargeHistoryOrders.value.length, 0)
})

test('completed payment awaits bonus settlement and the subsequent history reload', async () => {
  const settlement = deferred(), reload = deferred(), events = []
  const bindings = {
    activePaymentOrder: Vue.ref(completed()), activePaymentPurpose: Vue.ref('recharge'),
    activeOfficialSubscriptionRequest: Vue.ref(null), authUser: Vue.ref({ id: 7 }), authToken: Vue.ref('test-auth'),
    paymentOrderRefreshInFlight: false, isPaymentRefreshing: Vue.ref(false),
    getPaymentOrderId: (order) => order?.id || 0, getPaymentOrder: async () => completed(),
    isPaymentCompleted: (status) => status === 'COMPLETED',
    stopPaymentPolling: noop, persistInvoiceOrder: noop, isBackupBridgePaymentOrder: () => false,
    applyRechargeBonusForOrder: async () => { events.push('bonus'); return settlement.promise },
    syncCurrentUser: async () => {}, syncUsageDashboardStats: async () => {},
    activeRechargeCreditAmount: Vue.ref(65), rechargeError: Vue.ref(''), rechargeNotice: Vue.ref(''),
    formatRechargeAmount: String, reportPageError: noop, getPaymentErrorMessage: (error) => error.message,
    isRechargeBonusRetryableError: () => true, schedulePendingRechargeBonusRetry: noop,
    loadRechargeHistory: async () => { events.push('history'); return reload.promise },
  }
  const h = loadDeclarations(['refreshActivePaymentOrder'], ['refreshActivePaymentOrder'], bindings)
  let completedRefresh = false
  const pending = h.refreshActivePaymentOrder().then(() => { completedRefresh = true })
  await tick()
  assert.deepEqual(events, ['bonus'])
  settlement.resolve({ applied: true, record: { bonusAmount: 5, totalCreditAmount: 65 } })
  await tick()
  assert.deepEqual(events, ['bonus', 'history'])
  assert.equal(completedRefresh, false)
  reload.resolve()
  await pending
  assert.equal(completedRefresh, true)
})

test('background bonus recovery also awaits the refreshed order and gift history', async () => {
  const settlement = deferred(), reload = deferred(), events = []
  const job = { orderId: 42, autoRetry: true, nextRetryAt: 0, snapshot: { bonusAmount: 5 } }
  const h = loadDeclarations(['resumePendingRechargeBonusQueue'], ['resumePendingRechargeBonusQueue'], {
    rechargeBonusQueueProcessing: false, authToken: Vue.ref('test-auth'), isNewThemeAuthenticated: Vue.ref(true),
    stopPendingRechargeBonusRetryTimer: noop, readPendingRechargeBonusJobs: () => [job],
    findPendingRechargeBonusJob: () => job, getPaymentOrder: async () => completed(),
    isBackupBridgePaymentOrder: () => false, isPaymentClosed: () => false, isPaymentCompleted: () => true,
    runRechargeBonusJob: async () => { events.push('bonus'); return settlement.promise },
    syncCurrentUser: async () => {}, syncUsageDashboardStats: async () => {},
    notify: noop, formatRechargeAmount: String, isOnlinePaymentPage: () => true,
    rechargeError: Vue.ref(''), rechargeNotice: Vue.ref(''),
    loadRechargeHistory: async () => { events.push('history'); return reload.promise },
    schedulePendingRechargeBonusRetry: noop,
  })
  const pending = h.resumePendingRechargeBonusQueue()
  await tick()
  assert.deepEqual(events, ['bonus'])
  settlement.resolve({ applied: true, record: { bonusAmount: 5 } })
  await tick()
  assert.deepEqual(events, ['bonus', 'history'])
  assert.equal(h.context.rechargeBonusQueueProcessing, true)
  reload.resolve()
  await pending
  assert.equal(h.context.rechargeBonusQueueProcessing, false)
})

test('API contracts send the selected package only for recharge and opt in to gift history explicitly', async () => {
  const apiSource = ts.createSourceFile('api.ts', readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls = []
  const h = loadDeclarations(['createPaymentOrder', 'listRedeemHistory'], ['createPaymentOrder', 'listRedeemHistory'], {
    createApiRequestId: () => 'stable-id', getPayOrigin: () => 'https://payment.test',
    apiRequest: async (...args) => { calls.push(args) },
  }, apiSource)
  await h.createPaymentOrder(20, 'test-auth', { onlinePaymentPlanId: 'recharge-60' })
  const payment = JSON.parse(calls.at(-1)[1].body)
  assert.equal(payment.amount, 20)
  assert.equal(payment.online_payment_plan_id, 'recharge-60')
  assert.equal(payment.order_type, 'balance')
  assert.equal(payment.payment_type, 'alipay')
  assert.equal(payment.bonus_amount, undefined)
  assert.equal(payment.bonus_history_version, undefined)
  await h.createPaymentOrder(20, 'test-auth')
  assert.equal(JSON.parse(calls.at(-1)[1].body).online_payment_plan_id, undefined)
  for (const orderType of ['subscription', 'platform_sub', 'official_sub']) {
    await h.createPaymentOrder(20, 'test-auth', { orderType, onlinePaymentPlanId: 'not-for-this-order' })
    assert.equal(JSON.parse(calls.at(-1)[1].body).online_payment_plan_id, undefined)
  }
  await h.listRedeemHistory('test-auth')
  assert.equal(calls.at(-1)[0], '/redeem/history')
  await h.listRedeemHistory('test-auth', { includeBalanceBonus: true })
  assert.equal(calls.at(-1)[0], '/redeem/history?include_balance_bonus=true')
  assert.equal(calls.at(-1)[1].method, 'GET')
})

const tableStart = text.indexOf('<div class="new-theme-recharge-history-table">')
const tableEnd = text.indexOf('<div v-if="rechargeHistoryTotal"', tableStart)
const table = text.slice(tableStart, tableEnd).trim()
const tableRender = new Function('Vue', compile(table, { mode: 'function', prefixIdentifiers: true }).code)(Vue)

async function renderHistory(h, tab) {
  return renderToString(Vue.createSSRApp({
    setup: () => ({
      activeRechargeHistoryTab: tab, pagedRechargePaymentHistoryRows: h.rechargePaymentHistoryRows.value,
      pagedBalanceHistoryRows: h.balanceHistoryRows.value, isRechargeHistoryLoading: false,
      rechargeHistoryTotal: 1, rechargeHistoryEmptyText: '',
    }),
    render: tableRender,
  }))
}

test('the production template renders distinct recharge and gift labels without fabricating legacy gifts', async () => {
  const h = historyHarness()
  h.rechargeHistoryOrders.value = [completed({ bonus_amount: 5, bonus_applied_at: gift().used_at })]
  h.rechargeHistoryRedeems.value = [gift()]
  const paid = await renderHistory(h, 'recharge')
  assert.match(paid, /充值 \+60刀/)
  assert.match(paid, /赠送 \+5刀/)
  assert.match(paid, /recharge-history-bonus/)
  const balance = await renderHistory(h, 'balance')
  assert.match(balance, /recharge-history-bonus/)
  assert.equal((balance.match(/赠送/g) || []).length, 1)
  h.rechargeHistoryOrders.value = [completed()]
  assert.doesNotMatch(await renderHistory(h, 'recharge'), /赠送/)
})
