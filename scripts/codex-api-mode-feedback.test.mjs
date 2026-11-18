import assert from 'node:assert/strict'
import test from 'node:test'
import { harness, tick, deferred } from './codex-account-route-harness.mjs'

// These subjects are extracted from the production Vue component by the
// shared harness. Only desktop RPC responses and elapsed time are synthetic.
const pendingApi = { requested: true, enabled: true, ready: false, verified: false, reason: 'awaiting-page' }
const verifiedApi = { requested: true, enabled: true, ready: true, verified: true, reason: 'coding' }
const disabled = { requested: false, enabled: false, ready: false, verified: false, reason: 'disabled' }
const pendingUltra = { requested: true, enabled: true, ready: false, verified: false, reason: 'awaiting-visible-picker' }
const verifiedUltra = { requested: true, enabled: true, ready: true, verified: true, reason: 'ready' }
const apiSuccess = /纯 API 登录已使用 Codex 编码模式/

function feedbackHarness(t, api = {}) {
  const h = harness({ api })
  const timers = new Map()
  let sequence = 0
  h.state.window.setTimeout = (callback, delay) => {
    assert.equal(delay, 2000, 'Production feedback checks retain the two-second interval and request deadline')
    timers.set(++sequence, callback)
    return sequence
  }
  h.state.window.clearTimeout = id => timers.delete(id)
  t.after(() => h.stopCodexUltraStatusCheck())
  return Object.assign(h, {
    timers,
    async advance() {
      const [id, callback] = timers.entries().next().value || []
      assert.ok(callback, 'Expected a scheduled runtime feedback check')
      timers.delete(id)
      callback()
      await tick()
    },
  })
}

test('API pending launch warnings disappear only after verified runtime feedback', async t => {
  const warning = '纯 API 编码模式正在验证，尚未确认生效。'
  const h = feedbackHarness(t, { getCodexApiModeStatus: async () => verifiedApi })
  h.showCodexLaunchFeedback({ launch: { apiMode: { ...pendingApi, warnings: [warning] }, warnings: [warning] } }, 'Codex 已重新打开。')
  assert.equal(h.state.toolNotices.value.codex, '')
  assert.match(h.state.toolWarnings.value.codex, /尚未确认生效/)
  await h.advance()
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.match(h.state.toolNotices.value.codex, apiSuccess)
  assert.doesNotMatch(h.state.toolNotices.value.codex, /正在验证|尚未确认/)
  assert.equal(h.timers.size, 0)
})

test('API mode independently polls when Ultra is disabled and its status RPC is absent', async t => {
  let reads = 0
  const h = feedbackHarness(t, { getCodexApiModeStatus: async () => { reads++; return verifiedApi } })
  h.showCodexLaunchFeedback({ ultra: disabled, apiMode: pendingApi }, 'Codex 已重新打开。')
  assert.equal(reads, 0)
  assert.equal(h.timers.size, 1)
  await h.advance()
  assert.equal(reads, 1)
  assert.match(h.state.toolNotices.value.codex, apiSuccess)
  assert.doesNotMatch(h.state.toolNotices.value.codex, /Ultra/)
  assert.equal(h.timers.size, 0)
})

test('unverified project scope stops API feedback polling without hiding the independent Ultra or Fast result', async t => {
  const api = { ...pendingApi, reason: 'unsupported-local-project-scope' }
  const fast = { enabled: true, ready: true, verified: true, compiled: true, reason: 'compiled' }
  const h = feedbackHarness(t, {
    getCodexApiModeStatus: async () => api,
    getCodexUltraStatus: async () => verifiedUltra,
  })
  h.showCodexLaunchFeedback({ ultra: pendingUltra, apiMode: pendingApi, nativeFast: fast }, 'Codex 已重新打开。')
  await h.advance()
  const warning = h.state.toolWarnings.value.codex
  assert.match(warning, /本次未改动项目分组/)
  assert.doesNotMatch(warning, /正在重试|正在验证|纯 API 登录已使用/)
  assert.match(warning, /Ultra 已通过本次检查/)
  assert.match(warning, /原生 Fast 入口已通过本次检查/)
  assert.equal(h.timers.size, 0)
  const feedback = h.codexApiModeFeedback({ apiMode: { ...api, error: 'private-path' } })
  assert.equal(feedback.pending, false)
  assert.doesNotMatch(feedback.warning, /private-path/)
})

