import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, ref } from 'vue'

// Execute production UI functions with isolated theme replies; no real app or files are modified.
const text = readFileSync(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
const script = text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('theme-ui.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = [
  'selectedCodexThemeId', 'isCodexThemeCatalogLoading', 'codexThemeCatalogError', 'codexThemeActiveName',
  'codexThemeRuntime', 'codexThemeCatalogGeneration', 'codexThemeCatalog', 'codexThemeCarouselStart',
  'codexThemeActionId', 'codexThemeActionType', 'codexThemeDownloadProgress', 'activeCodexTheme',
  'formatCodexThemeBytes', 'normalizeCodexThemeItem', 'loadCodexThemeCatalog', 'codexThemeRuntimeIsApplied',
  'codexThemeSelectionStatus', 'codexThemePrimaryActionDisabled', 'applyCodexThemeActionFeedback',
  'invalidateCodexThemeCatalogReads', 'codexThemePrimaryActionText', 'previewCodexThemeDownload',
  'restoreNativeCodexTheme', 'codexThemeCarouselSlots',
]
const declarations = source.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.getText(source))),
)
assert.equal(declarations.length, names.length)
const compiled = ts.transpileModule(declarations.map(node => node.getText(source)).join('\n') + '\nglobalThis.subject = { ' + names.join(',') + ' };', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const item = (extra = {}) => ({ id: 'sample-theme', name: '示例主题', installed: true, active: true, applied: false, pending: true, updateAvailable: false, enabled: true, version: '1.0.0', remoteVersion: '', platforms: ['windows'], sizeBytes: 100, ...extra })
const runtime = (extra = {}) => ({ selectedThemeId: 'sample-theme', appliedThemeId: '', runtimeReady: false, needsRestart: true, status: 'pending', ...extra })
const applied = (id = 'sample-theme') => runtime({ selectedThemeId: id, appliedThemeId: id, runtimeReady: true, needsRestart: false, status: 'applied' })
const catalog = (extra = {}) => ({ themes: [item()], activeThemeId: 'sample-theme', runtime: runtime(), ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function harness(options = {}) {
  const calls = [], notices = []
  const api = {
    listCodexThemes: async () => { calls.push(['list']); return options.list ? options.list() : catalog() },
    installCodexTheme: async id => { calls.push(['install', id]); return options.install ? options.install(id) : { installed: true, themeId: id, status: catalog(), runtime: runtime() } },
    activateCodexTheme: async id => { calls.push(['activate', id]); return options.activate ? options.activate(id) : { runtime: runtime({ selectedThemeId: id }), needsRestart: true } },
    deactivateCodexTheme: async () => { calls.push(['deactivate']); return options.deactivate ? options.deactivate() : { runtime: runtime({ selectedThemeId: '' }), needsRestart: true } },
    restartCodex: () => { throw new Error('Theme controls must not restart Codex') },
  }
  const context = vm.createContext({
    ref, computed, window: { gaogeDesktop: api },
    codexThemeFallbackCatalog: [], buildCodexThemeFallbackCatalog: () => [], mergeCodexThemeFallbackCatalog: items => items,
    getCodexThemeCatalogError: error => String(error?.message || error), getErrorMessage: error => String(error?.message || error),
    reportPageError: (...args) => calls.push(['report', ...args]), notify: (...args) => notices.push(args),
  })
  vm.runInContext(compiled, context)
  return { subject: context.subject, calls, notices }
}

test('the selected theme remains updateable and update has priority over its selected state', () => {
  const h = harness(), current = item({ updateAvailable: true, applied: true, pending: false })
  h.subject.codexThemeRuntime.value = applied()
  assert.equal(h.subject.codexThemePrimaryActionText(current), '更新')
  assert.equal(h.subject.codexThemePrimaryActionDisabled(current), false)
  assert.equal(h.subject.codexThemePrimaryActionDisabled(item()), true)
  h.subject.codexThemeActionId.value = 'another-theme'
  assert.equal(h.subject.codexThemePrimaryActionDisabled(current), true)
})

test('saved selection, pending application and verified application are separate states', async () => {
  const h = harness({ list: () => catalog({ themes: [item({ pending: false })], runtime: undefined }) })
  await h.subject.loadCodexThemeCatalog()
  assert.equal(h.subject.codexThemeSelectionStatus.value, '已选择')
  assert.equal(h.subject.codexThemePrimaryActionText(h.subject.activeCodexTheme.value), '已选择')
  h.subject.codexThemeRuntime.value = runtime()
  assert.equal(h.subject.codexThemeSelectionStatus.value, '待生效')
  h.subject.codexThemeRuntime.value = applied()
  assert.equal(h.subject.codexThemeSelectionStatus.value, '已应用')
  assert.equal(h.subject.codexThemePrimaryActionText(h.subject.activeCodexTheme.value), '已应用')
})

test('stale runtime identity, errors and restart requirements cannot claim applied', () => {
  const h = harness()
  for (const change of [{ appliedThemeId: 'old-theme' }, { selectedThemeId: 'old-theme' }, { runtimeReady: false }, { needsRestart: true }, { runtimeError: 'theme rejected' }]) {
    assert.equal(h.subject.codexThemeRuntimeIsApplied({ ...applied(), ...change }, 'sample-theme'), false)
  }
  assert.equal(h.subject.codexThemeRuntimeIsApplied(undefined, 'sample-theme'), false)
})

test('updating the selected theme keeps its selection and displays the verified hot-apply result', async () => {
  const h = harness({ install: id => ({ installed: true, themeId: id, runtime: applied(), status: catalog({ themes: [item({ version: '1.1.0', pending: false, applied: true })], runtime: applied() }) }) })
  const current = item({ updateAvailable: true })
  await h.subject.previewCodexThemeDownload(current)
  assert.deepEqual(h.calls, [['install', current.id]])
  assert.equal(h.subject.activeCodexTheme.value.id, current.id)
  assert.equal(h.subject.activeCodexTheme.value.version, '1.1.0')
  assert.equal(h.subject.codexThemeSelectionStatus.value, '已应用')
  assert.deepEqual(h.notices[0], ['示例主题 已更新并应用。', 'success', 'Codex 主题'])
})

test('a selected-theme update saved without a connection is pending, not an error or fake success', async () => {
  const h = harness()
  await h.subject.previewCodexThemeDownload(item({ updateAvailable: true }))
  assert.equal(h.subject.codexThemeSelectionStatus.value, '待生效')
  assert.match(h.notices[0][0], /已更新.*待 Codex 连接后生效/)
  assert.equal(h.notices[0][1], 'info')
})

test('selection uses actual runtime feedback and never automatically restarts Codex', async () => {
  const h = harness({ activate: () => ({ applied: true, runtime: applied() }), list: () => catalog({ runtime: applied() }) })
  await h.subject.previewCodexThemeDownload(item({ active: false }))
  assert.deepEqual(h.calls, [['activate', 'sample-theme'], ['list']])
  assert.equal(h.notices[0][0], '示例主题 已应用。')
  assert.doesNotMatch(h.notices[0][0], /重启/)
})

test('default-theme restoration is not called applied until its renderer restoration is verified', async () => {
  const h = harness({ list: () => catalog({ themes: [], activeThemeId: '', runtime: runtime({ selectedThemeId: '' }) }) })
  h.subject.codexThemeCatalog.value = [item()]
  await h.subject.restoreNativeCodexTheme()
  assert.deepEqual(h.calls, [['deactivate'], ['list']])
  assert.equal(h.subject.codexThemeSelectionStatus.value, '待生效')
  assert.equal(h.notices[0][1], 'info')
  assert.doesNotMatch(h.notices[0][0], /已应用/)
  h.subject.codexThemeRuntime.value = applied('')
  assert.equal(h.subject.codexThemeSelectionStatus.value, '已应用')
})

test('runtime errors keep the chosen theme and report incomplete application', async () => {
  const h = harness()
  h.subject.codexThemeCatalog.value = [item()]
  h.subject.applyCodexThemeActionFeedback({ applied: true, runtime: runtime({ runtimeError: 'unsupported-theme-layout' }) }, 'sample-theme', '示例主题')
  assert.equal(h.subject.activeCodexTheme.value.id, 'sample-theme')
  assert.equal(h.subject.codexThemeSelectionStatus.value, '应用未完成')
  assert.equal(h.notices[0][1], 'warning')
  assert.match(h.notices[0][0], /unsupported-theme-layout/)
})

test('a delayed old catalog cannot overwrite a new selected-theme update', async () => {
  const response = deferred()
  const h = harness({ list: () => response.promise, install: id => ({ installed: true, themeId: id, runtime: applied(), status: catalog({ runtime: applied(), themes: [item({ version: '2.0.0' })] }) }) })
  const loading = h.subject.loadCodexThemeCatalog()
  await h.subject.previewCodexThemeDownload(item({ updateAvailable: true }))
  response.resolve(catalog({ themes: [item({ version: '0.9.0' })] }))
  await loading
  assert.equal(h.subject.activeCodexTheme.value.version, '2.0.0')
  assert.equal(h.subject.codexThemeSelectionStatus.value, '已应用')
  assert.equal(h.subject.isCodexThemeCatalogLoading.value, false)
})

test('only the newest catalog refresh can publish its status', async () => {
  const first = deferred(), second = deferred(); let request = 0
  const h = harness({ list: () => ++request === 1 ? first.promise : second.promise })
  const a = h.subject.loadCodexThemeCatalog(), b = h.subject.loadCodexThemeCatalog()
  second.resolve(catalog({ runtime: applied() })); await b
  first.resolve(catalog()); await a
  assert.equal(h.subject.codexThemeSelectionStatus.value, '已应用')
})

test('failed updates preserve the existing theme and release the operation lock', async () => {
  const h = harness({ install: () => { throw new Error('package hash mismatch') } })
  h.subject.codexThemeCatalog.value = [item()]
  await h.subject.previewCodexThemeDownload(item({ updateAvailable: true }))
  assert.equal(h.subject.activeCodexTheme.value.version, '1.0.0')
  assert.equal(h.subject.codexThemeActionId.value, '')
  assert.equal(h.notices[0][1], 'error')
  assert.match(h.notices[0][0], /hash mismatch/)
})

const apiText = readFileSync(new URL('../src/desktop-api.ts', import.meta.url), 'utf8')
const apiSource = ts.createSourceFile('desktop-api.ts', apiText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const apiNames = ['versionedCodexThemePreviewUrl', 'normalizeCodexThemeList']
const apiDeclarations = apiSource.statements.filter(node => ts.isFunctionDeclaration(node) && apiNames.includes(node.name?.text))
assert.equal(apiDeclarations.length, apiNames.length)
const apiCompiled = ts.transpileModule(apiDeclarations.map(node => node.getText(apiSource)).join('\n').replaceAll('import.meta.env.DEV', 'false') + '\nglobalThis.subject = { ' + apiNames.join(',') + ' };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const apiContext = vm.createContext({ URLSearchParams, convertFileSrc: path => 'http://asset.local/' + encodeURIComponent(path) })
vm.runInContext(apiCompiled, apiContext)

test('preview revision changes invalidate a local image URL, including same-version replacements', () => {
  const normalize = previewRevision => apiContext.subject.normalizeCodexThemeList(catalog({ themes: [item({ previewPath: 'C:/themes/sample/preview.webp', previewRevision })] })).themes[0].previewUrl
  const first = normalize('mtime-size-1'), repeated = normalize('mtime-size-1'), replaced = normalize('mtime-size-2')
  assert.equal(first, repeated)
  assert.notEqual(first, replaced)
  assert.equal(new URL(replaced).searchParams.get('theme-version'), 'mtime-size-2')
})

test('remote and local preview fallback keys use their actual resource versions', () => {
  const local = apiContext.subject.normalizeCodexThemeList(catalog({ themes: [item({ previewPath: 'C:/preview.webp', remoteVersion: '2.0.0' })] })).themes[0]
  const remote = apiContext.subject.normalizeCodexThemeList(catalog({ themes: [item({ previewUrl: 'https://example.test/preview.webp?token=ok#image', remoteVersion: '2.0.0' })] })).themes[0]
  assert.equal(new URL(local.previewUrl).searchParams.get('theme-version'), '1.0.0')
  assert.equal(new URL(remote.previewUrl).searchParams.get('theme-version'), '2.0.0')
  assert.equal(new URL(remote.previewUrl).searchParams.get('token'), 'ok')
  assert.equal(new URL(remote.previewUrl).hash, '#image')
})

test('theme controls use the update-aware action and expose a read-only refresh', () => {
  assert.match(text, /:disabled="codexThemePrimaryActionDisabled\(slot\.item\)"/)
  assert.match(text, /title="检查主题更新与生效状态"[\s\S]{0,180}@click="loadCodexThemeCatalog\(\)"/)
  assert.match(text, /<small>\{\{ codexThemeSelectionStatus \}\}<\/small>/)
})


test('small and large theme libraries always retain exactly one actionable center card', () => {
  const h = harness()
  for (let total = 1; total <= 10; total += 1) {
    h.subject.codexThemeCatalog.value = Array.from({ length: total }, (_, index) => item({ id: 'theme-' + index }))
    h.subject.codexThemeCarouselStart.value = total - 1
    const slots = h.subject.codexThemeCarouselSlots.value
    assert.equal(slots.filter(slot => slot.position === 'center').length, 1, 'count=' + total)
    assert.equal(slots.find(slot => slot.position === 'center').item.id, 'theme-' + (total - 1))
    assert.equal(new Set(slots.map(slot => slot.key)).size, slots.length)
    assert.equal(slots.length, Math.min(7, total))
  }
})
