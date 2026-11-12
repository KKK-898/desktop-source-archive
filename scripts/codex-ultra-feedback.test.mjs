import assert from 'node:assert/strict'
import test from 'node:test'
import { harness, tick } from './codex-account-route-harness.mjs'

// Exercise declarations extracted from the production component, not a copied
// implementation. Runtime responses/timing are synthetic and never use a key.
const pending = { requested: true, enabled: true, ready: false, verified: false, reason: 'awaiting-visible-picker' }
const verified = { requested: true, enabled: true, ready: true, verified: true, reason: 'ready' }
const success = /Ultra 已通过本次检查/

function feedback(ultra) {
  return harness().codexUltraFeedback({ ultra })
}

function clockHarness(t, api = {}) {
  const h = harness({ api })
  const timers = new Map()
  let sequence = 0
  h.state.window.setTimeout = callback => { timers.set(++sequence, callback); return sequence }
  h.state.window.clearTimeout = id => timers.delete(id)
  t.after(() => h.stopCodexUltraStatusCheck())
  return Object.assign(h, {
    timers,
    async advance() {
      const [id, callback] = timers.entries().next().value || []
      assert.ok(callback, 'Expected a scheduled verification check')
      timers.delete(id)
      callback()
      await tick()
    },
  })
}

test('unsupported client query requires compatibility repair, not repeated login or false success', () => {
  const status = feedback({ ...verified, reason: 'unsupported-query' })
  assert.match(status.warning, /当前 Codex 版本.*尚未适配/)
  assert.match(status.warning, /更新本软件.*兼容适配/)
  assert.match(status.warning, /反复 API 登录不能修复/)
  assert.doesNotMatch(status.warning, /正在重试|已通过/)
  assert.equal(status.pending, false)
})

test('connection failure includes helper launch and stale shortcut repair guidance', () => {
  const status = feedback({ ...pending, reason: 'connection-unavailable' })
  assert.match(status.warning, /完全退出 Codex/)
  assert.match(status.warning, /从本软件点击「重启 Codex」/)
  assert.match(status.warning, /启动路径.*旧版本.*旧快捷方式/)
  assert.equal(status.pending, false)
})

test('catalog and route failures name active profile and preserve personal credentials', () => {
  const catalog = feedback({ ...pending, reason: 'catalog-unavailable' })
  assert.match(catalog.warning, /配置档（profile）.*模型目录/)
  assert.match(catalog.warning, /无需删除个人配置或密钥/)
  const route = feedback({ ...pending, reason: 'route-inactive' })
  assert.match(route.warning, /提供商、路由和模型目录是否一致/)
  assert.equal(catalog.pending, false)
  assert.equal(route.pending, false)
})

test('closed display setting and unsupported model remain distinct actionable causes', () => {
  const setting = feedback({ ...pending, reason: 'setting-disabled' })
  assert.match(setting.notice, /显示设置限制，不代表当前模型不支持/)
  const unsupported = feedback({ ...pending, reason: 'model-unsupported' })
  assert.match(unsupported.notice, /切换到模型目录中明确支持 Ultra 的模型/)
  assert.match(unsupported.notice, /不会把不支持的模型强制标为支持/)
  assert.equal(setting.warning, '')
  assert.equal(unsupported.warning, '')
})

test('awaiting a visible picker never inherits stale verified success', () => {
  const status = feedback({ ...verified, reason: 'awaiting-visible-picker' })
  assert.equal(status.pending, true)
  assert.match(status.notice, /打开本地聊天.*选择器/)
  assert.match(status.notice, /不等于 Ultra 已可用/)
  assert.doesNotMatch(status.notice, success)
})

for (const mismatch of [
  { ready: undefined }, { ready: false }, { verified: false }, { enabled: false },
  { observationFresh: false }, { connectionState: 'disconnected' },
]) {
  test(`incomplete or stale evidence never reports success: ${JSON.stringify(mismatch)}`, () => {
    const status = feedback({ ...verified, ...mismatch })
    assert.doesNotMatch(status.notice, success)
  })
}

test('expired observation stays pending with a concrete current-window check', () => {
  const status = feedback({ ...verified, reason: 'observation-expired', observationFresh: false })
  assert.match(status.warning, /上次检查结果已过期/)
  assert.match(status.warning, /重新检查当前窗口/)
  assert.equal(status.pending, true)
})

test('fresh and compatible legacy runtime observations can report verified success', () => {
  for (const status of [verified, { ...verified, runtimeVersion: 22, observationFresh: true, observationAgeMs: 50, connectionState: 'connected' }]) {
    assert.match(feedback(status).notice, success)
    assert.equal(feedback(status).pending, false)
  }
})

test('unknown errors and status data are not echoed into user-visible feedback', () => {
  const privateText = 'sk-synthetic-secret; token=private; full-config=not-for-display'
  const status = feedback({ ...pending, reason: privateText, error: privateText, runtimeVersion: 22 })
  assert.doesNotMatch(JSON.stringify(status), /synthetic-secret|full-config|token=private/)
  assert.match(status.warning, /不含密钥的状态提示/)
})

for (const response of [null, undefined]) {
  test(`empty Ultra RPC (${response}) cannot silently clear pending verification`, async t => {
    const h = clockHarness(t, { getCodexUltraStatus: async () => response })
    h.showCodexLaunchFeedback({ ultra: pending }, 'Codex 已重新打开。')
    await h.advance()
    assert.match(h.state.toolWarnings.value.codex, /暂时无法完成 Ultra 检查/)
    assert.doesNotMatch(h.state.toolNotices.value.codex, success)
    assert.equal(h.timers.size, 0)
  })
}

test('expired observation recovers only after fresh visible-picker verification', async t => {
  const responses = [
    { ...verified, observationFresh: false, reason: 'observation-expired' },
    { ...verified, observationFresh: true, connectionState: 'connected' },
  ]
  const h = clockHarness(t, { getCodexUltraStatus: async () => responses.shift() })
  h.showCodexLaunchFeedback({ ultra: pending }, 'Codex 已重新打开。')
  await h.advance()
  assert.match(h.state.toolWarnings.value.codex, /检查结果已过期/)
  assert.doesNotMatch(h.state.toolNotices.value.codex, success)
  await h.advance()
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.match(h.state.toolNotices.value.codex, success)
  assert.equal(h.timers.size, 0)
})


test('an initial page with no observation is pending rather than an expired-success warning', () => {
  for (const reason of ['awaiting-page', 'awaiting-model-query', 'setting-disabled', 'model-unsupported']) {
    const result = feedback({ ...pending, reason, observationFresh: false, observationAgeMs: null, connectionState: 'connected' });
    assert.doesNotMatch(result.warning, /已过期/);
    assert.doesNotMatch(result.notice, success);
    assert.equal(result.pending, true);
  }
});