test('a transient native project delay keeps polling and can later verify Coding', async t => {
  const h = feedbackHarness(t, { getCodexApiModeStatus: async () => verifiedApi })
  const apiMode = { ...pendingApi, reason: 'awaiting-native-local-projects' }
  assert.equal(h.codexApiModeFeedback({ apiMode }).pending, true)
  h.showCodexLaunchFeedback({ apiMode }, 'Codex 已重新打开。')
  await h.advance()
  assert.match(h.state.toolNotices.value.codex, apiSuccess)
  assert.equal(h.timers.size, 0)
})

test('verified API mode and Ultra results are combined after both current RPCs finish', async t => {
  const apiRead = deferred()
  let ultraReads = 0, apiReads = 0
  const h = feedbackHarness(t, {
    getCodexUltraStatus: async () => { ultraReads++; return verifiedUltra },
    getCodexApiModeStatus: async () => { apiReads++; return apiRead.promise },
  })
  h.showCodexLaunchFeedback({ ultra: pendingUltra, apiMode: pendingApi }, 'Codex 已重新打开。')
  await h.advance()
  assert.equal(ultraReads, 1)
  assert.equal(apiReads, 1)
  assert.doesNotMatch(h.state.toolNotices.value.codex, apiSuccess)
  apiRead.resolve(verifiedApi)
  await tick()
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.match(h.state.toolNotices.value.codex, /Ultra 已通过本次检查/)
  assert.match(h.state.toolNotices.value.codex, apiSuccess)
  assert.equal(h.timers.size, 0)
})

test('an API status rejection cannot turn a successful Ultra check into API success', async t => {
  const h = feedbackHarness(t, {
    getCodexUltraStatus: async () => verifiedUltra,
    getCodexApiModeStatus: async () => { throw Error('synthetic-private-RPC-diagnostic') },
  })
  h.showCodexLaunchFeedback({ ultra: pendingUltra, apiMode: pendingApi }, 'Codex 已重新打开。')
  await h.advance()
  assert.equal(h.state.toolNotices.value.codex, '')
  assert.match(h.state.toolWarnings.value.codex, /纯 API.*尚未确认生效/)
  assert.doesNotMatch(h.state.toolWarnings.value.codex, apiSuccess)
  assert.doesNotMatch(h.state.toolWarnings.value.codex, /synthetic-private-RPC-diagnostic/)
  assert.equal(h.timers.size, 0)
})

for (const response of [null, undefined]) {
  test(`an empty API status response (${response}) cannot clear pending verification`, async t => {
    const h = feedbackHarness(t, { getCodexApiModeStatus: async () => response })
    h.showCodexLaunchFeedback({ ultra: disabled, apiMode: pendingApi }, 'Codex 已重新打开。')
    await h.advance()
    assert.equal(h.state.toolNotices.value.codex, '')
    assert.match(h.state.toolWarnings.value.codex, /纯 API.*尚未确认生效/)
    assert.doesNotMatch(h.state.toolWarnings.value.codex, apiSuccess)
  })
}

test('a hung API status request expires and its late success cannot overwrite the warning', async t => {
  const reading = deferred()
  const h = feedbackHarness(t, { getCodexApiModeStatus: async () => reading.promise })
  h.showCodexLaunchFeedback({ apiMode: pendingApi }, 'Codex 已重新打开。')
  await h.advance()
  await h.advance()
  const warning = h.state.toolWarnings.value.codex
  assert.match(warning, /纯 API.*尚未确认生效/)
  assert.equal(h.timers.size, 0)
  reading.resolve(verifiedApi)
  await tick()
  assert.equal(h.state.toolWarnings.value.codex, warning)
  assert.equal(h.state.toolNotices.value.codex, '')
})

