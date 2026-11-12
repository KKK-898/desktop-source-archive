import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import * as delivery from '../src/official-subscription-delivery.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(root, 'src/official-subscription-recovery.ts'), 'utf8')
const context = vm.createContext({
  exports: {},
  require: (id) => {
    assert.equal(id, './official-subscription-delivery')
    return delivery
  },
})
vm.runInContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context)
const { isOfficialSubscriptionRecoveryOrder, normalizeOfficialSubscriptionRecoveryIdentity, recoverOfficialSubscriptionSession } = context.exports
const order = { id: 6271, order_type: 'official_sub', status: 'PAID', paid_at: '2026-09-30T01:09:32Z', amount: 780, official_plan_id: 'pro5x', official_session_saved: false }
const session = JSON.stringify({ user: { email: 'buyer@example.test' }, accessToken: 'synthetic-session-only' })
const identity = normalizeOfficialSubscriptionRecoveryIdentity({ email: 'Buyer@example.test', accountKey: 'test-account', sessionJson: session, isFullSessionJson: true })

test('recovery requires an explicit missing receipt on an unfinished paid official order', () => {
  assert.equal(isOfficialSubscriptionRecoveryOrder(order), true)
  assert.equal(isOfficialSubscriptionRecoveryOrder({ ...order, status: 'FAILED' }), true)
  for (const delta of [
    { official_session_saved: true }, { official_session_saved: undefined }, { order_type: 'balance' },
    { status: 'COMPLETED' }, { status: 'PENDING' }, { status: 'FAILED', paid_at: null }, { id: 0 },
  ]) assert.equal(isOfficialSubscriptionRecoveryOrder({ ...order, ...delta }), false)
})

test('recovery requires full identified Session and normalizes the confirmed account', () => {
  assert.equal(identity.email, 'buyer@example.test')
  for (const result of [{}, { email: 'a@example.test' }, { email: 'a@example.test', sessionJson: session, isFullSessionJson: false }]) {
    assert.throws(() => normalizeOfficialSubscriptionRecoveryIdentity(result), /完整 Session/)
  }
})

test('recovery rechecks the same paid order and sends no payment request', async () => {
  const calls = []
  assert.equal(await recoverOfficialSubscriptionSession(order.id, identity, {
    readOrder: async (id) => { calls.push(['read', id]); return order },
    submit: async (id, payload) => { calls.push(['submit', id, payload]); return { submitted: true } },
    isCurrent: () => true,
  }), true)
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [['read', 6271], ['submit', 6271]])
  assert.equal(calls[1][2].session_json, session)
  assert.equal(calls[1][2].plan_id, 'pro5x')
  assert.equal(calls[1][2].fill_missing_only, true)
  assert.equal(calls[1][2].account_email, 'buyer@example.test')
})

test('stale account response and changed order cannot upload credentials', async () => {
  let current = true
  let uploads = 0
  assert.equal(await recoverOfficialSubscriptionSession(order.id, identity, {
    readOrder: async () => { current = false; return order },
    submit: async () => { uploads++; return { saved: true } },
    isCurrent: () => current,
  }), false)
  assert.equal(uploads, 0)
  for (const changed of [{ ...order, id: 99 }, { ...order, status: 'PENDING' }, { ...order, order_type: 'balance' },
    { ...order, status: 'REFUNDED', official_session_saved: true }]) {
    await assert.rejects(recoverOfficialSubscriptionSession(order.id, identity, {
      readOrder: async () => changed,
      submit: async () => { uploads++; return { saved: true } },
      isCurrent: () => true,
    }))
  }
  assert.equal(uploads, 0)
})

test('an ambiguous upload remains retryable; an existing durable copy is never overwritten', async () => {
  await assert.rejects(recoverOfficialSubscriptionSession(order.id, identity, {
    readOrder: async () => order, submit: async () => ({}), isCurrent: () => true,
  }), /尚未确认保存成功/)
  let uploads = 0
  assert.equal(await recoverOfficialSubscriptionSession(order.id, identity, {
    readOrder: async () => ({ ...order, official_session_saved: true }),
    submit: async () => { uploads++; return {} },
    isCurrent: () => true,
  }), true)
  assert.equal(uploads, 0)
})

