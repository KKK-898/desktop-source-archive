import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { harness, router } from './codex-account-route-harness.mjs'

const sourceText = readFileSync(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
const source = ts.createSourceFile('model-policy.ts', sourceText.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const subject = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveCodexModelSelection')
assert.ok(subject, 'Use the production model preflight, not a test implementation')
const compiled = ts.transpileModule(subject.getText(source) + '\nglobalThis.resolveSelection = resolveCodexModelSelection;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

test('each login model preflight explicitly refreshes instead of trusting a cached catalog', async () => {
  const requests = []
  const context = vm.createContext({
    fetchCodexModelList: async (key, options) => { requests.push({key, options}); return {models: ['vendor-model-live'], fallback: false} },
    extractCodexConversationModelNames: value => value.models,
    CODEX_FALLBACK_MODELS: ['legacy-model'], CODEX_MODEL_SELECTION_ORIGIN_STORAGE_KEY: 'origin',
    codexRouterForm: { value: { model: 'legacy-model' } },
    codexModelSelectionMode: { value: 'upstream' },
    localStorage: { getItem: () => 'automatic' },
    normalizeCodexModelSelectionOrigin: value => value,
    selectCodexConversationModel: models => models[0],
    currentCodexBaseUrl: () => 'https://relay.test/v1', persistCodexRouterForm: () => {},
  })
  vm.runInContext(compiled, context)
  const options = {groupId: 3, apiKeyId: 11}
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await context.resolveSelection('user-key', options)
    assert.equal(result.model, 'vendor-model-live')
    assert.equal(result.fallback, false)
  }
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.key, 'user-key')
    assert.equal(request.options.force, true)
    assert.equal(request.options.groupId, 3)
    assert.equal(request.options.apiKeyId, 11)
  }
  assert.deepEqual(options, {groupId: 3, apiKeyId: 11}, 'Do not mutate caller options')
})

for (const page of ['已有账号加油', '无账号登录']) {
  test(page + ' displays the native policy catalog and keeps policy failure warning', async () => {
    const warning = '模型支持配置暂不可用，已保留上次成功的模型支持配置。'
    const h = harness({ fuel: true, page, api: {
      configureCodex: async () => ({
        router: router(true), codexLaunched: true, model: 'vendor-model-live',
        modelCatalogSource: 'upstream', modelCatalogModels: ['vendor-model-live'],
        modelCatalogWarning: warning, desktopModelSupportEnabled: true,
      }),
    } })
    h.state.codexModelOptions.value = ['removed-model']
    h.state.resolveCodexModelSelection = async () => ({
      model: 'legacy-model', mode: 'upstream', source: 'fallback',
      supportedModels: ['legacy-model'], warning: '暂未读取到上游模型目录，已使用四个默认模型。',
    })
    await h.connectToolForActivePage()
    assert.equal(h.state.toolErrors.value.codex, '')
    assert.deepEqual(Array.from(h.state.codexModelOptions.value), ['vendor-model-live'])
    assert.equal(h.state.codexRouterForm.value.model, 'vendor-model-live')
    assert.equal(h.state.codexModelCatalogSource.value, 'upstream')
    assert.match(h.state.loginModelsNotice.value, /按服务端模型支持配置写入 1 个模型/)
    assert.match(h.state.toolWarnings.value.codex, /保留上次成功/)
    assert.match(h.state.toolWarnings.value.codex, /已写入 1 个模型/)
    assert.doesNotMatch(h.state.toolWarnings.value.codex, /四个默认模型|removed-model|legacy-model/)
    h.stopCodexUltraStatusCheck()
  })
}

test('disabled policy retains the existing upstream-fallback explanation', async () => {
  const h = harness({fuel: true, page: '无账号登录', api: {
    configureCodex: async () => ({router: router(true), codexLaunched: true, desktopModelSupportEnabled: false}),
  }})
  h.state.resolveCodexModelSelection = async () => ({
    model: 'legacy-model', mode: 'upstream', supportedModels: ['legacy-model'], warning: '原有上游读取失败提示。',
  })
  await h.connectToolForActivePage()
  assert.match(h.state.toolWarnings.value.codex, /原有上游读取失败提示/)
  h.stopCodexUltraStatusCheck()
})

test('restart presents remote-policy fallback warnings rather than claiming an unconditional refresh', async () => {
  const warning = '模型支持配置暂不可用，已保留上次成功的模型支持配置。'
  const h = harness({api: {restartCodex: async () => ({codexLaunched: true, warnings: [warning]})}})
  await h.restartCodexForActivePage()
  assert.equal(h.state.toolErrors.value.codex, '')
  assert.match(h.state.toolWarnings.value.codex, /保留上次成功/)
  assert.equal(h.state.toolNotices.value.codex, '')
  h.stopCodexUltraStatusCheck()
})