for (const status of [{ ...pendingApi, ready: true }, { ...pendingApi, verified: true }]) {
  test(`API ready=${status.ready} verified=${status.verified} remains unconfirmed after the bounded checks`, async t => {
    let reads = 0
    const h = feedbackHarness(t, { getCodexApiModeStatus: async () => { reads++; return status } })
    h.showCodexLaunchFeedback({ apiMode: pendingApi }, 'Codex 已重新打开。')
    for (let attempt = 0; attempt < 15; attempt++) await h.advance()
    assert.equal(reads, 15)
    assert.equal(h.timers.size, 0)
    assert.match(h.state.toolWarnings.value.codex, /尚未确认生效/)
    assert.doesNotMatch(h.state.toolWarnings.value.codex, apiSuccess)
    assert.equal(h.state.toolNotices.value.codex, '')
  })
}

test('a current pending API launch takes precedence over an earlier top-level verified result', t => {
  const h = feedbackHarness(t)
  const feedback = h.codexApiModeFeedback({ apiMode: verifiedApi, launch: { apiMode: pendingApi } })
  assert.equal(feedback.pending, true)
  assert.equal(feedback.notice, '')
  assert.match(feedback.warning, /尚未确认生效/)
})

test('an unavailable API status RPC preserves current launch status instead of stale top-level verification', async t => {
  const h = feedbackHarness(t, { getCodexUltraStatus: async () => verifiedUltra })
  h.showCodexLaunchFeedback({ apiMode: verifiedApi, ultra: pendingUltra, launch: { apiMode: pendingApi } }, 'Codex 已重新打开。')
  await h.advance()
  assert.equal(h.state.toolNotices.value.codex, '')
  assert.match(h.state.toolWarnings.value.codex, /尚未确认生效/)
  assert.doesNotMatch(h.state.toolWarnings.value.codex, apiSuccess)
})

test('API status polling cannot replace a pending launch Ultra result with stale top-level verification', async t => {
  const h = feedbackHarness(t, { getCodexApiModeStatus: async () => verifiedApi })
  h.showCodexLaunchFeedback({ apiMode: pendingApi, ultra: verifiedUltra, launch: { ultra: pendingUltra } }, 'Codex 已重新打开。')
  await h.advance()
  assert.match(h.state.toolNotices.value.codex, apiSuccess)
  assert.match(h.state.toolNotices.value.codex, /等待 Ultra 验证/)
  assert.doesNotMatch(h.state.toolNotices.value.codex, /Ultra 已通过/)
})

test('an old API result cannot update a newer launch or remove its polling timer', async t => {
  const first = deferred()
  let reads = 0
  const h = feedbackHarness(t, { getCodexApiModeStatus: async () => ++reads === 1 ? first.promise : verifiedApi })
  h.showCodexLaunchFeedback({ apiMode: pendingApi }, '第一次启动。')
  await h.advance()
  h.showCodexLaunchFeedback({ apiMode: pendingApi }, '第二次启动。')
  first.resolve(verifiedApi)
  await tick()
  assert.match(h.state.toolWarnings.value.codex, /第二次启动.*尚未确认生效/)
  assert.equal(h.state.toolNotices.value.codex, '')
  assert.equal(h.timers.size, 1)
  await h.advance()
  assert.equal(reads, 2)
  assert.match(h.state.toolNotices.value.codex, /第二次启动/)
  assert.match(h.state.toolNotices.value.codex, apiSuccess)
  assert.equal(h.timers.size, 0)
})

