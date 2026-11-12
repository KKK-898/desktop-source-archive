import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { accountRouteFixture, accountRouteProduction, account, router, aggregate, activation } from './codex-account-route-harness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const missingMessage = '未检测到已登录的gpt账号，请使用无账号登录'

test('existing-account fueling uses the production Vue button, confirmation dialog, and handlers', { timeout: 120000 }, async (t) => {
  const artifactsRoot = path.join(root, 'src-tauri', 'target', 'fuel-account-ui')
  await mkdir(artifactsRoot, { recursive: true })
  const artifacts = await mkdtemp(path.join(artifactsRoot, 'run-'))
  const component = await readFile(path.join(root, 'src/components/新版主题.vue'), 'utf8')
  const { descriptor } = parse(component)
  const buttons = [...descriptor.template.content.matchAll(/<button\b[^>]*@click="connectToolForActivePage"[^>]*>[\s\S]*?<\/button>/g)]
  const dialogs = [...descriptor.template.content.matchAll(/<div\s+v-if="confirmDialog.open"[\s\S]*?<\/section>\s*<\/div>/g)]
  assert.equal(buttons.length, 1, 'Use the unique production start/close button')
  assert.equal(dialogs.length, 1, 'Use the production confirmation dialog markup')
  const template = compileTemplate({ filename: 'ProductionFuelControls.vue', id: 'fuel-controls',
    source: `<main class="new-theme-shell"><h1>已有账号加油</h1><article class="new-theme-login-action-card">${buttons[0][0]}</article>${dialogs[0][0]}</main>`,
  })
  assert.deepEqual(template.errors, [])
  const production = accountRouteProduction({ fuel: true, realConfirm: true })
  const productionFactory = JSON.stringify(`with (context) { ${production}; return globalThis.subject; }`)
  const server = await createServer({
    root, configFile: false, envDir: false, cacheDir: path.join(artifacts, 'vite'),
    plugins: [{
      name: 'production-fuel-controls',
      resolveId(id) {
        if (['/__fuel-entry.js', '/__fuel-template.js', '/__fuel-style.css'].includes(id)) return `\0${id.slice(1)}`
      },
      load(id) {
        if (id === '\0__fuel-template.js') return template.code
        if (id === '\0__fuel-style.css') return descriptor.styles.map(style => style.content).join('\n')
        if (id !== '\0__fuel-entry.js') return
        return `
          import { createApp, computed, ref, nextTick } from 'vue';
          import { X, Play } from 'lucide-vue-next';
          import { render } from '/__fuel-template.js';
          import '/__fuel-style.css';
          const noop = () => {};
          const account = ${account.toString()};
          const router = ${router.toString()};
          const aggregate = ${aggregate.toString()};
          const activation = ${activation.toString()};
          const fixture = (${accountRouteFixture.toString()})({ computed, ref }, { page: '已有账号加油' });
          const scenario = new URLSearchParams(location.search).get('scenario') || 'ready';
          const originalCheck = fixture.api.checkCodexFuelAccount;
          fixture.api.checkCodexFuelAccount = async () => {
            if (scenario === 'ready') return originalCheck();
            fixture.calls.push(['check-fuel-account']);
            if (scenario === 'read-error') throw Error('isolated auth read failure');
            if (scenario === 'deferred') return new Promise((resolve, reject) => { window.resolveCheck = resolve; window.rejectCheck = reject; });
            return { canStart: false, currentAccount: null, reason: 'missing' };
          };
          if (scenario === 'saved-only') fixture.state.codexAccountsState.value.currentAccount = null;
          if (scenario === 'backend-error') {
            fixture.api.checkCodexFuelAccount = originalCheck;
            fixture.api.configureCodex = async () => { throw 'CODEX_FUEL_ACCOUNT_CHANGED: 当前登录账号已经变化。'; };
          }
          if (scenario === 'post-error') {
            fixture.api.checkCodexFuelAccount = originalCheck;
            fixture.api.getCodexAccounts = async () => { throw Error('isolated postverification failure'); };
          }
          const subject = new Function('context', ${productionFactory})(fixture.state);
          Object.assign(fixture.state, subject);
          window.qa = { ...fixture, subject };
          window.qaSettle = async () => { await nextTick(); await nextTick(); };
          createApp({ components: { X, Play }, setup: () => fixture.state, render }).mount('#app');
        `
      },
      configureServer(vite) {
        vite.middlewares.use('/__fuel', (_request, response) => {
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已有账号加油验证</title><style>body{margin:0;font:16px system-ui;background:#f5f7fb}main{padding:32px;min-height:100vh;box-sizing:border-box}h1{font-size:24px}.new-theme-login-action-card{max-width:600px}</style><div id="app"></div><script type="module" src="/__fuel-entry.js"></script></html>')
        })
      },
    }],
    optimizeDeps: { noDiscovery: true, include: ['vue', 'lucide-vue-next'] },
    server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'error',
  })
  let browser
  const errors = []
  try {
    await server.listen()
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
    const address = server.httpServer.address()
    const open = async (scenario = 'ready') => {
      const context = await browser.newContext({ viewport: { width: 1000, height: 720 } })
      const page = await context.newPage()
      page.setDefaultTimeout(10000)
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`http://127.0.0.1:${address.port}/__fuel?scenario=${scenario}`)
      await page.waitForFunction(() => window.qa?.subject?.loginActionButtonText.value === '开始加油')
      return { context, page }
    }
    const writeCalls = page => page.evaluate(() => window.qa.calls.filter(([kind]) => ['prepare-key', 'configure', 'activate', 'restart', 'disable-relay', 'disable-aggregate'].includes(kind)))

    for (const scenario of ['missing', 'saved-only']) {
      await t.test(`${scenario}: an enabled Start Fuel button opens the real one-button modal before any writes`, async () => {
        const { context, page } = await open(scenario)
        try {
          const start = page.getByRole('button', { name: '开始加油', exact: true })
          assert.equal(await start.isEnabled(), true)
          assert.equal(await start.locator('svg.lucide-play').count(), 1)
          await start.click()
          const dialog = page.getByRole('dialog', { name: '无法开始加油' })
          await dialog.waitFor({ state: 'visible' })
          assert.equal(await dialog.getAttribute('aria-modal'), 'true')
          assert.equal(await dialog.locator('p').textContent(), missingMessage)
          assert.equal(await dialog.locator('footer button').count(), 1)
          assert.equal(await dialog.getByRole('button', { name: '知道了', exact: true }).count(), 1)
          assert.deepEqual(await writeCalls(page), [])
          if (scenario === 'missing') await page.screenshot({ path: path.join(artifacts, 'missing-account-modal.png'), fullPage: true })
          await dialog.getByRole('button', { name: '知道了', exact: true }).click()
          await page.waitForFunction(() => !window.qa.subject.isLoginStartDisabled.value)
          assert.equal(await start.isEnabled(), true)
          assert.equal(await page.getByRole('dialog').count(), 0)
          assert.deepEqual(await writeCalls(page), [])
        } finally { await context.close() }
      })
    }

    await t.test('read failure shows one failure dialog without using the cached account', async () => {
      const { context, page } = await open('read-error')
      try {
        await page.getByRole('button', { name: '开始加油', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '加油失败', exact: true })
        await dialog.waitFor({ state: 'visible' })
        assert.match(await dialog.textContent(), /isolated auth read failure/)
        assert.deepEqual(await writeCalls(page), [])
        await dialog.getByRole('button', { name: '知道了', exact: true }).click()
        await page.waitForFunction(() => !window.qa.subject.isLoginStartDisabled.value)
        assert.equal(await page.getByRole('button', { name: '开始加油', exact: true }).isEnabled(), true)
        assert.equal(await page.getByRole('dialog').count(), 0)
      } finally { await context.close() }
    })

    await t.test('backend fuel failure renders its actual native code and reason in one dialog', async () => {
      const { context, page } = await open('backend-error')
      try {
        await page.getByRole('button', { name: '开始加油', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '加油失败', exact: true })
        await dialog.waitFor({ state: 'visible' })
        assert.match(await dialog.locator('p').textContent(), /当前登录账号已经变化/)
        assert.match(await dialog.locator('li').textContent(), /错误码：CODEX_FUEL_ACCOUNT_CHANGED/)
        assert.equal(await page.getByRole('dialog').count(), 1)
        assert.deepEqual(await page.evaluate(() => window.qa.calls.filter(([kind]) => kind === 'notify')), [])
        await page.screenshot({ path: path.join(artifacts, 'fuel-error-code.png'), fullPage: true })
        await dialog.getByRole('button', { name: '知道了', exact: true }).click()
        await page.waitForFunction(() => !window.qa.subject.isLoginStartDisabled.value)
      } finally { await context.close() }
    })

    await t.test('checking locks the real button and page changes invalidate the pending result', async () => {
      const { context, page } = await open('deferred')
      try {
        await page.getByRole('button', { name: '开始加油', exact: true }).click()
        assert.equal(await page.getByRole('button', { name: '正在检测账号', exact: true }).isDisabled(), true)
        await page.evaluate(() => window.qa.subject.connectToolForActivePage())
        assert.equal(await page.evaluate(() => window.qa.calls.filter(([kind]) => kind === 'check-fuel-account').length), 1)
        await page.evaluate(async () => {
          window.qa.subject.setPage('无账号登录')
          window.qa.subject.setPage('已有账号加油')
          window.resolveCheck({ canStart: true, reason: 'ready', currentAccount: { accountKey: 'A' } })
          await window.qaSettle()
        })
        assert.equal(await page.getByRole('button', { name: '开始加油', exact: true }).isEnabled(), true)
        assert.deepEqual(await writeCalls(page), [])
      } finally { await context.close() }
    })

    await t.test('successful fueling toggles the real control to Close Fuel and restores the same official account', async () => {
      const { context, page } = await open()
      try {
        await page.getByRole('button', { name: '开始加油', exact: true }).click()
        const close = page.getByRole('button', { name: '关闭加油', exact: true })
        await close.waitFor({ state: 'visible' })
        assert.equal(await close.isEnabled(), true)
        assert.equal(await close.locator('svg.lucide-x').count(), 1)
        const configured = await page.evaluate(() => window.qa.calls.find(([kind]) => kind === 'configure')[1])
        assert.equal(configured.accountKey, 'A')
        assert.equal(configured.requireCurrentChatgptAccount, true)
        assert.equal(configured.forceApiMode, false)
        assert.match(await page.evaluate(() => window.qa.state.toolNotices.value.codex), /加油成功/)
        await page.screenshot({ path: path.join(artifacts, 'fuel-active.png'), fullPage: true })
        await close.click()
        const dialog = page.getByRole('dialog', { name: '关闭中转并恢复官方原生路由' })
        await dialog.waitFor({ state: 'visible' })
        assert.match(await dialog.locator('p').textContent(), /恢复官方原生路由.*保留最后主动切换的账号/)
        assert.equal(await page.getByRole('button', { name: '关闭中', exact: true }).isDisabled(), true)
        await dialog.getByRole('button', { name: '关闭加油', exact: true }).click()
        await page.waitForFunction(() => window.qa.subject.loginActionButtonText.value === '开始加油')
        await page.evaluate(() => window.qaSettle())
        const state = await page.evaluate(() => ({ account: window.qa.subject.currentCodexAccount.value.accountKey,
          mode: window.qa.state.codexRouterStatus.value.mode, source: window.qa.state.codexRelaySource.value,
          calls: window.qa.calls.map(([kind]) => kind),
        }))
        assert.equal(state.account, 'A')
        assert.equal(state.mode, 'official')
        assert.equal(state.source, '')
        assert.equal(state.calls.filter(kind => kind === 'disable-relay').length, 1)
        assert.equal(state.calls.some(kind => kind === 'activate' || kind === 'restart'), false)
        await page.screenshot({ path: path.join(artifacts, 'official-restored.png'), fullPage: true })
      } finally { await context.close() }
    })

    await t.test('postverification failure exposes an enabled Close Fuel recovery action without success', async () => {
      const { context, page } = await open('post-error')
      try {
        await page.getByRole('button', { name: '开始加油', exact: true }).click()
        await page.getByRole('button', { name: '关闭加油', exact: true }).waitFor({ state: 'visible' })
        assert.equal(await page.getByRole('button', { name: '关闭加油', exact: true }).isEnabled(), true)
        assert.equal(await page.evaluate(() => window.qa.state.toolNotices.value.codex), '')
        assert.match(await page.evaluate(() => window.qa.state.toolErrors.value.codex), /未能确认加油成功.*关闭加油/)
        assert.equal(await page.evaluate(() => window.qa.store.has('gaoge_desktop_fuel_pack_account_key')), false)
      } finally { await context.close() }
    })
    assert.deepEqual(errors, [], 'Production bindings should not raise browser errors')
    console.log(`Fuel account UI screenshots: ${artifacts}`)
  } finally {
    await browser?.close()
    await server.close()
  }
})
