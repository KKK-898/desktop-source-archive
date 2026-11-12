import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

// The actual component and CSS run in a browser; desktop methods are isolated mocks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let artifacts, server, browser, baseUrl
const pageErrors = []
before(async () => {
  artifacts = await mkdtemp(path.join(os.tmpdir(), 'gaoge-aggregate-settings-ui-'))
  const entry = `import {createApp,h} from 'vue';import Settings from '/src/components/AggregateModelSettings.vue';createApp({render(){return h(Settings,{groups:window.__settings.groups,onSaved:snapshot=>window.__settings.emitted.push(structuredClone(snapshot))})}}).mount('#app');`
  await build({ root, configFile: false, logLevel: 'error', plugins: [vue(), { name: 'isolated-aggregate-settings', resolveId(id) { if (id === 'virtual:aggregate-settings') return '\0aggregate-settings' }, load(id) { if (id === '\0aggregate-settings') return entry } }], build: { outDir: artifacts, emptyOutDir: false, rollupOptions: { input: 'virtual:aggregate-settings', output: { entryFileNames: 'settings.js', assetFileNames: '[name][extname]' } } } })
  const css = (await readdir(artifacts)).filter(name => name.endsWith('.css'))
  const html = '<!doctype html><html><head><meta charset="UTF-8"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;background:#f5f7fa}#app{max-width:1100px;margin:30px auto;padding:0 20px}</style>' + css.map(name => `<link rel="stylesheet" href="/${name}">`).join('') + '</head><body><div id="app"></div><script type="module" src="/settings.js"></script></body></html>'
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
      if (pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return }
      const file = path.resolve(artifacts, '.' + pathname)
      if (!file.startsWith(artifacts + path.sep)) { res.statusCode = 403; res.end(); return }
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(file))
    } catch { res.statusCode = 404; res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = 'http://127.0.0.1:' + server.address().port
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) { if (!String(error).includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: 'chrome' }) }
}, { timeout: 60000 })
after(async () => { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }; console.log('Aggregate settings screenshots: ' + artifacts); assert.deepEqual(pageErrors, []) })
async function pageFor(options = {}) {
  const page = await browser.newPage({ viewport: { width: options.width || 1200, height: options.height || 980 } })
  page.setDefaultTimeout(7000)
  page.on('pageerror', error => pageErrors.push(error.message))
  // No upstream or real desktop access is permitted in this suite.
  await page.route('**/*', route => route.request().url().startsWith(baseUrl) ? route.continue() : route.abort())
  await page.addInitScript(options => {
    const snapshot = {
      version: 1,
      groups: [{ providerId: 'relay', groupId: 'primary', protocol: 'responses', modelSettings: {} }],
      providers: [{ id: 'external-saved', vendor: 'custom', name: '已有接口', baseUrl: 'https://one.example/v1', protocol: 'responses', apiKey: '', keyConfigured: true, models: ['gpt-6-sol'], modelSettings: {} }],
      presets: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/', protocol: 'chatCompletions', model: 'deepseek-v4-pro', modelList: ['deepseek-v4-pro', 'deepseek-v4-flash'] }, { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropicMessages', model: 'claude-example', modelList: [] }],
      modelCatalog: [{ slug: 'gpt-6-sol', provider: 'openai', contextWindow: 272000, maxContextWindow: 872000, source: 'OpenAI', metadata: { service_tiers: [{ id: 'priority', name: 'Fast' }], additional_speed_tiers: ['fast'] } }, { slug: 'deepseek-v4-pro', provider: 'deepseek', contextWindow: 1048576, maxContextWindow: 1048576, source: 'DeepSeek', metadata: { service_tiers: [] } }],
    }
    if (options.providers) snapshot.providers = options.providers
    const state = window.__settings = { snapshot, groups: [{ providerId: 'relay', providerName: '测试中转', groupId: 'primary', groupName: '主要分组', models: ['gpt-6-sol', 'deepseek-v4-pro', 'custom-unknown'] }], calls: [], emitted: [], options }
    if (options.noBuiltin) state.groups = []
    window.gaogeDesktop = {
      getAggregateModelSettings: async () => { state.calls.push({ method: 'read' }); return structuredClone(state.snapshot) },
      saveAggregateModelSettings: async payload => {
        state.calls.push({ method: 'save', payload: structuredClone(payload) })
        if (options.deferSave) await new Promise(resolve => { window.__finishSettingsSave = resolve })
        state.snapshot = { ...state.snapshot, ...structuredClone(payload), providers: payload.providers.map(provider => ({ ...structuredClone(provider), apiKey: '', keyConfigured: Boolean(provider.apiKey || provider.keyConfigured) })) }
        return structuredClone(state.snapshot)
      },
    }
  }, options)
  await page.goto(baseUrl)
  await page.waitForFunction(() => window.__settings.emitted.length === 1)
  return page
}
async function open(page) { await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByRole('dialog').waitFor() }
async function custom(page) { await page.getByRole('tab', { name: /^自有聚合/ }).click() }
async function builtin(page) { await page.getByRole('tab', { name: /^内置聚合/ }).click() }
async function saved(page, count = 1) { await page.waitForFunction(count => window.__settings.calls.filter(call => call.method === 'save').length === count && window.__settings.emitted.length === count + 1, count) }
async function lastPayload(page) { return page.evaluate(() => window.__settings.calls.filter(call => call.method === 'save').at(-1).payload) }

