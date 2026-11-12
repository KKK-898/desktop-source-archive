import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, ref } from 'vue'

// Execute the production Vue declarations with synthetic replies and timers.
// No app launch, credentials, user config, network, or native runtime is accessed.
const text = readFileSync(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
const script = text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('plugin-toggle.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = [
  'pluginRuntimeReady', 'pluginRuntimeInjected', 'pluginNativeEntryReady', 'pluginListVerified',
  'pluginSearchReady', 'pluginNeedsRestart', 'pluginDisablePending', 'pluginStatusUnsupported', 'pluginStatusReason', 'pluginStatusChecking', 'pluginStatusMessage',
  'pluginMutationInFlight', 'CODEX_PLUGIN_STATUS_MAX_ATTEMPTS', 'CODEX_PLUGIN_STATUS_INTERVAL_MS',
  'CODEX_PLUGIN_STATUS_REQUEST_TIMEOUT_MS', 'pluginStatusGeneration', 'pluginStatusTimer',
  'pluginStatusCancelWait', 'pluginStatusCancelRequest', 'pluginStatusDisposed',
  'stopCodexPluginStatusCheck', 'waitForCodexPluginStatusCheck', 'readCodexPluginStatusWithTimeout',
  'applyCodexPluginStatus', 'pollCodexPluginStatus', 'applyPluginSetting', 'loadCodexPluginsStatus',
  'availablePluginCount', 'systemConfigCards',
]
const declarations = source.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.getText(source))),
)
assert.equal(declarations.length, names.length, 'Every tested declaration must come from production')
const compiled = ts.transpileModule(declarations.map(node => node.getText(source)).join('\n') + `
globalThis.subject = { ${names.join(',')}, dispose() { pluginStatusDisposed = true; stopCodexPluginStatusCheck(); } };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }
const pending = (extra = {}) => ({ enabled: true, configEnabled: true, runtimeReady: false, runtimeInjected: true, nativeEntryReady: false, listVerified: false, searchReady: false, needsRestart: false, reason: 'runtime-pending', ...extra })
const ready = (extra = {}) => pending({ runtimeReady: true, nativeEntryReady: true, listVerified: true, searchReady: true, reason: 'verified', ...extra })

function harness(options = {}) {
  const calls = []
  const timers = new Map()
  let timerId = 0
  const state = { settings: ref({ plugins: false, sessionSync: false, sessionDelete: false, language: false }), loading: ref({ plugins: false }), errors: ref({ plugins: '' }), notices: ref({ plugins: '' }) }
  const api = {
    setCodexPlugins: async request => { calls.push(['set', request]); return options.set ? options.set(request) : ready() },
    getCodexPluginsStatus: async () => { calls.push(['status']); return options.status ? options.status() : ready() },
    restartCodex: () => { throw new Error('A plugin toggle must never restart Codex') },
  }
  if (options.withoutStatus) delete api.getCodexPluginsStatus
  const context = vm.createContext({
    ref, computed, settingToggles: state.settings, settingLoading: state.loading,
    settingErrors: state.errors, settingNotices: state.notices,
    imageToolsMigrationFeedback: ref({ notice: '', warning: '' }),
    getImageToolsMigrationFeedback: value => value,
    persistSettingToggle: (key, value) => { state.settings.value[key] = value },
    getErrorMessage: error => String(error?.message || error),
    reportPageError: (...args) => calls.push(['report', ...args]),
    sessionDeleteRuntimeReady: ref(false), codexThemeActiveName: ref(''),
    RefreshCcw: {}, Sparkles: {}, Trash2: {}, Brush: {},
    window: { gaogeDesktop: api,
      setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id },
      clearTimeout: id => timers.delete(id),
    },
  })
  vm.runInContext(compiled, context)
  const subject = context.subject
  return { subject, state, calls, timers,
    card: () => subject.systemConfigCards.value.find(card => card.label === '官方插件'),
    fire: async (ms) => { const item = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(item, `Expected timer ${ms}`); timers.delete(item[0]); item[1].fn(); await tick() },
  }
}

test('a toggle claims its lock immediately and never confirms/restarts Codex', async () => {
  const mutation = deferred()
  const h = harness({ set: () => mutation.promise })
  const first = h.subject.applyPluginSetting(true)
  const second = h.subject.applyPluginSetting(true)
  assert.equal(h.subject.pluginMutationInFlight.value, true)
  assert.equal(h.card().disabled, true)
  assert.equal(h.calls.filter(call => call[0] === 'set').length, 1)
  mutation.resolve(ready())
  await Promise.all([first, second])
  assert.equal(h.card().value, '已开启')
  assert.equal(h.card().disabled, false)
  assert.equal(h.timers.size, 0)
  assert.equal(h.calls.some(call => call[0] === 'status'), false)
})

test('pending state polls until all runtime evidence is verified', async () => {
  let reads = 0
  const h = harness({ set: () => ({ enabled: true, status: pending() }), status: () => ++reads === 1 ? pending() : ready() })
  const task = h.subject.applyPluginSetting(true)
  await tick()
  assert.equal(h.card().value, '正在检测')
  assert.equal(h.card().disabled, true)
  await h.fire(h.subject.CODEX_PLUGIN_STATUS_INTERVAL_MS)
  await task
  assert.equal(reads, 2)
  assert.equal(h.card().value, '已开启')
  assert.match(h.subject.pluginStatusMessage.value, /单独安装.*服务授权/)
  assert.equal(h.timers.size, 0)
})

test('legacy applied and runtimeReady without evidence never mean ready', () => {
  const h = harness()
  h.subject.applyCodexPluginStatus({ enabled: true, runtimeReady: true, appPatch: { applied: true, method: 'cdp' } })
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  assert.equal(h.card().value, '尚未验证')
  for (const field of ['runtimeInjected', 'nativeEntryReady', 'listVerified']) {
    h.subject.applyCodexPluginStatus(ready({ [field]: false }))
    assert.equal(h.subject.pluginRuntimeReady.value, false, field)
  }
})

test('needsRestart stops polling and preserves config with a manual restart notice', async () => {
  const h = harness({ set: () => ({ enabled: true, status: pending({ needsRestart: true, reason: 'connection-unavailable' }) }) })
  await h.subject.applyPluginSetting(true)
  assert.equal(h.card().value, '待重启')
  assert.equal(h.state.settings.value.plugins, true)
  assert.match(h.subject.pluginStatusMessage.value, /先保存任务.*重启 Codex.*重新检测/)
  assert.equal(h.calls.filter(call => call[0] === 'status').length, 0)
  assert.equal(h.timers.size, 0)
})

test('background checks stop after a bounded attempt count without clearing preference', async () => {
  const h = harness({ status: () => pending() })
  const task = h.subject.loadCodexPluginsStatus()
  await tick()
  for (let attempt = 1; attempt < h.subject.CODEX_PLUGIN_STATUS_MAX_ATTEMPTS; attempt++) await h.fire(h.subject.CODEX_PLUGIN_STATUS_INTERVAL_MS)
  await task
  assert.equal(h.calls.filter(call => call[0] === 'status').length, h.subject.CODEX_PLUGIN_STATUS_MAX_ATTEMPTS)
  assert.equal(h.state.settings.value.plugins, true)
  assert.equal(h.card().value, '尚未验证')
  assert.match(h.state.errors.value.plugins, /已停止自动检测.*开启偏好已保留/)
  assert.equal(h.timers.size, 0)
})

test('a hung status request times out and ignores a late success', async () => {
  const read = deferred()
  const h = harness({ status: () => read.promise })
  const task = h.subject.loadCodexPluginsStatus()
  await tick()
  await h.fire(h.subject.CODEX_PLUGIN_STATUS_REQUEST_TIMEOUT_MS)
  await task
  assert.match(h.state.errors.value.plugins, /超时/)
  assert.equal(h.subject.pluginStatusChecking.value, false)
  read.resolve(ready())
  await tick()
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  assert.equal(h.timers.size, 0)
})

test('a new operation cancels stale read results before applying its own preference', async () => {
  const read = deferred()
  const h = harness({ status: () => read.promise, set: () => ({ enabled: false, configEnabled: false, runtimeReady: false }) })
  const old = h.subject.loadCodexPluginsStatus()
  await tick()
  await h.subject.applyPluginSetting(false)
  read.resolve(ready())
  await old
  await tick()
  assert.equal(h.state.settings.value.plugins, false)
  assert.equal(h.card().value, '已关闭')
  assert.equal(h.timers.size, 0)
})

test('disposing cancels timers and ignores pending mutation updates', async () => {
  const mutation = deferred()
  const h = harness({ set: () => mutation.promise })
  const task = h.subject.applyPluginSetting(true)
  h.subject.dispose()
  mutation.resolve(ready())
  await task
  assert.equal(h.state.settings.value.plugins, false)
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  assert.equal(h.timers.size, 0)
  await h.subject.loadCodexPluginsStatus()
  assert.equal(h.calls.filter(call => call[0] === 'status').length, 0)
})

test('disposing resolves active poll delay without further reads', async () => {
  const h = harness({ status: () => pending() })
  const task = h.subject.loadCodexPluginsStatus()
  await tick()
  h.subject.dispose()
  await task
  assert.equal(h.calls.filter(call => call[0] === 'status').length, 1)
  assert.equal(h.timers.size, 0)
})

test('backend errors stop checks without claiming success', async () => {
  const h = harness({ set: () => pending(), status: () => pending({ error: '插件请求桥尚未兼容当前版本。' }) })
  await h.subject.applyPluginSetting(true)
  assert.match(h.state.errors.value.plugins, /请求桥/)
  assert.equal(h.state.notices.value.plugins, '')
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  assert.equal(h.state.settings.value.plugins, true)
  assert.equal(h.timers.size, 0)
})

test('failed mutation reconciles state but keeps the actionable failure', async () => {
  const h = harness({ set: () => { throw new Error('配置写入失败') }, status: () => pending({ needsRestart: true }) })
  await h.subject.applyPluginSetting(true)
  assert.match(h.state.errors.value.plugins, /配置写入失败/)
  assert.equal(h.state.settings.value.plugins, true)
  assert.equal(h.subject.pluginMutationInFlight.value, false)
  assert.equal(h.card().disabled, false)
})

test('closing enhancement keeps plugin preferences and may still require restart cleanup', async () => {
  const h = harness({ set: () => ({ enabled: false, configEnabled: false, needsRestart: true }) })
  await h.subject.applyPluginSetting(false)
  assert.equal(h.card().value, '关闭待重启')
  assert.match(h.subject.pluginStatusMessage.value, /重启后完全移除.*启停设置均保留/)
  assert.equal(h.calls.filter(call => call[0] === 'set').length, 1)
})

test('discovery counts are replaceable including zero and never claim installed', () => {
  const h = harness()
  h.subject.applyCodexPluginStatus(ready({ availablePluginCount: 78 }))
  assert.match(h.card().detail, /目录发现 78.*不代表已安装或已授权/)
  h.subject.applyCodexPluginStatus(ready({ availablePluginCount: 0, indexedPlugins: 78 }))
  assert.equal(h.subject.availablePluginCount.value, 0)
  assert.doesNotMatch(h.card().detail, /78/)
})

test('search readiness is separate and does not grant third party authorizations', () => {
  const h = harness()
  h.subject.applyCodexPluginStatus(ready({ searchReady: false }))
  assert.equal(h.subject.pluginRuntimeReady.value, true)
  assert.match(h.subject.pluginStatusMessage.value, /搜索尚未验证.*单独安装或授权/)
})

test('missing status support leaves verified state false and gives a clear action', async () => {
  const h = harness({ withoutStatus: true, set: () => ({ enabled: true }) })
  await h.subject.applyPluginSetting(true)
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  assert.match(h.state.errors.value.plugins, /不支持插件运行验证/)
  assert.equal(h.card().disabled, false)
})

test('plugin card keeps concise API help and enable/disable action while teardown stays intact', () => {
  const start = text.indexOf(`<section v-else-if="activePage === '系统配置'"`)
  const card = text.slice(start, text.indexOf('<article class="new-theme-codex-path-panel">', start))
  assert.match(card, /<template v-if="card\.label !== '官方插件'">\s*<strong v-if="card\.label !== '强制中文'">\{\{ card\.value \}\}<\/strong>/)
  assert.doesNotMatch(card, /pluginStatusMessage|pluginStatusChecking|imageToolsMigrationFeedback|settingErrors\.plugins|重新检测/)
  assert.doesNotMatch(text, /watchFeedbackGetter\(\(\) => settingNotices\.value\.plugins, 'success'\)/)
  assert.match(text, /settingErrors\.value\.plugins \? '插件操作未完成，请重试。' : ''/)
  const h = harness()
  assert.equal(h.card().actionText, '开启插件')
  h.subject.applyCodexPluginStatus(pending({ needsRestart: true, reason: 'legacy-runtime-restart-required' }))
  assert.equal(h.card().actionText, '关闭插件')
  assert.match(text, /onUnmounted\(\(\) => \{\s*pluginStatusDisposed = true\s*stopCodexPluginStatusCheck\(\)/)
  const apply = declarations.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'applyPluginSetting').getText(source)
  assert.doesNotMatch(apply, /confirmCodexRestart|restartCodex\(|stopCodexApp\(/)
})


test('an error or restart requirement overrides stale ready flags', () => {
  const h = harness()
  h.subject.applyCodexPluginStatus(ready({ error: '验证失败' }))
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  assert.equal(h.card().value, '尚未验证')
  h.subject.applyCodexPluginStatus(ready({ needsRestart: true }))
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  assert.equal(h.card().value, '待重启')
})

test('partial nested evidence retains the top-level saved preference', () => {
  const h = harness()
  h.subject.applyCodexPluginStatus({ enabled: true, status: { runtimeReady: false, needsRestart: true } })
  assert.equal(h.state.settings.value.plugins, true)
  assert.equal(h.card().value, '待重启')
})

test('disabled preference waits until the running renderer confirms removal', async () => {
  let reads = 0
  const closing = { enabled: false, configEnabled: false, pending: true, pluginEnhancementsEnabled: true, runtimeReady: false }
  const closed = { enabled: false, configEnabled: false, pending: false, pluginEnhancementsEnabled: false, runtimeReady: false }
  const h = harness({ set: () => closing, status: () => ++reads === 1 ? closing : closed })
  const task = h.subject.applyPluginSetting(false)
  await tick()
  assert.equal(h.card().value, '关闭待确认')
  assert.equal(h.subject.pluginDisablePending.value, true)
  assert.equal(h.state.settings.value.plugins, false)
  assert.equal(h.card().disabled, true)
  await h.fire(h.subject.CODEX_PLUGIN_STATUS_INTERVAL_MS)
  await task
  assert.equal(reads, 2)
  assert.equal(h.card().value, '已关闭')
  assert.equal(h.subject.pluginDisablePending.value, false)
})

test('unconfirmed closing times out without claiming hooks were removed', async () => {
  const closing = { enabled: false, configEnabled: false, pending: true, runtimeReady: false }
  const h = harness({ set: () => closing, status: () => closing })
  const task = h.subject.applyPluginSetting(false)
  await tick()
  for (let attempt = 1; attempt < h.subject.CODEX_PLUGIN_STATUS_MAX_ATTEMPTS; attempt++) await h.fire(h.subject.CODEX_PLUGIN_STATUS_INTERVAL_MS)
  await task
  assert.equal(h.state.settings.value.plugins, false)
  assert.equal(h.card().value, '关闭待确认')
  assert.match(h.state.errors.value.plugins, /关闭配置已保存.*尚未确认.*已移除/)
  assert.equal(h.card().disabled, false)
  assert.equal(h.timers.size, 0)
})

test('renderer still enabled is treated as pending even if pending flag is absent', () => {
  const h = harness()
  const terminal = h.subject.applyCodexPluginStatus({ enabled: false, configEnabled: false, pluginEnhancementsEnabled: true })
  assert.equal(terminal, false)
  assert.equal(h.card().value, '关闭待确认')
})

for (const [reason, label] of [['unsupported-codex-version', '暂不支持'], ['native-plugin-entry-unavailable', '入口未验证']]) {
  test(`unsupported reason ${reason} stops polling without changing the preference`, async () => {
    const h = harness({ set: () => pending({ reason, state: 'unsupported' }) })
    await h.subject.applyPluginSetting(true)
    assert.equal(h.card().value, label)
    assert.equal(h.state.settings.value.plugins, true)
    assert.equal(h.subject.pluginRuntimeReady.value, false)
    assert.match(h.subject.pluginStatusMessage.value, /更新兼容适配/)
    assert.equal(h.calls.some(call => call[0] === 'status'), false)
    assert.equal(h.timers.size, 0)
  })
}

test('Codex not running is a terminal waiting state, never an automatic launch', async () => {
  const h = harness({ set: () => pending({ reason: 'codex-not-running' }) })
  await h.subject.applyPluginSetting(true)
  assert.equal(h.card().value, '等待启动')
  assert.match(h.subject.pluginStatusMessage.value, /从本软件打开 Codex 后重新检测.*不会.*自动启动或重启/)
  assert.equal(h.calls.some(call => call[0] === 'status'), false)
})

test('verified list without visible entry tells the user which UI is still missing', () => {
  const h = harness()
  h.subject.applyCodexPluginStatus(pending({ listVerified: true, reason: 'awaiting-native-plugin-entry' }))
  assert.match(h.subject.pluginStatusMessage.value, /列表已验证.*等待.*入口.*打开 Codex 的插件页面/)
  assert.equal(h.subject.pluginRuntimeReady.value, false)
})


test('contradictory unsupported or closed-client evidence never yields ready', () => {
  const h = harness()
  for (const reason of ['unsupported-codex-version', 'native-plugin-entry-unavailable', 'native-plugin-entry-unverified', 'native-plugin-entry-disabled', 'native-account-epoch-unverified', 'native-plugin-binding-unavailable', 'codex-not-running']) {
    h.subject.applyCodexPluginStatus(ready({ reason }))
    assert.equal(h.subject.pluginRuntimeReady.value, false, reason)
  }
})

test('empty current status stops with an actionable unverified result', async () => {
  const h = harness({ status: () => null })
  h.subject.applyCodexPluginStatus(ready())
  await h.subject.loadCodexPluginsStatus()
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  assert.match(h.state.errors.value.plugins, /未收到有效.*尚未确认/)
  assert.equal(h.timers.size, 0)
})


test('disabled preference with a runtime error remains unconfirmed', () => {
  const h = harness()
  h.subject.applyCodexPluginStatus({ enabled: false, configEnabled: false, runtimeError: '读取当前窗口失败' })
  assert.equal(h.card().value, '关闭待确认')
  assert.equal(h.state.settings.value.plugins, false)
})

test('missing status RPC invalidates an earlier successful observation', async () => {
  const h = harness({ withoutStatus: true })
  h.subject.applyCodexPluginStatus(ready())
  await h.subject.loadCodexPluginsStatus()
  assert.equal(h.subject.pluginRuntimeReady.value, false)
})

for (const [reason, label, expected] of [
  ['native-plugin-entry-unverified', '入口未验证', /尚未找到已验证.*入口.*打开 Codex 的插件页面/],
  ['native-plugin-entry-disabled', '原生已禁用', /原生插件入口当前已禁用.*不会绕过原生限制/],
  ['native-account-epoch-unverified', '验证受限', /当前账号作用域.*不会读取凭据.*沿用其他账号/],
  ['native-plugin-binding-unavailable', '验证受限', /原生插件请求接口或当前账号作用域.*尚未确认/],
]) {
  test('specific reason ' + reason + ' gives an accurate terminal message', async () => {
    const h = harness({ set: () => pending({ reason, state: 'unsupported' }) })
    await h.subject.applyPluginSetting(true)
    assert.equal(h.card().value, label)
    assert.match(h.subject.pluginStatusMessage.value, expected)
    assert.doesNotMatch(h.subject.pluginStatusMessage.value, /当前 Codex 版本暂不支持/)
    assert.equal(h.state.settings.value.plugins, true)
    assert.equal(h.subject.pluginRuntimeReady.value, false)
    assert.equal(h.calls.some(call => call[0] === 'status'), false)
    assert.equal(h.timers.size, 0)
  })
}

for (const reason of ['legacy-runtime-restart-required', 'legacy-or-replaced-hooks-require-restart']) {
  for (const enabled of [true, false]) {
    test('legacy contamination ' + reason + ' enabled=' + enabled + ' never promises restart cleanup', async () => {
      const h = harness({ set: () => pending({ enabled, configEnabled: enabled, reason, needsRestart: true }) })
      await h.subject.applyPluginSetting(enabled)
      assert.equal(h.card().value, '旧补丁待清理')
      assert.match(h.subject.pluginStatusMessage.value, /普通重启仍会加载.*恢复干净的 Codex 安装.*不会自动清理文件或重启/)
      assert.doesNotMatch(h.subject.pluginStatusMessage.value, /需重启后完全移除|通过软件内“重启 Codex”/)
      assert.equal(h.state.settings.value.plugins, enabled)
      assert.equal(h.subject.pluginRuntimeReady.value, false)
      assert.equal(h.calls.some(call => call[0] === 'status'), false)
      assert.equal(h.timers.size, 0)
    })
  }
}


test('a configured native-entry monitor completes the toggle without adding a sidebar or claiming ready', async () => {
  const h = harness({ set: () => pending({ configured: true, monitoring: true, listVerified: true,
    state: 'pending', reason: 'awaiting-native-entry' }) })
  await h.subject.applyPluginSetting(true)
  assert.equal(h.state.settings.value.plugins, true)
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  assert.equal(h.subject.pluginNativeEntryReady.value, false)
  assert.equal(h.state.errors.value.plugins, '')
  assert.match(h.subject.pluginStatusMessage.value, /配置已保存.*原生列表已验证.*保留原生侧栏/)
  assert.equal(h.calls.some(call => call[0] === 'status'), false)
  assert.equal(h.timers.size, 0)
})

test('entry absence alone does not replace configuration, monitoring or native list evidence', () => {
  const h = harness()
  const configured = pending({ configured: true, monitoring: true, listVerified: true,
    state: 'pending', reason: 'awaiting-native-entry' })
  for (const field of ['configured', 'monitoring', 'runtimeInjected', 'listVerified']) {
    assert.equal(h.subject.applyCodexPluginStatus({ ...configured, [field]: false }), false, field)
    assert.equal(h.subject.pluginRuntimeReady.value, false)
  }
  for (const reason of ['native-list-request-failed', 'registered-marketplace-not-visible', 'native-marketplace-load-error', 'unsupported-native-list-response']) {
    assert.equal(h.subject.applyCodexPluginStatus({ ...configured, reason }), false, reason)
    assert.equal(h.subject.pluginRuntimeReady.value, false)
  }
})

test('configured monitor never hides native denial or errors', async () => {
  const h = harness({ set: () => pending({ configured: true, monitoring: true, listVerified: true,
    state: 'pending', reason: 'awaiting-native-entry', runtimeError: 'native plugin access denied' }) })
  await h.subject.applyPluginSetting(true)
  assert.match(h.state.errors.value.plugins, /access denied/)
  assert.equal(h.subject.pluginRuntimeReady.value, false)
  h.subject.applyCodexPluginStatus(pending({ configured: true, monitoring: true, listVerified: true,
    state: 'unsupported', reason: 'native-plugin-entry-disabled' }))
  assert.equal(h.subject.pluginStatusUnsupported.value, true)
  assert.match(h.subject.pluginStatusMessage.value, /原生插件入口当前已禁用/)
})