test('paid-order recovery browser flow confirms identity, retains failed input, and clears it after success or owner change', { timeout: 60000 }, async () => {
  const artifacts = await mkdtemp(path.join(tmpdir(), 'gaoge-subscription-recovery-'))
  const server = await createServer({
    root, configFile: false, envDir: false, cacheDir: path.join(artifacts, 'vite'),
    plugins: [vue(), {
      name: 'subscription-recovery-test',
      resolveId(id) { if (id === '/__recovery_entry.js') return '\0recovery-test-entry' },
      load(id) {
        if (id !== '\0recovery-test-entry') return
        return `import { createApp, h, reactive } from 'vue';
          import Recovery from '/src/components/OfficialSubscriptionSessionRecovery.vue';
          const state = reactive({ orders: [${JSON.stringify(order)}], token: 'synthetic-test-token', ownerId: '7' });
          window.__recoveryState = state;
          window.__recoveries = [];
          createApp({render:()=>h(Recovery,{...state,onRecovered:id=>window.__recoveries.push(id)})}).mount('#app');`
      },
      configureServer(vite) {
        vite.middlewares.use('/__recovery_test', (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订阅资料补交验证</title><style>body{margin:0;background:#101827;color:#e4eaf5;font-family:system-ui}main{max-width:850px;margin:auto;padding:20px;box-sizing:border-box}*{box-sizing:border-box}</style><main id="app"></main><script type="module" src="/__recovery_entry.js"></script></html>')
        })
      },
    }],
    optimizeDeps: { noDiscovery: true, include: ['vue', 'lucide-vue-next'] },
    server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'error',
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
    const browserContext = await browser.newContext({ viewport: { width: 920, height: 900 } })
    let saved = false
    const requests = []
    await browserContext.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/payment/')) {
        return url.hostname === '127.0.0.1' ? route.continue() : route.abort()
      }
      requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() })
      if (request.method() === 'GET' && url.pathname.endsWith('/payment/orders/6271')) {
        return route.fulfill({ json: { code: 0, data: order } })
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/payment/orders/6271/official-subscription-session')) {
        return route.fulfill({ json: { code: 0, data: saved ? { saved: true } : {} } })
      }
      return route.fulfill({ status: 400, json: { code: 400, message: 'Unexpected API' } })
    })
    await browserContext.addInitScript(() => {
      window.gaogeDesktop = {
        identifyOfficialChatgptSessionText: async ({ sessionJson }) => ({
          email: JSON.parse(sessionJson).user.email, accountKey: 'test-account', sessionJson, isFullSessionJson: true,
        }),
      }
    })
    const page = await browserContext.newPage()
    page.setDefaultTimeout(12000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${server.resolvedUrls.local[0]}__recovery_test`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '补交 Session', exact: true }).click()
    await page.getByLabel('完整 Session 文本').fill(session)
    await page.getByRole('button', { name: '识别并确认账号', exact: true }).click()
    await page.getByText('已识别订阅账号：buyer@example.test').waitFor()
    assert.equal(requests.length, 0, 'identification alone must not submit an order')
    await page.getByRole('button', { name: '确认补交到原订单', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '尚未确认保存成功' }).waitFor().catch(async (error) => {
      console.error('Recovery failure details:', await page.locator('body').innerText(), requests.map(({ path, method }) => ({ path, method })), errors)
      throw error
    })
    assert.equal(await page.getByLabel('完整 Session 文本').inputValue(), session)
    assert.deepEqual(await page.evaluate(() => window.__recoveries), [])
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), '{}')
    await page.screenshot({ path: path.join(artifacts, 'recovery-retry.png'), fullPage: true })
    saved = true
    await page.getByRole('button', { name: '确认补交到原订单', exact: true }).click()
    await page.getByText('服务器已确认保存资料，原订单将继续处理，无需再次付款。').waitFor()
    assert.deepEqual(await page.evaluate(() => window.__recoveries), [6271])
    assert.equal(await page.getByLabel('完整 Session 文本').count(), 0)
    assert.equal(requests.some((request) => request.path.endsWith('/payment/orders') && request.method === 'POST'), false)
    await page.getByRole('button', { name: '补交 Session', exact: true }).click()
    await page.getByLabel('完整 Session 文本').fill(session)
    await page.evaluate(() => { window.__recoveryState.ownerId = '8'; window.__recoveryState.token = 'other-test-token' })
    assert.equal(await page.getByLabel('完整 Session 文本').count(), 0)
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), '{}')
    assert.deepEqual(errors, [])
    console.log(`Recovery UI artifact: ${path.join(artifacts, 'recovery-retry.png')}`)
  } finally {
    await browser?.close()
    await server.close()
  }
})