test('read-only mount emits its snapshot and model fields remain independent', async () => {
  const page = await pageFor()
  assert.deepEqual(await page.evaluate(() => window.__settings.calls), [{ method: 'read' }])
  await open(page)
  assert.equal(await page.getByLabel('接口协议', { exact: true }).inputValue(), 'responses')
  assert.equal(await page.getByLabel('上下文窗口', { exact: true }).inputValue(), '')
  assert.equal(await page.getByLabel('上下文窗口', { exact: true }).getAttribute('placeholder'), '272000')
  await page.getByLabel('上下文窗口', { exact: true }).fill('300000')
  await page.getByLabel('自动压缩比例', { exact: true }).fill('80')
  await page.getByLabel('原生 Fast', { exact: true }).selectOption('supported')
  await page.getByLabel('模型', { exact: true }).selectOption('deepseek-v4-pro')
  assert.equal(await page.getByLabel('上下文窗口', { exact: true }).inputValue(), '')
  assert.equal(await page.getByLabel('原生 Fast', { exact: true }).inputValue(), 'inherit')
  await page.getByLabel('上下文窗口', { exact: true }).fill('700000')
  await page.getByLabel('自动压缩比例', { exact: true }).fill('90')
  await page.getByLabel('原生 Fast', { exact: true }).selectOption('unsupported')
  await page.getByLabel('模型', { exact: true }).selectOption('custom-unknown')
  assert.equal(await page.getByLabel('上下文窗口', { exact: true }).inputValue(), '')
  assert.equal(await page.getByLabel('上下文窗口', { exact: true }).getAttribute('placeholder'), '待配置')
  assert.ok((await page.locator('.aggregate-model-source').innerText()).includes('待配置'))
  await page.getByLabel('模型', { exact: true }).selectOption('gpt-6-sol')
  assert.equal(await page.getByLabel('上下文窗口', { exact: true }).inputValue(), '300000')
  assert.equal(await page.getByLabel('自动压缩比例', { exact: true }).inputValue(), '80')
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page)
  const payload = await lastPayload(page)
  assert.deepEqual(payload.groups[0].modelSettings, { 'gpt-6-sol': { contextWindow: 300000, autoCompactPercent: 80, fast: 'supported' }, 'deepseek-v4-pro': { contextWindow: 700000, autoCompactPercent: 90, fast: 'unsupported' } })
  assert.equal(payload.providers[0].apiKey, '')
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor()
  await page.screenshot({ path: path.join(artifacts, 'models-desktop.png') })
  await page.close()
})

