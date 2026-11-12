import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let server, browser, baseUrl, artifacts
const failures = []
const html = '<!doctype html><html><head><meta charset="UTF-8"><style>body{margin:0;background:#fff;font-family:Arial,sans-serif}#app{max-width:1100px;margin:28px auto;padding:0 24px}.mode-dark{background:#171c24}</style></head><body><div id="app"></div><script type="module">import {createApp,h,ref} from "vue";import Market from "/src/components/CodexPluginMarket.vue";const app=createApp({setup(){const revision=ref(0);window.__finishRestart=()=>{revision.value++};return()=>h(Market,{restartRevision:revision.value,confirmUninstall:async name=>{window.__market.confirmedNames.push(name);return window.__market.confirmUninstall},onRestart:()=>{window.__market.restarts++}})}});app.mount("#app");window.__unmountMarket=()=>app.unmount();</script></body></html>'

before(async () => {
  artifacts = await mkdtemp(path.join(os.tmpdir(), 'gaoge-plugin-market-ui-'))
  const entry = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  await build({ root, configFile: false, logLevel: 'error', plugins: [vue(), {
    name: 'isolated-market-test-entry',
    resolveId(id) { if (id === 'virtual:plugin-market-test') return '\0plugin-market-test' },
    load(id) { if (id === '\0plugin-market-test') return entry },
  }], build: { outDir: artifacts, emptyOutDir: false, rollupOptions: { input: 'virtual:plugin-market-test', output: { entryFileNames: 'market-test.js', assetFileNames: '[name][extname]' } } } })
  const css = (await readdir(artifacts)).filter(name => name.endsWith('.css'))
  const pageHtml = html.replace(/<script type="module">[\s\S]*?<\/script>/, css.map(name => '<link rel="stylesheet" href="/' + name + '">').join('') + '<script type="module" src="/market-test.js"></script>')
  server = createHttpServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
      if (pathname === '/__plugin_market_test.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pageHtml); return }
      const file = path.resolve(artifacts, '.' + pathname)
      if (!file.startsWith(artifacts + path.sep)) { res.statusCode = 403; res.end(); return }
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript')
      res.end(await readFile(file))
    } catch { res.statusCode = 404; res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = 'http://127.0.0.1:' + server.address().port
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!String(error).includes("Executable doesn't exist")) throw error
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  }
}, { timeout: 60000 })

after(async () => { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }; console.log('Plugin marketplace screenshots: ' + artifacts); assert.deepEqual(failures, [], 'Unexpected browser errors') })