const listingNames = ['requestCodexModelList', 'requestAggregateCodexModelList', 'applyCodexModelList']
const listingDeclarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && listingNames.includes(node.name?.text))
assert.equal(listingDeclarations.length, listingNames.length)
const listingCode = ts.transpileModule(listingDeclarations.map(node => node.getText(source)).join('\n') + '\nglobalThis.listingSubjects = {requestCodexModelList, requestAggregateCodexModelList, applyCodexModelList};', {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText
function listingHarness(response) {
  const calls = []
  let fallbacks = 0
  const context = vm.createContext({
    window: {gaogeDesktop: {fetchCodexModels: async request => {calls.push(request); if (response instanceof Error) throw response; return response}}},
    getCurrentApiBaseUrl: () => 'https://control.test/custom/api/v1',
    currentCodexBaseUrl: () => 'https://relay.test/v1',
    extractCodexConversationModelNames: value => value.models,
    CODEX_FALLBACK_MODELS: ['legacy-model'],
    codexFallbackModelResult: () => {fallbacks++; return {models:['legacy-model'], fallback:true}},
    reportPageError: () => {},
    codexModelOptions: {value: []}, codexModelCatalogSource: {value:'fallback'},
    loginModelsNotice: {value:''}, loginModelsError: {value:''},
  })
  vm.runInContext(listingCode, context)
  return {context, calls, subjects:context.listingSubjects, fallbacks:() => fallbacks}
}

test('ordinary model refresh opts into native policy while aggregate discovery remains unchanged', async () => {
  const h = listingHarness({models:['vendor/new-primary'], fallback:false})
  await h.subjects.requestCodexModelList('ordinary-key')
  await h.subjects.requestAggregateCodexModelList({key:'aggregate-key'}, {name:'fixture',defaultModels:[]})
  assert.equal(h.calls[0].applyDesktopModelSupport,true)
  assert.equal(h.calls[0].baseUrl,'https://relay.test/v1')
  assert.equal(h.calls[0].modelPolicyApiBaseUrl,'https://control.test/custom/api/v1')
  assert.equal(h.calls[1].applyDesktopModelSupport,undefined)
  assert.equal(h.calls[1].modelPolicyApiBaseUrl,undefined)
  assert.equal(h.calls[1].apiKey,'aggregate-key')
})

test('policy refresh failure propagates instead of displaying unrestricted fallback models', async () => {
  const failure = new Error('CODEX_MODEL_SUPPORT_UNAVAILABLE: no verified cache')
  const h = listingHarness(failure)
  await assert.rejects(h.subjects.requestCodexModelList('key'),/CODEX_MODEL_SUPPORT_UNAVAILABLE/)
  assert.equal(h.fallbacks(),0)
})

test('ordinary legacy upstream failure preserves its explicit compatibility fallback', async () => {
  const h = listingHarness(new Error('upstream network error'))
  const result = await h.subjects.requestCodexModelList('key')
  assert.equal(result.fallback,true)
  assert.equal(h.fallbacks(),1)
})

test('model list keeps native cached-policy warning visible', async () => {
  const warning='已保留当前服务器上次成功的模型支持策略，未回退全量模型。'
  const h = listingHarness({models:['vendor/new-primary'],fallback:false,message:warning})
  const result=await h.subjects.requestCodexModelList('key')
  h.subjects.applyCodexModelList(result)
  assert.deepEqual(Array.from(h.context.codexModelOptions.value),['vendor/new-primary'])
  assert.match(h.context.loginModelsNotice.value,/保留当前服务器上次成功/)
  assert.equal(h.context.loginModelsError.value,'')
})

for (const page of ['已有账号加油', '无账号登录']) {
  test(page + ' sends the selected control API independently from the relay endpoint', async () => {
    const h = harness({fuel:true, page})
    h.state.getCurrentApiBaseUrl = () => 'https://control.test/custom/api/v1'
    await h.connectToolForActivePage()
    assert.equal(h.state.toolErrors.value.codex,'')
    const writes = h.calls.filter(([kind]) => kind === 'configure')
    assert.equal(writes.length,1)
    assert.equal(writes[0][1].baseUrl,'https://relay.test/v1')
    assert.equal(writes[0][1].modelPolicyApiBaseUrl,'https://control.test/custom/api/v1')
    h.stopCodexUltraStatusCheck()
  })
}

test('restart sends the selected control and relay addresses as an explicit pair', async () => {
  const requests=[]
  const h=harness({api:{restartCodex:async request=>{requests.push(request);return {codexLaunched:true}}}})
  h.state.getCurrentApiBaseUrl=()=> 'https://control.test/custom/api/v1'
  await h.restartCodexForActivePage()
  assert.equal(h.state.toolErrors.value.codex,'')
  assert.equal(requests.length,1)
  assert.equal(requests[0].modelPolicyApiBaseUrl,'https://control.test/custom/api/v1')
  assert.equal(requests[0].relayBaseUrl,'https://relay.test/v1')
  h.stopCodexUltraStatusCheck()
})