test('saved passwords stay blank; changing URL or protocol requires a newly entered key', async () => {
  const page = await pageFor(); await open(page)
  await custom(page)
  await page.getByRole('button', { name: '已有接口 1 个模型', exact: true }).click()
  assert.equal(await page.getByLabel('API Key', { exact: true }).getAttribute('type'), 'password')
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '')
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page)
  assert.equal((await lastPayload(page)).providers[0].apiKey, '')
  await page.getByLabel('API 地址', { exact: true }).fill('https://other.example/v1')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '重新输入 API Key' }).waitFor()
  assert.equal(await page.evaluate(() => window.__settings.calls.filter(call => call.method === 'save').length), 1)
  await page.getByLabel('API Key', { exact: true }).fill('test-key-for-other-host')
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page, 2)
  assert.equal((await lastPayload(page)).providers[0].apiKey, 'test-key-for-other-host')
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '')
  await page.getByLabel('接口协议', { exact: true }).selectOption('chatCompletions')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '重新输入 API Key' }).waitFor()
  assert.equal(await page.evaluate(() => window.__settings.calls.filter(call => call.method === 'save').length), 2)
  assert.equal(await page.evaluate(() => localStorage.length), 0)
  await page.close()
})

test('Anthropic disables Fast support and clears supported declarations on protocol changes', async () => {
  const page = await pageFor(); await open(page)
  await page.getByLabel('原生 Fast', { exact: true }).selectOption('supported')
  await page.getByLabel('接口协议', { exact: true }).selectOption('anthropicMessages')
  assert.equal(await page.getByLabel('原生 Fast', { exact: true }).inputValue(), 'unsupported')
  assert.equal(await page.getByLabel('原生 Fast', { exact: true }).locator('option[value="supported"]').evaluate(option => option.disabled), true)
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page)
  assert.equal((await lastPayload(page)).groups[0].protocol, 'anthropicMessages')
  assert.equal((await lastPayload(page)).groups[0].modelSettings['gpt-6-sol'].fast, 'unsupported')
  await page.close()
})

test('a preset prefills its declared protocol and models; manually added unknown models get no invented window', async () => {
  const page = await pageFor(); await open(page)
  await custom(page)
  await page.getByLabel('添加接口', { exact: true }).selectOption('deepseek')
  await page.getByRole('button', { name: '添加接口', exact: true }).click()
  assert.equal(await page.getByLabel('接口名称', { exact: true }).inputValue(), 'DeepSeek')
  assert.equal(await page.getByLabel('API 地址', { exact: true }).inputValue(), 'https://api.deepseek.com/')
  assert.equal(await page.getByLabel('接口协议', { exact: true }).inputValue(), 'chatCompletions')
  assert.deepEqual(await page.getByLabel('模型', { exact: true }).locator('option').evaluateAll(items => items.map(item => item.value)), ['deepseek-v4-pro', 'deepseek-v4-flash'])
  await page.getByLabel('新模型 ID', { exact: true }).fill('private-model')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'private-model')
  assert.equal(await page.getByLabel('上下文窗口', { exact: true }).getAttribute('placeholder'), '待配置')
  await page.getByLabel('API Key', { exact: true }).fill('test-key-only')
  await page.getByLabel('上下文窗口', { exact: true }).fill('128000')
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page)
  const provider = (await lastPayload(page)).providers.find(provider => provider.vendor === 'deepseek')
  assert.match(provider.id, /^external-/)
  assert.deepEqual(provider.models, ['deepseek-v4-pro', 'deepseek-v4-flash', 'private-model'])
  assert.deepEqual(provider.modelSettings, { 'private-model': { contextWindow: 128000 } })
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '')
  await page.screenshot({ path: path.join(artifacts, 'provider-desktop.png') })
  await page.close()
})

