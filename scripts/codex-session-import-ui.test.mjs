import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let server, browser, baseUrl, artifacts
const errors = []
const entry = 'import {createApp,h} from "vue";import Dialog from "/src/components/CodexSessionImportDialog.vue";createApp({render(){return h(Dialog,{dark:window.__options.dark,onClose:()=>window.__state.closed++,onImported:result=>window.__state.results.push(result)})}}).mount("#app")'
before(async () => {
  artifacts = await mkdtemp(path.join(os.tmpdir(), 'gaoge-session-import-ui-'))
  await build({ root, configFile: false, logLevel: 'error', plugins: [vue(), {
    name: 'session-import-test', resolveId(id) { if (id === 'virtual:session-import-test') return '\0session-import-test' },
    load(id) { if (id === '\0session-import-test') return entry },
  }], build: { outDir: artifacts, emptyOutDir: false, rollupOptions: { input: 'virtual:session-import-test', output: { entryFileNames: 'test.js', assetFileNames: '[name][extname]' } } } })
  const css = (await readdir(artifacts)).filter(name => name.endsWith('.css'))
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + css.map(file => '<link rel="stylesheet" href="/' + file + '">').join('') + '<style>body{margin:0;font-family:Arial,sans-serif}*{box-sizing:border-box}</style></head><body><div id="app"></div><script type="module" src="/test.js"></script></body></html>'
  server = createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
      if (name === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return }
      const file = path.resolve(artifacts, '.' + name)
      if (!file.startsWith(artifacts + path.sep)) { res.writeHead(403); res.end(); return }
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(file))
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = 'http://127.0.0.1:' + server.address().port
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) { if (!String(error).includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ channel: 'chrome', headless: true }) }
}, { timeout: 60000 })
after(async () => {
  await browser?.close()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  console.log('Session import UI screenshots: ' + artifacts)
  assert.deepEqual(errors, [])
})

async function pageFor(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1150, height: 950 } })
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(opts => {
    window.__options = opts
    const row = (id, status, extra = {}) => ({ id, title: id, status, message: '', cwd: '/old/project', suggestedProjectPath: '', archived: false, ...extra })
    const sessions = opts.onlyDuplicate ? [row('已存在会话', 'duplicate', { message: '本机已有此会话，将跳过。' })] : [
      row('项目开发对话', 'ready'), row('已归档对话', 'ready', { archived: true }),
      row('已存在会话', 'duplicate', { message: '本机已有此会话，将跳过。' }),
      row('仅索引会话', 'metadataOnly', { message: '没有原始聊天记录。' }),
      row('损坏会话', 'invalid', { message: '缺少分支依赖记录。' }),
    ]
    window.__state = { calls: [], closed: 0, results: [], failImport: !!opts.failImport }
    window.gaogeDesktop = {
      previewCodexSessionsImport: async () => {
        if (opts.cancel) return { cancelled: true }
        return { cancelled: false, filePath: 'D:/备份/Gaoge-Codex-sessions.zip', archiveHash: 'test-hash', codexHome: 'C:/Users/Test/.codex', codexRunning: false, sessions }
      },
      selectCodexSessionProjectDir: async () => ({ cancelled: false, path: 'D:/新电脑/项目' }),
      importCodexSessions: async request => {
        window.__state.calls.push(request)
        if (window.__state.failImport) throw new Error('请先退出 Codex，再点击开始导入。')
        if (opts.defer) await new Promise(resolve => { window.__finishImport = resolve })
        return { importedCount: request.sessionIds.length, skippedCount: 0, failedCount: 0, importedSessionIds: request.sessionIds, skipped: [], failures: [], restartRequired: true, codexHome: 'C:/Users/Test/.codex' }
      },
    }
  }, options)
  await page.goto(baseUrl)
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAttribute('aria-busy') === 'false')
  return page
}

test('preview blocks incomplete paths and unavailable sessions; selected sessions use remapped directories', async () => {
  const page = await pageFor()
  try {
    assert.equal(await page.getByRole('button', { name: '开始导入', exact: true }).isEnabled(), false)
    for (const title of ['已存在会话', '仅索引会话', '损坏会话']) assert.equal(await page.getByRole('checkbox', { name: '导入 ' + title, exact: true }).isEnabled(), false)
    await page.getByRole('button', { name: '选择本机文件夹：/old/project', exact: true }).click()
    await page.getByRole('checkbox', { name: '导入 已归档对话', exact: true }).uncheck()
    await page.screenshot({ path: path.join(artifacts, 'import-preview-light.png'), fullPage: true })
    await page.getByRole('button', { name: '开始导入', exact: true }).click()
    await page.getByRole('heading', { name: '导入结果' }).waitFor()
    const state = await page.evaluate(() => window.__state)
    assert.equal(state.calls.length, 1)
    assert.deepEqual(state.calls[0].sessionIds, ['项目开发对话'])
    assert.deepEqual(state.calls[0].projectMappings, { '/old/project': 'D:/新电脑/项目' })
    assert.equal(state.calls[0].archiveHash, 'test-hash'); assert.equal(state.results.length, 1)
    await page.getByRole('button', { name: '完成', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__state.closed), 1)
  } finally { await page.close() }
})

test('failed import stays reviewable and can be retried after exiting Codex', async () => {
  const page = await pageFor({ failImport: true })
  try {
    await page.getByRole('button', { name: '选择本机文件夹：/old/project', exact: true }).click()
    await page.getByRole('button', { name: '开始导入', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').textContent(), /退出 Codex/)
    assert.equal(await page.evaluate(() => window.__state.results.length), 0)
    await page.evaluate(() => { window.__state.failImport = false })
    await page.getByRole('button', { name: '开始导入', exact: true }).click()
    await page.getByRole('heading', { name: '导入结果' }).waitFor()
    assert.equal(await page.evaluate(() => window.__state.results[0].importedCount), 2)
  } finally { await page.close() }
})

test('in-flight import prevents closing or submitting twice', async () => {
  const page = await pageFor({ defer: true })
  try {
    await page.getByRole('button', { name: '选择本机文件夹：/old/project', exact: true }).click()
    await page.getByRole('button', { name: '开始导入', exact: true }).click()
    await page.waitForFunction(() => typeof window.__finishImport === 'function')
    assert.equal(await page.getByRole('button', { name: '关闭导入会话', exact: true }).isEnabled(), false)
    assert.equal(await page.getByRole('button', { name: '导入中…', exact: true }).isEnabled(), false)
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => window.__state.closed), 0)
    await page.evaluate(() => window.__finishImport())
    await page.getByRole('heading', { name: '导入结果' }).waitFor()
    assert.equal(await page.evaluate(() => window.__state.calls.length), 1)
  } finally { await page.close() }
})

test('duplicate-only and cancelled selection cannot import', async () => {
  for (const options of [{ onlyDuplicate: true }, { cancel: true }]) {
    const page = await pageFor(options)
    try { assert.equal(await page.getByRole('button', { name: '开始导入', exact: true }).isEnabled(), false); assert.equal(await page.evaluate(() => window.__state.calls.length), 0) }
    finally { await page.close() }
  }
})

test('dark narrow layout stays inside viewport', async () => {
  const page = await pageFor({ dark: true })
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(artifacts, 'import-preview-dark-mobile.png'), fullPage: true })
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }))
    assert.ok(size.scroll <= size.width)
    const dialog = await page.getByRole('dialog').boundingBox(); assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 390)
  } finally { await page.close() }
})