async function pageFor(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1250, height: 950 } })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => { failures.push(error.message); console.error('Browser error:', error.message) })
  await page.addInitScript(opts => {
    const entry = (id, extra = {}) => ({ id, name: id, displayName: id, description: 'Useful tools and skills', version: '1.0.0', author: 'Example', tags: [], license: 'MIT', bytes: 23000, skills: 1, requiresAuth: false, installed: false, installedVersion: null, updateAvailable: false, installable: true, enabled: false, managed: false, ...extra })
    const entries = [
      entry('alpha', { displayName: 'Alpha Design', author: 'Ada', tags: ['design', 'ui'] }),
      entry('beta', { displayName: 'Beta Connect', requiresAuth: true }),
      entry('gamma', { displayName: 'Gamma Update', installed: true, installedVersion: '0.9.0', updateAvailable: true, enabled: true, managed: true }),
      entry('external', { displayName: 'External Plugin', installed: true, installedVersion: '1.0.0', enabled: true, managed: false }),
      ...Array.from({ length: 26 }, (_, index) => entry('sample-' + index, { displayName: 'Sample ' + index })),
    ]
    const state = window.__market = { entries, calls: [], confirmedNames: [], confirmUninstall: false, restarts: 0, listFailures: opts.listFailures || 0, failInstall: Boolean(opts.failInstall), deferInstall: Boolean(opts.deferInstall) }
    window.gaogeDesktop = {
      listCodexPlugins: async request => {
        state.calls.push({ method: 'list', ...request })
        if (state.listFailures > 0) { state.listFailures--; throw new Error('模拟网络断开') }
        return structuredClone({ source: request.source, repository: 'test/catalog', revision: '123', updatedAt: '2026-11-10', cached: !request.refresh, codexHome: 'C:/isolated-codex-test', plugins: request.source === 'full' ? [entry('full-only', { displayName: 'Full Library Plugin' })] : entries })
      },
      installCodexPlugin: async request => {
        state.calls.push({ method: 'install', ...request })
        if (state.failInstall) throw new Error('模拟下载失败')
        if (state.deferInstall) await new Promise(resolve => { window.__finishInstall = resolve })
        const plugin = entries.find(value => value.id === request.id)
        Object.assign(plugin, { installed: true, installedVersion: plugin.version, updateAvailable: false, enabled: true, managed: true })
        return { status: 'ok', message: plugin.displayName + ' 安装完成', restartRequired: true }
      },
      getCodexPluginInstallStatus: async request => {
        state.calls.push({ method: 'status', ...request })
        return { busy: true, stage: 'downloading', message: '正在下载插件' }
      },
      setCodexPluginEnabled: async request => {
        state.calls.push({ method: 'enabled', ...request })
        entries.find(value => value.id === request.id).enabled = request.enabled
        return { status: 'ok', restartRequired: true }
      },
      uninstallCodexPlugin: async request => {
        state.calls.push({ method: 'uninstall', ...request })
        Object.assign(entries.find(value => value.id === request.id), { installed: false, enabled: false, managed: false, installedVersion: null, updateAvailable: false })
        return { status: 'ok', restartRequired: true }
      },
    }
  }, options)
  await page.goto(baseUrl + '/__plugin_market_test.html')
  await page.getByRole('heading', { name: '安装插件', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="安装插件"]')?.getAttribute('aria-busy') === 'false')
  return page
}
const card = (page, name) => page.locator('.plugin-card').filter({ has: page.getByRole('heading', { name, exact: true }) })

 test('search, source selection, pagination and authorization filters use the real component', async () => {
  const page = await pageFor()
  try {
    assert.equal(await page.locator('.plugin-card').count(), 24)
    await page.getByRole('button', { name: '加载更多', exact: true }).click()
    assert.equal(await page.locator('.plugin-card').count(), 30)
    await page.getByRole('searchbox', { name: '搜索插件' }).fill('Ada design')
    await card(page, 'Alpha Design').waitFor()
    assert.equal(await page.locator('.plugin-card').count(), 1)
    await page.getByRole('button', { name: '清空搜索' }).click()
    await page.getByRole('button', { name: /^需服务授权/ }).click()
    await card(page, 'Beta Connect').waitFor()
    assert.equal(await page.locator('.plugin-card').count(), 1)
    await page.getByRole('button', { name: /^全部插件/ }).click()
    assert.equal(await card(page, 'External Plugin').getByRole('button').count(), 0)
    await page.screenshot({ path: path.join(artifacts, 'market-light.png'), fullPage: true })
    await page.evaluate(() => document.body.classList.add('mode-dark'))
    await page.screenshot({ path: path.join(artifacts, 'market-dark.png'), fullPage: true })
    await page.getByRole('combobox', { name: '插件市场来源' }).selectOption('full')
    await card(page, 'Full Library Plugin').waitFor()
    assert.equal(await page.locator('.plugin-card').count(), 1)
  } finally { await page.close() }
})

test('catalog error offers retry and forces a refreshed request', async () => {
  const page = await pageFor({ listFailures: 1 })
  try {
    assert.match(await page.getByRole('alert').innerText(), /模拟网络断开/)
    await page.getByRole('button', { name: '重新加载', exact: true }).click()
    await card(page, 'Alpha Design').waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.equal(await page.evaluate(() => window.__market.calls.at(-1).refresh), true)
  } finally { await page.close() }
})