test('invalid model limits never save; reset affects only the selected model', async () => {
  const page = await pageFor(); await open(page)
  await page.getByLabel('上下文窗口', { exact: true }).fill('1023')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '窗口须为' }).waitFor()
  assert.equal(await page.evaluate(() => window.__settings.calls.filter(call => call.method === 'save').length), 0)
  await page.getByRole('button', { name: '恢复此模型的自动设置', exact: true }).click()
  await page.getByLabel('自动压缩比例', { exact: true }).fill('101')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '自动压缩须为' }).waitFor()
  await page.getByRole('button', { name: '恢复此模型的自动设置', exact: true }).click()
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page)
  assert.deepEqual((await lastPayload(page)).groups[0].modelSettings, {})
  await page.close()
})

test('narrow layout stays inside viewport and closes with keyboard focus restored', async () => {
  const page = await pageFor({ width: 390, height: 844 }); await open(page)
  const layout = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth, dialog: document.querySelector('[role="dialog"]').getBoundingClientRect().toJSON(), footer: document.querySelector('.aggregate-settings-footer').getBoundingClientRect().toJSON() }))
  assert.ok(layout.scroll <= layout.width)
  assert.ok(layout.dialog.left >= 0 && layout.dialog.right <= layout.width)
  assert.ok(layout.footer.bottom <= 844)
  await page.screenshot({ path: path.join(artifacts, 'models-mobile.png') })
  await page.getByRole('dialog').press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '模型设置', exact: true }).evaluate(button => button === document.activeElement), true)
  await page.close()
})


test('source tabs separate relay groups from custom APIs while preserving every unsaved draft', async () => {
  const page = await pageFor(); await open(page)
  assert.equal(await page.getByRole('tab', { name: /^内置聚合/ }).getAttribute('aria-selected'), 'true')
  assert.equal(await page.getByLabel('接口名称', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '添加接口', exact: true }).count(), 0)
  await page.getByLabel('模型', { exact: true }).selectOption('deepseek-v4-pro')
  await page.getByLabel('上下文窗口', { exact: true }).fill('512000')
  await custom(page)
  assert.equal(await page.getByRole('button', { name: /主要分组/ }).count(), 0)
  await page.getByLabel('接口名称', { exact: true }).fill('我的接口')
  await page.getByLabel('API Key', { exact: true }).fill('new-key-draft')
  await page.getByLabel('新模型 ID', { exact: true }).fill('my-next-model')
  await page.getByLabel('上下文窗口', { exact: true }).fill('128000')
  await builtin(page)
  assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'deepseek-v4-pro')
  assert.equal(await page.getByLabel('上下文窗口', { exact: true }).inputValue(), '512000')
  await custom(page)
  assert.equal(await page.getByLabel('接口名称', { exact: true }).inputValue(), '我的接口')
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), 'new-key-draft')
  assert.equal(await page.getByLabel('新模型 ID', { exact: true }).inputValue(), 'my-next-model')
  assert.equal(await page.getByLabel('上下文窗口', { exact: true }).inputValue(), '128000')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByLabel('上下文窗口', { exact: true }).fill('64000')
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page)
  const payload = await lastPayload(page)
  assert.equal(payload.groups[0].modelSettings['deepseek-v4-pro'].contextWindow, 512000)
  assert.equal(payload.providers[0].modelSettings['gpt-6-sol'].contextWindow, 128000)
  assert.equal(payload.providers[0].modelSettings['my-next-model'].contextWindow, 64000)
  assert.equal(payload.providers[0].name, '我的接口')
  assert.equal(payload.providers[0].source, 'custom')
  assert.equal(payload.providers[0].enabled, true)
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '')
  await page.close()
})

