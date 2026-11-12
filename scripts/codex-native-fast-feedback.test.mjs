import assert from 'node:assert/strict'
import test from 'node:test'
import { harness, tick, deferred } from './codex-account-route-harness.mjs'

// All feedback functions and timers are extracted from the production Vue
// component. Desktop replies and elapsed time are synthetic and contain no key.
const pending = { enabled: true, ready: false, verified: false, compiled: false, reason: 'preparing-modules' }
const verified = { enabled: true, ready: true, verified: true, compiled: true, phase: 'compiled', reason: 'compiled' }
const waiting = { ...pending, reason: 'awaiting-restart', needsRestart: true }
const unsupported = { ...pending, reason: 'unsupported-modules', phase: 'unsupported' }
const pendingUltra = { requested: true, enabled: true, ready: false, verified: false, reason: 'awaiting-visible-picker' }
const verifiedUltra = { requested: true, enabled: true, ready: true, verified: true, reason: 'ready' }
const pendingApi = { requested: true, enabled: true, ready: false, verified: false, reason: 'awaiting-page' }
const verifiedApi = { requested: true, enabled: true, ready: true, verified: true, reason: 'coding' }
const success = /原生 Fast 入口已通过本次检查/

function feedback(status) {
  return harness().codexNativeFastFeedback({ nativeFast: status })
}

function clockHarness(t, api = {}) {
  const h = harness({ api })
  const timers = new Map()
  let sequence = 0
  h.state.window.setTimeout = (callback, delay) => {
    assert.equal(delay, 2000)
    timers.set(++sequence, callback)
    return sequence
  }
  h.state.window.clearTimeout = id => timers.delete(id)
  t.after(() => h.stopCodexUltraStatusCheck())
  return Object.assign(h, {
    timers,
    async advance() {
      const [id, callback] = timers.entries().next().value || []
      assert.ok(callback, 'Expected a scheduled current-runtime check')
      timers.delete(id)
      callback()
      await tick()
    },
  })
}

test('missing or disabled NativeFast replies preserve existing feedback behavior', () => {
  for (const status of [null, undefined, { enabled: false }, { ...verified, reason: 'disabled' }]) {
    assert.deepEqual({ ...feedback(status) }, { notice: '', warning: '', pending: false })
  }
  const h = harness()
  assert.deepEqual(h.codexRuntimeFeedback({ ultra: verifiedUltra }), h.codexUltraFeedback({ ultra: verifiedUltra }))
})

test('compiled verification reports the native entry, without claiming upstream service acceleration', () => {
  const result = feedback(verified)
  assert.match(result.notice, success)
  assert.equal(result.warning, '')
  assert.equal(result.pending, false)
  assert.doesNotMatch(result.notice, /请求已加速|服务已加速|优先处理/)
})

for (const patch of [
  { enabled: undefined }, { enabled: false }, { ready: false }, { verified: false }, { compiled: false },
  { reason: 'prepared', phase: 'prepared', installed: true },
  { reason: 'armed', phase: 'armed', installed: true },
  { phase: 'unsupported' }, { phase: 'prepared' },
  { needsRestart: true }, { error: 'synthetic-private-error' },
]) {
  test('contradictory or incomplete NativeFast evidence cannot report success: ' + JSON.stringify(patch), () => {
    const result = feedback({ ...verified, ...patch })
    assert.doesNotMatch(result.notice, success)
    assert.doesNotMatch(result.warning, /synthetic-private-error/)
  })
}

test('only short preparation phases request polling; restart waits and failures stop it', () => {
  for (const reason of ['awaiting-page', 'preparing-modules', 'preparing', 'prepared', 'armed']) {
    const result = feedback({ ...pending, reason })
    assert.equal(result.pending, true)
    assert.match(result.warning, /尚未确认 Fast 可用/)
    assert.doesNotMatch(result.notice, success)
  }
  assert.equal(feedback(waiting).pending, false)
  assert.match(feedback(waiting).warning, /等待重启/)
  assert.equal(feedback(unsupported).pending, false)
  assert.match(feedback(unsupported).warning, /适配未完成/)
})

test('unsupported adaptation takes precedence over a contradictory restart requirement', () => {
  for (const reason of ['unsupported-modules', 'native-fast-unavailable', 'native-runtime-unavailable',
    'module-preparation-failed', 'invalid-prepared-modules', 'module-install-failed']) {
    const result = feedback({ ...waiting, reason })
    assert.match(result.warning, /适配未完成/)
    assert.doesNotMatch(result.warning, /等待重启/)
    assert.equal(result.pending, false)
  }
})

test('connection failure and unknown diagnostics use fixed actionable messages', () => {
  assert.match(feedback({ ...waiting, reason: 'connection-unavailable' }).warning, /暂时无法连接 Codex.*原生加速尚未确认生效/)
  const result = feedback({ ...pending, reason: 'private-config-contents', error: 'private-api-key' })
  assert.match(result.warning, /原生加速检查未通过/)
  assert.doesNotMatch(result.warning, /private-config-contents|private-api-key/)
  assert.equal(result.pending, false)
})