test('installation is serialized, shows progress and requires an explicit restart', async () => {
  const page = await pageFor({ deferInstall: true })
  try {
    await card(page, 'Alpha Design').getByRole('button', { name: '安装', exact: true }).click()
    assert.equal(await page.getByRole('combobox', { name: '插件市场来源' }).isDisabled(), true)
    assert.equal(await card(page, 'Beta Connect').getByRole('button', { name: '安装', exact: true }).isDisabled(), true)
    await page.getByText('正在下载插件', { exact: true }).waitFor()
    await page.evaluate(() => window.__finishInstall())
    await card(page, 'Alpha Design').getByRole('button', { name: '停用 Alpha Design' }).waitFor()
    await page.getByText('插件配置已更新。重启 ChatGPT 后，在新聊天中使用。', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__market.restarts), 0)
    await page.getByRole('button', { name: '立即重启', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__market.restarts), 1)
    assert.equal(await page.locator('.restart-hint').count(), 1, 'A cancelled or pending restart must retain the hint')
    await page.evaluate(() => window.__finishRestart())
    await page.locator('.restart-hint').waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('failed installation does not claim success or create an installed entry', async () => {
  const page = await pageFor({ failInstall: true })
  try {
    await card(page, 'Alpha Design').getByRole('button', { name: '安装', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /模拟下载失败/)
    assert.equal(await card(page, 'Alpha Design').getByRole('button', { name: '安装', exact: true }).isEnabled(), true)
    assert.equal(await page.locator('.restart-hint').count(), 0)
    assert.equal(await page.evaluate(() => window.__market.entries[0].installed), false)
  } finally { await page.close() }
})

test('update, enabled state and confirmed uninstall preserve the selected plugin identity', async () => {
  const page = await pageFor()
  try {
    await card(page, 'Gamma Update').getByRole('button', { name: '更新', exact: true }).click()
    await card(page, 'Gamma Update').getByRole('button', { name: '更新', exact: true }).waitFor({ state: 'detached' })
    await card(page, 'Gamma Update').getByRole('button', { name: '停用 Gamma Update' }).click()
    await card(page, 'Gamma Update').getByRole('button', { name: '启用 Gamma Update' }).waitFor()
    await card(page, 'Gamma Update').getByRole('button', { name: '卸载 Gamma Update' }).click()
    assert.equal(await page.evaluate(() => window.__market.calls.filter(call => call.method === 'uninstall').length), 0)
    await page.evaluate(() => { window.__market.confirmUninstall = true })
    await card(page, 'Gamma Update').getByRole('button', { name: '卸载 Gamma Update' }).click()
    await card(page, 'Gamma Update').getByRole('button', { name: '安装', exact: true }).waitFor()
    const writes = await page.evaluate(() => window.__market.calls.filter(call => ['install', 'enabled', 'uninstall'].includes(call.method)))
    assert.deepEqual(writes, [{ method: 'install', source: 'public', id: 'gamma' }, { method: 'enabled', source: 'public', id: 'gamma', enabled: false }, { method: 'uninstall', source: 'public', id: 'gamma' }])
  } finally { await page.close() }
})

test('leaving the page during installation ignores late completion', async () => {
  const page = await pageFor({ deferInstall: true })
  try {
    await card(page, 'Alpha Design').getByRole('button', { name: '安装', exact: true }).click()
    await page.waitForFunction(() => typeof window.__finishInstall === 'function')
    const before = await page.evaluate(() => window.__market.calls.filter(call => call.method === 'list').length)
    await page.evaluate(() => { window.__unmountMarket(); window.__finishInstall() })
    await page.waitForTimeout(80)
    assert.equal(await page.evaluate(() => window.__market.calls.filter(call => call.method === 'list').length), before)
    assert.equal(await page.locator('.codex-plugin-market').count(), 0)
  } finally { await page.close() }
})
