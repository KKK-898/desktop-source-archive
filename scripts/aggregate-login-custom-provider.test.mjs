import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, ref } from 'vue'

// Execute the production component's button condition and complete start/rewrite
// flow with desktop and relay boundaries mocked; no real credentials or requests.
const text = readFileSync(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
const script = text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('aggregate-start.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = ['startAggregateLogin', 'aggregateCanStart', 'codexLoginFailureDetails', 'showCodexLoginFailure']
const declarations = source.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.getText(source))),
)
assert.equal(declarations.length, names.length)
const compiled = ts.transpileModule(declarations.map(node => node.getText(source)).join('\n') + '\nglobalThis.subject={startAggregateLogin,aggregateCanStart};', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const relayProvider = () => ({ id: 'openai', name: '中转分组', tool: 'codex', groups: [{ id: 11, name: 'GPT', rateText: '1x', platform: 'openai', models: ['gpt-6-sol'], ready: true }] })
function harness(options = {}) {
  const calls = []
  const providers = ref(options.relay ? [relayProvider()] : [])
  const externalCount = ref(options.customCount ?? 2)
  const state = {
    computed, codexAccountMutationDepth: 0,
    beginCodexLoginFeedback: () => { calls.push(['mute-login']); return () => calls.push(['unmute-login']) },
    recordCodexLoginDiagnostics: (...args) => calls.push(['diagnostics', args]),
    stripSensitiveErrorText: value => String(value),
    confirmAction: async (message, settings) => { calls.push(['failure-dialog', message, settings]); return true },
    authToken: ref(options.loggedOut ? '' : 'app-session'),
    aggregateLoginError: ref(''), aggregateLoginNotice: ref(''),
    aggregateAvailableProviders: providers, aggregateExternalModelCount: externalCount,
    aggregateGroupCount: computed(() => providers.value.reduce((sum, provider) => sum + provider.groups.length, 0)),
    aggregateModelChoices: computed(() => providers.value.flatMap(provider => provider.groups.flatMap(group => group.models))),
    isAggregateLoginLoading: ref(false), isAggregateModelsLoading: ref(false), isAggregateLoginActive: ref(Boolean(options.active)),
    connectedTools: ref({ codex: false }), fuelPackAccountKey: ref(''), imageToolsMigrationFeedback: ref(null),
    window: { gaogeDesktop: {
      configureAggregateLogin: async request => {
        calls.push(['configure', structuredClone(request)])
        if (options.configureError) throw new Error(options.configureError)
        return { aggregate: { enabled: true, running: true, providerCount: 1, groupCount: 1, modelCount: 2 }, codexLaunched: true }
      },
    } },
    syncGroups: async request => {
      calls.push(['sync', structuredClone(request)])
      const count = calls.filter(([kind]) => kind === 'sync').length
      if (options.syncError && (!options.failSyncAt || options.failSyncAt === count)) throw new Error(options.syncError)
      if (options.discoverRelay) providers.value = [relayProvider()]
    },
    refreshAggregateModels: async () => { calls.push(['refresh']); for (const provider of providers.value) for (const group of provider.groups) group.ready = true },
    isAggregateGroupReady: group => group.ready,
    aggregateGroupFailureReason: () => '分组没有准备完成',
    confirmCodexRestart: async label => { calls.push(['confirm', label]); if (options.addRelayAtConfirm) providers.value = [relayProvider()]; return true },
    openCodexOperationDialog: (...args) => { calls.push(['open-operation', args]); return { update: update => calls.push(['operation', update]), close: () => calls.push(['close-operation']) } },
    beginCodexAccountMutation: () => { calls.push(['begin-mutation']); return () => calls.push(['end-mutation']) },
    tryEnsureCodexImageTools: async () => ({ key: '', warning: '' }),
    aggregateGroupTool: provider => provider.tool,
    currentCodexBaseUrl: () => 'https://relay.invalid/v1', currentClaudeBaseUrl: () => 'https://relay.invalid',
    ensureAggregateApiKey: async () => ({ key: 'mock-relay-key' }),
    invalidateCodexStatusRequests: () => calls.push(['invalidate']),
    applyCodexEnhancementResults: () => {}, applyAggregateLoginStatus: value => calls.push(['aggregate-status', value]),
    loadAggregateLoginStatus: async () => {}, applyCodexRouterSettings: () => {},
    localStorage: { removeItem: () => {} }, setCodexRelaySource: value => calls.push(['relay-source', value]),
    getImageToolsTargetFeedback: () => ({ notice: '', warning: '' }),
    showCodexLaunchFeedback: () => { throw Error('Login must not start popup verification') }, notify: (message, tone) => calls.push(['notify', message, tone]), showManualOpenNotice: () => {}, reportPageError: () => {},
    getGroupErrorMessage: error => error.message, getToolActionErrorMessage: error => error.message,
  }
  const context = vm.createContext(state)
  vm.runInContext(compiled, context)
  return { state, calls, ...context.subject }
}
const called = (h, name) => h.calls.filter(([kind]) => kind === name)

for (const active of [false, true]) {
  test(`${active ? 'rewrite' : 'first start'} with only saved custom interfaces skips relay synchronization`, async () => {
    const h = harness({ active, syncError: 'relay offline' })
    assert.equal(h.aggregateCanStart.value, true)
    await h.startAggregateLogin()
    assert.equal(called(h, 'sync').length, 0)
    assert.equal(called(h, 'refresh').length, 0)
    assert.equal(called(h, 'configure').length, 1)
    // The desktop app overlays saved custom routes, including protected keys.
    assert.deepEqual(called(h, 'configure')[0][1].providers, [])
    assert.equal(h.state.aggregateLoginError.value, '')
    assert.equal(h.state.connectedTools.value.codex, true)
    assert.equal(h.state.isAggregateLoginLoading.value, false)
    assert.equal(called(h, 'end-mutation').length, 1)
    assert.equal(called(h, 'open-operation').length, 0)
    assert.deepEqual(called(h, 'notify'), [['notify', '登录成功', 'success']])
  })
}

test('a participating relay group still rejects failed synchronization before any configuration', async () => {
  const h = harness({ relay: true, syncError: 'relay offline' })
  assert.equal(h.aggregateCanStart.value, true)
  await h.startAggregateLogin()
  assert.equal(called(h, 'sync').length, 1)
  assert.equal(called(h, 'confirm').length, 0)
  assert.equal(called(h, 'configure').length, 0)
  assert.match(h.state.aggregateLoginError.value, /读取中转站启用分组失败：relay offline/)
})

test('relay lookup still discovers groups when no custom interfaces are saved', async () => {
  const h = harness({ customCount: 0, discoverRelay: true })
  assert.equal(h.aggregateCanStart.value, false)
  await h.startAggregateLogin()
  assert.equal(called(h, 'sync').length, 2)
  assert.equal(called(h, 'configure').length, 1)
  assert.equal(called(h, 'configure')[0][1].providers[0].groups[0].id, 11)
  assert.equal(called(h, 'configure')[0][1].providers[0].groups[0].apiKey, 'mock-relay-key')
  assert.equal(h.state.aggregateLoginError.value, '')
})

test('the second relay synchronization remains strict after restart confirmation', async () => {
  const h = harness({ relay: true, syncError: 'changed relay state', failSyncAt: 2 })
  await h.startAggregateLogin()
  assert.equal(called(h, 'sync').length, 2)
  assert.equal(called(h, 'configure').length, 0)
  assert.equal(h.state.aggregateLoginError.value, 'changed relay state')
  assert.equal(h.state.isAggregateLoginLoading.value, false)
  assert.equal(called(h, 'end-mutation').length, 1)
  assert.equal(called(h, 'open-operation').length, 0)
  assert.equal(called(h, 'unmute-login').length, 1)
})

test('a relay group that appears during confirmation is synchronized instead of bypassed', async () => {
  const h = harness({ addRelayAtConfirm: true, syncError: 'new group unavailable' })
  await h.startAggregateLogin()
  assert.equal(called(h, 'sync').length, 1)
  assert.equal(called(h, 'configure').length, 0)
  assert.equal(h.state.aggregateLoginError.value, 'new group unavailable')
})

test('custom-only mode preserves desktop configuration errors', async () => {
  const h = harness({ syncError: 'relay offline', configureError: '自定义密钥无法解密' })
  await h.startAggregateLogin()
  assert.equal(called(h, 'sync').length, 0)
  assert.equal(called(h, 'configure').length, 1)
  assert.equal(h.state.aggregateLoginError.value, '自定义密钥无法解密')
  assert.equal(h.state.connectedTools.value.codex, false)
  assert.equal(h.state.isAggregateLoginLoading.value, false)
  assert.equal(called(h, 'end-mutation').length, 1)
})

test('custom-only startup still requires application login', async () => {
  const h = harness({ loggedOut: true })
  assert.equal(h.aggregateCanStart.value, false)
  await h.startAggregateLogin()
  assert.equal(h.state.aggregateLoginError.value, '请先登录账户。')
  assert.equal(called(h, 'sync').length, 0)
  assert.equal(called(h, 'confirm').length, 0)
  assert.equal(called(h, 'configure').length, 0)
})