test('current launch NativeFast takes precedence over a stale top-level successful snapshot', () => {
  const h = harness()
  const result = { nativeFast: verified, launch: { nativeFast: waiting } }
  assert.match(h.codexNativeFastFeedback(result).warning, /等待重启/)
  assert.doesNotMatch(h.codexRuntimeFeedback(result).notice, success)
  assert.match(h.codexLaunchWarnings(result), /等待重启/)
})

test('legacy warning-only launch consumers also receive NativeFast failures and deduplicated warnings', () => {
  const h = harness()
  const result = { nativeFast: { ...unsupported, warnings: ['额外提示。'] }, launch: { warnings: ['额外提示。'] } }
  const messages = h.codexLaunchWarningMessages(result)
  assert.equal(messages.filter(value => value === '额外提示。').length, 1)
  assert.match(h.codexLaunchWarnings(result), /额外提示.*适配未完成/)
})

test('waiting for restart alone does not repeatedly query unrelated runtime status', t => {
  let reads = 0
  const h = clockHarness(t, { getCodexNativeFastStatus: async () => { reads++; return verified } })
  h.showCodexLaunchFeedback({ nativeFast: waiting }, 'Codex 已重新打开。')
  assert.match(h.state.toolWarnings.value.codex, /等待重启/)
  assert.equal(h.timers.size, 0)
  assert.equal(reads, 0)
})

test('NativeFast independently polls and clears its pending warning only after compiled verification', async t => {
  let reads = 0
  const warning = '原生加速适配检查尚未完成，尚未确认 Fast 可用。'
  const h = clockHarness(t, { getCodexNativeFastStatus: async () => { reads++; return verified } })
  h.showCodexLaunchFeedback({ nativeFast: { ...pending, warnings: [warning] }, warnings: [warning] }, 'Codex 已重新打开。')
  assert.match(h.state.toolWarnings.value.codex, /尚未确认 Fast 可用/)
  await h.advance()
  assert.equal(reads, 1)
  assert.match(h.state.toolNotices.value.codex, success)
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.equal(h.timers.size, 0)
})

test('all three current runtime replies are required before combined success appears', async t => {
  const nativeRead = deferred()
  const h = clockHarness(t, {
    getCodexUltraStatus: async () => verifiedUltra,
    getCodexApiModeStatus: async () => verifiedApi,
    getCodexNativeFastStatus: async () => nativeRead.promise,
  })
  h.showCodexLaunchFeedback({ ultra: pendingUltra, apiMode: pendingApi, nativeFast: pending }, 'Codex 已重新打开。')
  await h.advance()
  assert.doesNotMatch(h.state.toolNotices.value.codex, success)
  nativeRead.resolve(verified)
  await tick()
  assert.match(h.state.toolNotices.value.codex, /Ultra 已通过.*纯 API 登录.*原生 Fast 入口已通过/)
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.equal(h.timers.size, 0)
})

for (const nativeFast of [waiting, unsupported, { ...pending, reason: 'connection-unavailable' }]) {
  test('successful Ultra polling preserves NativeFast terminal feedback: ' + nativeFast.reason, async t => {
    const h = clockHarness(t, { getCodexUltraStatus: async () => verifiedUltra })
    h.showCodexLaunchFeedback({ ultra: pendingUltra, nativeFast }, 'Codex 已重新打开。')
    await h.advance()
    assert.match(h.state.toolWarnings.value.codex, /Ultra 已通过本次检查/)
    assert.match(h.state.toolWarnings.value.codex, new RegExp(h.codexNativeFastFeedback({ nativeFast }).warning))
    assert.doesNotMatch(h.state.toolWarnings.value.codex, success)
    assert.equal(h.timers.size, 0)
  })
}

for (const response of [null, undefined]) {
  test('empty NativeFast RPC cannot clear pending verification: ' + response, async t => {
    const h = clockHarness(t, { getCodexNativeFastStatus: async () => response })
    h.showCodexLaunchFeedback({ nativeFast: pending }, 'Codex 已重新打开。')
    await h.advance()
    assert.match(h.state.toolWarnings.value.codex, /原生加速.*尚未确认 Fast 可用/)
    assert.doesNotMatch(h.state.toolWarnings.value.codex, success)
    assert.equal(h.timers.size, 0)
  })
}

test('an empty terminal NativeFast RPC preserves its last warning during other runtime checks', async t => {
  const h = clockHarness(t, {
    getCodexUltraStatus: async () => verifiedUltra,
    getCodexNativeFastStatus: async () => null,
  })
  h.showCodexLaunchFeedback({ ultra: pendingUltra, nativeFast: unsupported }, 'Codex 已重新打开。')
  await h.advance()
  assert.match(h.state.toolWarnings.value.codex, /适配未完成/)
  assert.doesNotMatch(h.state.toolWarnings.value.codex, success)
  assert.equal(h.timers.size, 0)
})