test('existing providers default enabled, disabled providers remain editable and can be re-enabled', async () => {
  const page = await pageFor(); await open(page); await custom(page)
  const toggle = page.getByRole('switch', { name: '接口启用状态', exact: true })
  assert.equal(await toggle.getAttribute('aria-checked'), 'true')
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-checked'), 'false')
  assert.equal(await page.getByLabel('接口名称', { exact: true }).isEnabled(), true)
  assert.match(await page.locator('.aggregate-source-bar > p').innerText(), /0 个模型已启用/)
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page)
  let payload = await lastPayload(page)
  assert.equal(payload.providers[0].enabled, false)
  assert.equal(payload.providers[0].apiKey, '')
  assert.equal(payload.providers[0].keyConfigured, true)
  assert.equal(payload.providers[0].models.length, 1)
  assert.match(await page.getByRole('status').innerText(), /重新写入聚合后生效/)
  await page.getByRole('dialog').press('Escape'); await open(page)
  assert.equal(await toggle.getAttribute('aria-checked'), 'false')
  await page.getByLabel('接口名称', { exact: true }).fill('停用接口仍可编辑')
  await toggle.click()
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page, 2)
  payload = await lastPayload(page)
  assert.equal(payload.providers[0].enabled, true)
  assert.equal(payload.providers[0].name, '停用接口仍可编辑')
  assert.match(await page.locator('.aggregate-source-bar > p').innerText(), /1 个模型已启用/)
  await page.close()
})

test('removal is confirmed and only committed on save; cancelling restores the prior snapshot', async () => {
  const page = await pageFor(); await open(page); await custom(page)
  await page.getByRole('button', { name: '移除此接口', exact: true }).click()
  await page.getByRole('group', { name: '确认移除接口', exact: true }).waitFor()
  await page.getByRole('button', { name: '保留接口', exact: true }).click()
  assert.equal(await page.getByLabel('接口名称', { exact: true }).inputValue(), '已有接口')
  await page.getByRole('button', { name: '移除此接口', exact: true }).click()
  await page.getByRole('button', { name: '确认移除', exact: true }).click()
  await page.getByRole('heading', { name: '添加你的第一个接口', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__settings.calls.filter(call => call.method === 'save').length), 0)
  await page.getByRole('dialog').press('Escape'); await open(page)
  assert.equal(await page.getByLabel('接口名称', { exact: true }).inputValue(), '已有接口')
  await page.getByRole('button', { name: '移除此接口', exact: true }).click()
  await page.getByRole('button', { name: '确认移除', exact: true }).click()
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page)
  assert.deepEqual((await lastPayload(page)).providers, [])
  await page.close()
})

test('source tabs are keyboard accessible and a custom-only setup starts on its valid source', async () => {
  const page = await pageFor({ noBuiltin: true }); await open(page)
  const customTab = page.getByRole('tab', { name: /^自有聚合/ })
  const builtinTab = page.getByRole('tab', { name: /^内置聚合/ })
  assert.equal(await customTab.getAttribute('aria-selected'), 'true')
  await customTab.focus(); await customTab.press('ArrowLeft')
  await page.getByRole('heading', { name: '还没有内置聚合模型', exact: true }).waitFor()
  assert.equal(await builtinTab.evaluate(button => button === document.activeElement), true)
  assert.equal(await builtinTab.getAttribute('tabindex'), '0')
  assert.equal(await customTab.getAttribute('tabindex'), '-1')
  await builtinTab.press('End')
  assert.equal(await customTab.getAttribute('aria-selected'), 'true')
  assert.equal(await page.getByLabel('接口名称', { exact: true }).inputValue(), '已有接口')
  await page.close()
})

test('all source and provider mutations are disabled during an in-flight save', async () => {
  const page = await pageFor({ deferSave: true }); await open(page); await custom(page)
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.waitForFunction(() => typeof window.__finishSettingsSave === 'function')
  assert.equal(await page.getByRole('tab', { name: /^内置聚合/ }).isDisabled(), true)
  assert.equal(await page.getByRole('switch', { name: '接口启用状态', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '移除此接口', exact: true }).isDisabled(), true)
  await page.getByRole('dialog').press('Escape')
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  await page.evaluate(() => window.__finishSettingsSave()); await saved(page)
  assert.equal(await page.getByRole('switch', { name: '接口启用状态', exact: true }).isEnabled(), true)
  await page.close()
})
