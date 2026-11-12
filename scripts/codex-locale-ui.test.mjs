import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, ref } from 'vue'

// Real UI state transitions with in-memory preferences. Never touches Codex.
const text = readFileSync(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
const script = text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('locale-ui.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = ['settingStorageKeys', 'settingToggles', 'settingLoading', 'settingErrors', 'settingNotices', 'codexLanguageNeedsRestart', 'loadCodexLanguageSettings', 'applyLanguageSetting', 'persistSettingToggle', 'toggleSetting', 'codexLaunchPathParts', 'handleWindowFocus', 'refreshCurrentPageAfterWindowRestore']
const declarations = source.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.getText(source))),
)
assert.equal(declarations.length, names.length)
const compiled = ts.transpileModule(declarations.map(node => node.getText(source)).join('\n') + '\nglobalThis.subject = { ' + names.join(',') + ' };', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function harness(options = {}) {
  const calls = []
  const storage = new Map(options.storage || [])
  const launchTarget = ref({ effectivePath: options.path || '' })
  const context = vm.createContext({
    ref, computed, codexLaunchTarget: launchTarget,
    activePage: ref(options.page || '系统配置'), isNewThemeAuthenticated: ref(true), loginPanels: ref({}),
    refreshAuthSessionIfNeeded: () => {}, loadCodexRouterStatus: async () => {},
    checkUnreadDesktopAnnouncements: async () => {}, isOfficialSubscriptionPage: () => false,
    resetRefreshStateAfterWindowRestore: () => {}, resumePendingRechargeBonusQueue: () => {},
    resumePendingOfficialSubscriptionOrders: () => {}, loadCodexSessionStats: async () => {},
    loadCodexAccounts: async () => {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    reportPageError: (...args) => calls.push(['report', ...args]),
    getErrorMessage: error => String(error?.message || error),
    window: { gaogeDesktop: {
      getCodexLanguageSettings: async request => { calls.push(['get', JSON.parse(JSON.stringify(request))]); return options.get ? options.get(request) : { enabled: request.legacyEnabled !== false, needsRestart: true } },
      setCodexLanguage: async request => { calls.push(['set', JSON.parse(JSON.stringify(request))]); return options.set ? options.set(request) : { enabled: request.enabled, needsRestart: false } },
      restartCodex: () => { throw new Error('Language setting must not restart Codex') },
    } },
    confirmCodexClose: () => { throw new Error('Language setting must not close Codex') },
    installCodexApp: () => { throw new Error('Language setting must not install Codex') },
  })
  if (options.withoutMutationApi) delete context.window.gaogeDesktop.setCodexLanguage
  vm.runInContext(compiled, context)
  return { subject: context.subject, storage, calls, launchTarget }
}

const key = 'gaoge_desktop_setting_language'
test('a fresh user defaults on and initializes backend settings without a language history', async () => {
  const h = harness()
  assert.equal(h.subject.settingToggles.value.language, true)
  await h.subject.loadCodexLanguageSettings({ silent: true })
  assert.deepEqual(h.calls, [['get', {}]])
  assert.equal(h.storage.get(key), 'true')
  assert.equal(h.subject.codexLanguageNeedsRestart.value, true)
  assert.equal(h.subject.settingNotices.value.language, '')
})

test('legacy explicit off is offered for migration while backend preference remains authoritative', async () => {
  const h = harness({ storage: [[key, 'false']], get: () => ({ enabled: true, needsRestart: false }) })
  assert.equal(h.subject.settingToggles.value.language, false)
  await h.subject.loadCodexLanguageSettings()
  assert.deepEqual(h.calls, [['get', { legacyEnabled: false }]])
  assert.equal(h.subject.settingToggles.value.language, true)
  assert.equal(h.storage.get(key), 'true')
})

test('an initialization in flight blocks duplicate reads and toggle mutations', async () => {
  const result = deferred()
  const h = harness({ get: () => result.promise })
  const reading = h.subject.loadCodexLanguageSettings()
  await h.subject.loadCodexLanguageSettings()
  await h.subject.toggleSetting('language')
  assert.equal(h.calls.length, 1)
  assert.equal(h.subject.settingLoading.value.language, true)
  result.resolve({ enabled: false })
  await reading
  assert.equal(h.subject.settingLoading.value.language, false)
  assert.equal(h.subject.settingToggles.value.language, false)
})

test('saving off is serialized, persisted only on success, and survives UI reload', async () => {
  const result = deferred()
  const h = harness({ set: () => result.promise })
  const saving = h.subject.toggleSetting('language')
  await h.subject.toggleSetting('language')
  assert.deepEqual(h.calls, [['set', { enabled: false }]])
  assert.equal(h.subject.settingToggles.value.language, true)
  assert.equal(h.storage.has(key), false)
  result.resolve({ enabled: false, needsRestart: true })
  await saving
  assert.equal(h.subject.settingToggles.value.language, false)
  assert.equal(h.storage.get(key), 'false')
  assert.match(h.subject.settingNotices.value.language, /重启 Codex 后生效/)
  const reloaded = harness({ storage: [...h.storage], get: () => ({ enabled: false }) })
  await reloaded.subject.loadCodexLanguageSettings()
  assert.equal(reloaded.subject.settingToggles.value.language, false)
})

test('a failed save keeps the confirmed preference and reports the failure', async () => {
  const h = harness({ storage: [[key, 'true']], set: () => { throw new Error('isolated disk failure') } })
  await h.subject.toggleSetting('language')
  assert.equal(h.subject.settingToggles.value.language, true)
  assert.equal(h.storage.get(key), 'true')
  assert.equal(h.subject.settingLoading.value.language, false)
  assert.match(h.subject.settingErrors.value.language, /disk failure/)
  assert.equal(h.subject.settingNotices.value.language, '')
})

test('a failed initial read neither writes a preference nor announces success', async () => {
  const h = harness({ get: () => { throw new Error('isolated read failure') } })
  await h.subject.loadCodexLanguageSettings({ silent: true })
  assert.equal(h.storage.has(key), false)
  assert.equal(h.subject.settingLoading.value.language, false)
  assert.equal(h.subject.settingNotices.value.language, '')
})

test('compact path splitting preserves full path and executable name for Windows and POSIX', () => {
  const windows = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`
  const h = harness({ path: windows })
  assert.equal(h.subject.codexLaunchPathParts.value.filename, 'ChatGPT.exe')
  assert.equal(h.subject.codexLaunchPathParts.value.directory + h.subject.codexLaunchPathParts.value.filename, windows)
  h.launchTarget.value.effectivePath = '/Applications/Codex.app/Contents/MacOS/Codex'
  assert.equal(h.subject.codexLaunchPathParts.value.filename, 'Codex')
  h.launchTarget.value.effectivePath = ''
  assert.equal(h.subject.codexLaunchPathParts.value.directory, '')
  assert.equal(h.subject.codexLaunchPathParts.value.filename, '')
})


test('focus and restore refresh a pending restart badge through reads without reapplying a preference', async () => {
  let applied = false
  const h = harness({ get: () => ({ enabled: true, needsRestart: !applied }) })
  await h.subject.loadCodexLanguageSettings()
  assert.equal(h.subject.codexLanguageNeedsRestart.value, true)
  applied = true
  h.subject.handleWindowFocus()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.subject.codexLanguageNeedsRestart.value, false)
  h.subject.codexLanguageNeedsRestart.value = true
  h.subject.refreshCurrentPageAfterWindowRestore()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.subject.codexLanguageNeedsRestart.value, false)
  assert.equal(h.calls.filter(([name]) => name === 'get').length, 3)
  assert.equal(h.calls.some(([name]) => name === 'set'), false)
})

test('background status events never overwrite an in-flight user save', async () => {
  const result = deferred()
  const h = harness({ set: () => result.promise })
  const saving = h.subject.toggleSetting('language')
  h.subject.handleWindowFocus()
  h.subject.refreshCurrentPageAfterWindowRestore()
  assert.deepEqual(h.calls, [['set', { enabled: false }]])
  result.resolve({ enabled: false, needsRestart: false })
  await saving
  assert.equal(h.subject.settingToggles.value.language, false)
  assert.equal(h.storage.get(key), 'false')
})

test('focus and restore on other pages do not issue locale reads or writes', async () => {
  const h = harness({ page: '仪表盘' })
  h.subject.handleWindowFocus()
  h.subject.refreshCurrentPageAfterWindowRestore()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls, [])
})

test('a missing mutation bridge reports an actionable error without changing the preference', async () => {
  const h = harness({ withoutMutationApi: true })
  await h.subject.toggleSetting('language')
  assert.equal(h.subject.settingToggles.value.language, true)
  assert.equal(h.storage.has(key), false)
  assert.equal(h.subject.settingLoading.value.language, false)
  assert.match(h.subject.settingErrors.value.language, /无法保存中文设置/)
})