test('switching account invalidates pending API feedback before a late result arrives', async t => {
  const reading = deferred()
  const h = feedbackHarness(t, { getCodexApiModeStatus: async () => reading.promise })
  h.showCodexLaunchFeedback({ apiMode: pendingApi }, 'Codex 已重新打开。')
  await h.advance()
  const finish = h.beginCodexAccountMutation()
  h.state.toolNotices.value.codex = '已切换到另一个账号。'
  h.state.toolWarnings.value.codex = ''
  assert.equal(h.timers.size, 0)
  reading.resolve(verifiedApi)
  await tick()
  assert.equal(h.state.toolNotices.value.codex, '已切换到另一个账号。')
  assert.equal(h.state.toolWarnings.value.codex, '')
  finish()
})

test('disabled API mode preserves Ultra polling and its verified feedback', async t => {
  const h = feedbackHarness(t, {
    getCodexUltraStatus: async () => verifiedUltra,
    getCodexApiModeStatus: async () => disabled,
  })
  h.showCodexLaunchFeedback({ apiMode: disabled, ultra: pendingUltra }, 'Codex 已重新打开。')
  assert.match(h.state.toolNotices.value.codex, /Ultra 验证/)
  await h.advance()
  assert.match(h.state.toolNotices.value.codex, /Ultra 已通过本次检查/)
  assert.doesNotMatch(h.state.toolNotices.value.codex, /纯 API/)
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.equal(h.timers.size, 0)
})

test('API disabling during a combined check keeps the verified Ultra notice', async t => {
  const h = feedbackHarness(t, {
    getCodexUltraStatus: async () => verifiedUltra,
    getCodexApiModeStatus: async () => disabled,
  })
  h.showCodexLaunchFeedback({ apiMode: pendingApi, ultra: pendingUltra }, 'Codex 已重新打开。')
  await h.advance()
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.match(h.state.toolNotices.value.codex, /Ultra 已通过本次检查/)
  assert.doesNotMatch(h.state.toolNotices.value.codex, /纯 API/)
  assert.equal(h.timers.size, 0)
})

test('aggregate feedback removes transient API warnings while retaining independent catalog warnings', async t => {
  const h = feedbackHarness(t, { getCodexApiModeStatus: async () => verifiedApi })
  h.showCodexLaunchFeedback({ apiMode: { ...pendingApi, warnings: ['临时模式验证提示。'] }, appPatch: { warnings: ['目录提示。'] } }, '聚合登录已启用。', [], false, 'aggregate')
  assert.match(h.state.aggregateLoginError.value, /临时模式验证提示/)
  await h.advance()
  assert.equal(h.state.aggregateLoginError.value, '目录提示。')
  assert.match(h.state.aggregateLoginNotice.value, apiSuccess)
  assert.equal(h.state.toolNotices.value.codex, '')
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.equal(h.timers.size, 0)
})

test('contradictory API status fields never report verified coding success', async t => {
  for (const patch of [
    { error: 'native verification failed' },
    { reason: 'unsupported-runtime' },
    { enabled: false },
    { reason: 'awaiting-mode' },
  ]) {
    const status = { ...verifiedApi, ...patch }
    const h = feedbackHarness(t, { getCodexApiModeStatus: async () => status })
    const direct = h.codexApiModeFeedback({ apiMode: status })
    assert.equal(direct.notice, '')
    assert.ok(direct.warning)
    assert.doesNotMatch(direct.warning, apiSuccess)
    h.showCodexLaunchFeedback({ apiMode: pendingApi }, 'Codex 已重新打开。')
    await h.advance()
    assert.doesNotMatch(h.state.toolNotices.value.codex, apiSuccess)
    assert.ok(h.state.toolWarnings.value.codex)
    if (patch.reason === 'unsupported-runtime') {
      assert.equal(direct.pending, false)
      assert.match(h.state.toolWarnings.value.codex, /尚未适配/)
      assert.equal(h.timers.size, 0)
    }
    h.stopCodexUltraStatusCheck()
  }
})