test('a failed runtime RPC preserves the latest NativeFast failure instead of clearing it', async t => {
  let attempts = 0
  const h = clockHarness(t, {
    getCodexUltraStatus: async () => { if (++attempts > 1) throw new Error('synthetic-private-RPC-error'); return pendingUltra },
    getCodexNativeFastStatus: async () => unsupported,
  })
  h.showCodexLaunchFeedback({ ultra: pendingUltra, nativeFast: pending }, 'Codex 已重新打开。')
  await h.advance()
  assert.match(h.state.toolWarnings.value.codex, /适配未完成/)
  await h.advance()
  assert.match(h.state.toolWarnings.value.codex, /适配未完成/)
  assert.doesNotMatch(h.state.toolWarnings.value.codex, /synthetic-private-RPC-error/)
  assert.equal(h.timers.size, 0)
})

test('a hung NativeFast RPC expires and late compiled success cannot replace the failure', async t => {
  const reading = deferred()
  const h = clockHarness(t, { getCodexNativeFastStatus: async () => reading.promise })
  h.showCodexLaunchFeedback({ nativeFast: pending }, 'Codex 已重新打开。')
  await h.advance()
  await h.advance()
  const warning = h.state.toolWarnings.value.codex
  assert.match(warning, /尚未确认 Fast 可用/)
  assert.equal(h.timers.size, 0)
  reading.resolve(verified)
  await tick()
  assert.equal(h.state.toolWarnings.value.codex, warning)
})

test('bounded NativeFast polling retains pending warning instead of claiming installation success', async t => {
  let reads = 0
  const h = clockHarness(t, { getCodexNativeFastStatus: async () => { reads++; return { ...pending, phase: 'armed', reason: 'armed', installed: true } } })
  h.showCodexLaunchFeedback({ nativeFast: pending }, 'Codex 已重新打开。')
  for (let attempt = 0; attempt < 15; attempt++) await h.advance()
  assert.equal(reads, 15)
  assert.equal(h.timers.size, 0)
  assert.match(h.state.toolWarnings.value.codex, /尚未确认 Fast 可用/)
  assert.doesNotMatch(h.state.toolWarnings.value.codex, success)
})

test('the latest launch replaces an earlier pending NativeFast request and invalidates its late success', async t => {
  const firstRead = deferred()
  const h = clockHarness(t, { getCodexNativeFastStatus: async () => firstRead.promise })
  h.showCodexLaunchFeedback({ nativeFast: pending }, '第一次启动。')
  await h.advance()
  h.showCodexLaunchFeedback({ nativeFast: waiting }, '第二次启动。')
  firstRead.resolve(verified)
  await tick()
  assert.match(h.state.toolWarnings.value.codex, /第二次启动.*等待重启/)
  assert.doesNotMatch(h.state.toolWarnings.value.codex, /第一次启动|入口已通过/)
  assert.equal(h.timers.size, 0)
})

test('aggregate login separates persistent catalog warning from verified NativeFast notice', async t => {
  const h = clockHarness(t, { getCodexNativeFastStatus: async () => verified })
  h.showCodexLaunchFeedback({ nativeFast: pending, appPatch: { warnings: ['模型目录提示。'] } }, '聚合登录已启用。', [], false, 'aggregate')
  assert.match(h.state.aggregateLoginError.value, /尚未确认 Fast 可用/)
  await h.advance()
  assert.match(h.state.aggregateLoginNotice.value, success)
  assert.equal(h.state.aggregateLoginError.value, '模型目录提示。')
  assert.equal(h.state.toolNotices.value.codex, '')
  assert.equal(h.state.toolWarnings.value.codex, '')
})

for (const nativeFast of [waiting, unsupported, pending]) {
  test('Ultra exhaustion retains NativeFast pending or terminal warning: ' + nativeFast.reason, async t => {
    const ultra = { ...pendingUltra, reason: 'awaiting-page' }
    const h = clockHarness(t, {
      getCodexUltraStatus: async () => ultra,
      getCodexNativeFastStatus: async () => nativeFast,
    })
    h.showCodexLaunchFeedback({ ultra, nativeFast }, 'Codex 已重新打开。')
    for (let attempt = 0; attempt < 15; attempt++) await h.advance()
    assert.equal(h.timers.size, 0)
    assert.match(h.state.toolWarnings.value.codex, /Ultra 检查尚未完成/)
    assert.match(h.state.toolWarnings.value.codex, new RegExp(h.codexNativeFastFeedback({ nativeFast }).warning))
    assert.doesNotMatch(h.state.toolWarnings.value.codex, success)
    assert.equal(h.state.toolNotices.value.codex, '')
  })
}
