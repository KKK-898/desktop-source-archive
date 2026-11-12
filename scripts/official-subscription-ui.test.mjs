import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const prices = [
  { id: 'plus', planId: 'plus', amount: 169 },
  { id: '5x-pro', planId: 'pro5x', amount: 780 },
  { id: '20x-pro', planId: 'pro20x', amount: 1350 },
  { id: '25x-pro', planId: 'pro25x', amount: 3800 },
]
const summary = { bound_invites: 3, qualified_invites: 2, available_coupons: 2, available_amount: 100, coupons_by_plan: [{ plan_id: 'pro25x', available_coupons: 2, available_amount: 100 }] }

function prepared(body) {
  const inviter = body.inviter_email || body.inviterEmail || ''
  const email = body.account_email || body.accountEmail
  const plan = body.plan_id || body.planId
  return {
    config: { enabled: true, online_payment_only: true, allow_stacking: true, excess_not_refundable: true },
    account_email: email, plan_id: plan,
    relation: email === 'bound@example.test' ? { status: 'qualified', inviter_email: 'existing@example.test' }
      : email === 'skipped@example.test' ? { status: 'skipped' }
      : inviter ? { status: 'preview', inviter_email: inviter } : null,
    reward_preview: { plan_id: plan, invitee_amount: 50, inviter_amount: 50 },
    coupons: [
      { id: 42, plan_id: 'pro25x', face_amount: 50, status: 'available', beneficiary: 'inviter' },
      { id: 43, plan_id: 'pro5x', face_amount: 500, status: 'available', beneficiary: 'inviter' },
      { id: 44, plan_id: 'pro25x', face_amount: 4000, status: 'available', beneficiary: 'inviter' },
    ],
  }
}

async function intercept(context) {
  const calls = []
  let recovered = false
  const missingOrder = () => ({
    id: 6271, order_type: 'official_sub', official_plan_id: 'pro5x', amount: 780,
    status: 'PAID', paid_at: '2026-09-30T01:09:32Z', official_session_saved: recovered,
    out_trade_no: 'synthetic-ui-6271',
  })
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const isApi = /^(?:\/api\/|\/v1\/desktop\/)/.test(url.pathname)
    if (!isApi && url.hostname === '127.0.0.1') return route.continue()
    if (!isApi) return route.abort()
    const body = request.method() === 'POST' ? request.postDataJSON() : {}
    calls.push({ path: url.pathname, body })
    let data = {}
    if (url.pathname.endsWith('/referrals/prepare')) {
      if ((body.inviter_email || body.inviterEmail) === 'invalid@example.test') {
        return route.fulfill({ status: 400, json: { code: 400, message: '邀请人须有官方订阅成功记录' } })
      }
      data = prepared(body)
    } else if (url.pathname.endsWith('/referrals/summary')) data = summary
    else if (url.pathname.endsWith('/payment/orders') && request.method() === 'POST') data = {
      id: 9001, order_type: 'official_sub', official_plan_id: 'pro25x',
      official_session_saved: true, amount: 3750, pay_amount: 3750,
      base_amount: 3800, discount_amount: 50, status: 'PENDING',
      out_trade_no: 'synthetic-ui-9001', qr_code: 'alipayqr://synthetic-ui-test-only',
    }
    else if (url.pathname.endsWith('/payment/orders/verify') || url.pathname.endsWith('/payment/orders/9001')) data = {
      id: 9001, order_type: 'official_sub', official_plan_id: 'pro25x',
      official_session_saved: true, amount: 3750, pay_amount: 3750,
      status: 'PENDING', out_trade_no: 'synthetic-ui-9001',
    }
    else if (url.pathname.endsWith('/payment/orders/6271/official-subscription-session')) {
      recovered = true
      data = { submitted: true }
    }
    else if (url.pathname.endsWith('/payment/orders/6271')) data = missingOrder()
    else if (url.pathname.endsWith('/payment/orders/9001/cancel')) data = { status: 'CANCELLED' }
    else if (url.pathname.endsWith('/payment/orders/my') && url.searchParams.get('order_type') === 'official_sub') {
      data = { items: [missingOrder()], total: 1, pages: 1 }
    }
    else if (url.pathname.endsWith('/subscription-prices')) data = prices
    else if (url.pathname.endsWith('/auth/me')) data = { id: 7, email: 'desktop@example.test', username: '测试用户', role: 'user', status: 'active', balance: 0 }
    else if (['/subscriptions/active', '/groups/available', '/desktop/subscriptions'].some((suffix) => url.pathname.endsWith(suffix))) data = []
    else if (url.pathname.endsWith('/keys') || url.pathname.endsWith('/payment/orders/my')) data = { items: [], total: 0 }
    else if (url.pathname.endsWith('/desktop/ping')) data = { ok: true }
    else if (url.pathname.endsWith('/contact')) data = { contacts: [] }
    else if (url.pathname.endsWith('/checkout-info')) data = { enabled: true, prices, paymentMethods: [{ paymentType: 'alipay', displayName: '支付宝', currency: 'CNY', feeRate: 0, singleMin: 0, singleMax: 50000 }] }
    else return route.fulfill({ status: 404, json: { code: 404, message: 'Test mock: unknown API' } })
    return route.fulfill({ status: 200, json: { code: 0, data } })
  })
  await context.addInitScript(() => {
    window.open = () => null
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedInvitation = text } } })
  })
  return calls
}

test('official subscription browser regression', { timeout: 120000 }, async (t) => {
  const artifacts = await mkdtemp(path.join(tmpdir(), 'gaoge-official-subscription-ui-'))
  console.log('Starting isolated UI fixture')
  const server = await createServer({
    root, configFile: false, envDir: false, cacheDir: path.join(artifacts, 'vite'), plugins: [vue(), {
      name: 'official-referral-qa',
      resolveId(id) { if (id === '/__referral-entry.js') return '\0official-referral-qa-entry' },
      load(id) {
        if (id !== '\0official-referral-qa-entry') return
        return `import { createApp, h, reactive } from 'vue';
          import Referral from '/src/components/OfficialSubscriptionReferral.vue';
          const props = reactive({ accountEmail: 'buyer@example.test', sessionJson: JSON.stringify({user:{email:'buyer@example.test'},accessToken:'synthetic-test-only'}), planId:'pro25x', amount:3800, token:'synthetic-test-token' });
          window.__qaProps = props;
          createApp({render:()=>h('div',[
            h('h1','Pro 25x · ¥3800'),
            h(Referral, {...props, onChange:value=>{window.__qaSelection=value}}),
            h(Referral, {mode:'summary', accountEmail:props.accountEmail,token:props.token})
          ])}).mount('#app');`
      },
      configureServer(vite) {
        vite.middlewares.use('/__referral_qa', (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>官方订阅邀请功能验证</title><style>body{margin:0;background:#101827;color:#e4eaf5;font-family:system-ui}main{max-width:850px;margin:auto;padding:20px;box-sizing:border-box}*{box-sizing:border-box}</style><main id="app"></main><script type="module" src="/__referral-entry.js"></script></html>`)
        })
      },
    }],
    optimizeDeps: { noDiscovery: true, include: ['vue', 'lucide-vue-next', 'qrcode', '@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs'] },
    server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'error',
  })
  let browser
  let staticServer
  try {
    await server.listen()
    console.log('UI fixture ready:', server.resolvedUrls.local[0])
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
    console.log('Browser ready')
    await t.test('desktop invitation, coupon quote, invalid inviter and summary interactions', async () => {
      const context = await browser.newContext({ viewport: { width: 960, height: 1000 } })
      const calls = await intercept(context)
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${server.resolvedUrls.local[0]}__referral_qa`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__qaSelection?.step === 'inviter').catch(async (error) => {
        console.error('Desktop readiness:', errors, await page.locator('body').innerText(), calls)
        throw error
      })
      assert.equal(await page.evaluate(() => window.__qaSelection.payableAmount), 3800)
      const checkout = page.locator('.official-referral').first()
      assert.equal(await page.evaluate(() => window.__qaSelection.ready), false, 'new accounts must confirm or skip the inviter step')
      await page.screenshot({ path: path.join(artifacts, 'desktop-inviter-step.png'), fullPage: true })
      await checkout.getByLabel('邀请人 ChatGPT 邮箱（选填）').fill('friend@example.test')
      await page.waitForFunction(() => window.__qaSelection?.ready === false)
      await checkout.getByRole('button', { name: '下一步' }).click()
      await page.waitForFunction(() => window.__qaSelection?.ready && window.__qaSelection.payableAmount === 3750)
      assert.equal(await checkout.getByRole('checkbox').count(), 2, 'other-tier coupons are excluded')
      await checkout.getByRole('checkbox').first().check()
      await page.waitForFunction(() => window.__qaSelection?.payableAmount === 3700)
      await checkout.getByRole('checkbox').first().uncheck()
      await checkout.getByRole('checkbox').last().check()
      await page.waitForFunction(() => window.__qaSelection?.payableAmount === 0)
      assert.match(await checkout.locator('.referral-warning').innerText(), /250\.00/)
      await checkout.getByRole('checkbox').last().uncheck()
      await checkout.getByRole('button', { name: '修改邀请人' }).click()
      await checkout.getByLabel('邀请人 ChatGPT 邮箱（选填）').fill('invalid@example.test')
      await checkout.getByRole('button', { name: '下一步' }).click()
      await checkout.getByRole('alert').waitFor()
      assert.equal(await page.evaluate(() => window.__qaSelection.ready), false)
      await checkout.getByLabel('邀请人 ChatGPT 邮箱（选填）').fill('friend@example.test')
      await checkout.getByRole('button', { name: '下一步' }).click()
      await page.waitForFunction(() => window.__qaSelection?.ready)
      const summaryPanel = page.locator('.is-summary')
      await summaryPanel.getByRole('button', { name: '查询邀请权益' }).click()
      await summaryPanel.getByRole('button', { name: '复制邀请信息' }).waitFor()
      assert.match(await summaryPanel.innerText(), /Pro 25x · 2 张 · ¥100\.00/)
      await summaryPanel.getByRole('button', { name: '复制邀请信息' }).click()
      await page.waitForFunction(() => window.__copiedInvitation?.includes('buyer@example.test'))
      await page.screenshot({ path: path.join(artifacts, 'desktop-referral-wide.png'), fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'desktop component does not overflow a narrow window')
      await page.screenshot({ path: path.join(artifacts, 'desktop-referral-narrow.png'), fullPage: true })
      await page.evaluate(() => { window.__qaProps.accountEmail = 'second@example.test'; window.__qaProps.sessionJson = JSON.stringify({user:{email:'second@example.test'},accessToken:'synthetic-test-only'}) })
      await page.waitForFunction(() => window.__qaSelection?.step === 'inviter')
      await checkout.getByRole('button', { name: '下一步' }).click()
      await page.waitForFunction(() => window.__qaSelection?.ready && window.__qaSelection.inviterEmail === '' && window.__qaSelection.payableAmount === 3800)
      assert.equal(await summaryPanel.locator('.referral-stats').count(), 0, 'switching accounts clears previous invitation data')
      for (const email of ['bound@example.test', 'skipped@example.test']) {
        await page.evaluate((email) => { window.__qaProps.accountEmail = email; window.__qaProps.sessionJson = JSON.stringify({user:{email},accessToken:'synthetic-test-only'}) }, email)
        await page.waitForFunction(() => window.__qaSelection?.ready)
        assert.equal(await checkout.getByLabel('邀请人 ChatGPT 邮箱（选填）').count(), 0, 'existing relations never show inviter input')
        assert.equal(await checkout.getByRole('button', { name: '下一步' }).count(), 0)
        assert.equal(await checkout.getByRole('button', { name: '修改邀请人' }).count(), 0)
      }
      assert.ok(calls.some((call) => call.body.plan_id === 'pro25x' && call.body.inviter_email === 'friend@example.test'))
      assert.deepEqual(errors, [])
      await context.close()
    })

    await t.test('desktop subscription page shows four plans and the shared inviter step', async () => {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
      const calls = await intercept(context)
      await context.addInitScript(() => {
        window.gaogeDesktop = {}
        const user = { id: 7, email: 'desktop@example.test', username: '测试用户', role: 'user', status: 'active', balance: 0 }
        localStorage.setItem('gaoge_desktop_auth_token', 'synthetic-test-token')
        localStorage.setItem('gaoge_desktop_user', JSON.stringify(user))
        localStorage.setItem('gaoge_desktop_selected_server_id', 'qa')
        localStorage.setItem('gaoge_desktop_server_directory_v1', JSON.stringify({ directory: {
          version: 1, defaultServerId: 'qa', servers: [{ id: 'qa', name: '本地测试', rootDomain: 'example.test', enabled: true,
            overrides: { apiBaseUrl: location.origin + '/api/v1', softwareAdminApiBaseUrl: location.origin + '/api' } }],
        }, cachedAt: new Date().toISOString() }))
      })
      const page = await context.newPage()
      page.setDefaultTimeout(20000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
      await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: '使用此服务器', exact: true }).click().catch(async (error) => {
        console.error('Desktop startup:', errors.slice(0, 12), (await page.locator('body').innerText()).slice(0, 3000))
        await page.screenshot({ path: path.join(artifacts, 'desktop-startup.png'), fullPage: true })
        throw error
      })
      await page.getByRole('button', { name: 'codex-官方订阅', exact: true }).click()
      const cards = page.locator('.new-theme-official-plan-card')
      await page.locator('.tone-pro25x button').waitFor()
      await page.waitForFunction(() => document.querySelector('.tone-pro25x')?.textContent.includes('¥3800'))
      assert.equal(await cards.count(), 4)
      assert.match(await cards.nth(2).innerText(), /Pro 10x/)
      assert.doesNotMatch(await page.locator('.new-theme-official-subscription-page').innerText(), /Pro 20x/)
      await page.screenshot({ path: path.join(artifacts, 'desktop-subscription-page.png'), fullPage: true })
      await page.evaluate(() => {
        window.gaogeDesktop = { identifyOfficialChatgptSessionText: async ({sessionJson}) => ({
          email: JSON.parse(sessionJson).user.email, sessionJson, accountKey: 'synthetic-account', isFullSessionJson: true,
        }) }
      })
      await page.locator('.tone-pro25x button').click()
      await page.getByPlaceholder('在此输入：我同意').fill('我同意')
      await page.locator('.official-risk-dialog').getByRole('button', { name: '确认', exact: true }).click()
      await page.locator('.official-identify-dialog').getByRole('button', { name: '打开 GPT 登录需要订阅的账号', exact: true }).click()
      await page.locator('.official-identify-dialog').getByRole('button', { name: '已打开登录，进行下一步', exact: true }).click()
      await page.locator('.official-identify-dialog').getByRole('button', { name: '点击获取 Session', exact: true }).click()
      await page.getByPlaceholder('请把文本全部复制到框内', { exact: true }).fill(JSON.stringify({user:{email:'buyer@example.test'},accessToken:'synthetic-test-only'}))
      await page.locator('.official-identify-dialog').getByRole('button', { name: '确定', exact: true }).click()
      await page.getByRole('button', { name: '确定订阅', exact: true }).click()
      const dialog = page.locator('.official-payment-dialog')
      await dialog.getByRole('heading', { name: '请输入邀请人', exact: true }).waitFor()
      assert.equal(await dialog.locator('.official-payment-options').count(), 0)
      await page.screenshot({ path: path.join(artifacts, 'desktop-inviter-dialog.png'), fullPage: true })
      await dialog.getByLabel('邀请人 ChatGPT 邮箱（选填）').fill('friend@example.test')
      await dialog.getByRole('button', { name: '下一步', exact: true }).click()
      await dialog.getByRole('heading', { name: '选择支付方式', exact: true }).waitFor()
      assert.match(await dialog.locator('.referral-payable').innerText(), /3750\.00/)
      await page.screenshot({ path: path.join(artifacts, 'desktop-checkout-dialog.png'), fullPage: true })
      await dialog.getByRole('button', { name: /在线支付/ }).click()
      await dialog.waitFor({ state: 'hidden' }).catch(async (error) => {
        console.error('Checkout readiness:', await dialog.innerText(), calls.slice(-12).map(({ path }) => path), errors.slice(-4))
        throw error
      })
      const checkoutCalls = calls.filter((call) => call.path.endsWith('/payment/orders'))
      assert.equal(checkoutCalls.length, 1, 'first click creates one order and opens payment')
      assert.equal(checkoutCalls[0].body.official_subscription_session.account_email, 'buyer@example.test')
      assert.equal(checkoutCalls[0].body.official_subscription_session.session_json,
        JSON.stringify({user:{email:'buyer@example.test'},accessToken:'synthetic-test-only'}))
      await page.getByRole('dialog').filter({ hasText: '刷新状态' }).waitFor()
      await page.getByRole('dialog').filter({ hasText: '刷新状态' }).getByRole('button', { name: '取消支付', exact: true }).click()
      await page.getByRole('button', { name: '我的订阅信息', exact: true }).first().click()
      const recovery = page.getByRole('region', { name: '已付款订单补交资料' })
      await recovery.getByRole('button', { name: '补交 Session', exact: true }).click()
      await recovery.getByLabel('完整 Session 文本').fill(JSON.stringify({ user: { email: 'recovery@example.test' }, accessToken: 'synthetic-recovery-only' }))
      await recovery.getByRole('button', { name: '识别并确认账号', exact: true }).click()
      await recovery.getByText('已识别订阅账号：recovery@example.test').waitFor()
      await recovery.getByRole('button', { name: '确认补交到原订单', exact: true }).click()
      await recovery.getByText('服务器已确认保存资料，原订单将继续处理，无需再次付款。').waitFor()
      assert.equal(calls.filter((call) => call.path.endsWith('/payment/orders')).length, 1, 'history recovery must not create another payment')
      assert.equal(calls.filter((call) => call.path.endsWith('/6271/official-subscription-session')).length, 1)
      await context.close()
    })

    const siteRoot = process.env.GAOGE_SUBSCRIPTION_SITE_DIR || path.resolve(root, '../facai888/apps/subscription-site/dist-baseline')
    await t.test('website four tiers, responsive layout and Pro 25x referral checkout', { skip: !existsSync(path.join(siteRoot, 'index.html')) }, async () => {
      staticServer = createHttpServer(async (req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname
        const file = path.resolve(siteRoot, '.' + (pathname === '/' ? '/index.html' : pathname))
        if (!file.startsWith(path.resolve(siteRoot) + path.sep)) { res.writeHead(403).end(); return }
        try {
          const content = await readFile(file)
          res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream')
          res.end(content)
        } catch { res.writeHead(404).end() }
      })
      await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve))
      const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
      const calls = await intercept(context)
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`http://127.0.0.1:${staticServer.address().port}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => document.querySelector('.plan-card.pro25x')?.textContent.includes('¥3800')).catch(async (error) => {
        console.error('Website readiness:', errors, await page.locator('body').innerText(), calls)
        throw error
      })
      assert.equal(await page.locator('.plan-card').count(), 4)
      assert.match(await page.locator('.plan-card.pro20x').innerText(), /\$200/)
      assert.match(await page.locator('.plan-card.pro20x').innerText(), /Pro 10x/)
      assert.doesNotMatch(await page.locator('#plans').innerText(), /Pro 20x/)
      assert.match(await page.locator('.plan-card.pro25x').innerText(), /\$500/)
      for (const width of [1600, 960, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `website fits ${width}px`)
        await page.screenshot({ path: path.join(artifacts, `website-${width}.png`), fullPage: true })
      }
      await page.setViewportSize({ width: 1280, height: 1000 })
      await page.locator('[data-plan-id="pro25x"]').click()
      await page.locator('#riskInput').fill('我同意')
      for (const action of ['confirm-risk', 'open-login', 'after-login', 'open-session']) await page.locator(`[data-action="${action}"]`).click()
      await page.locator('#sessionText').fill(JSON.stringify({ user: { email: 'buyer@example.test' }, accessToken: 'synthetic-test-only' }))
      await page.locator('[data-action="identify-session"]').click()
      assert.match(await page.locator('#dialogDesc').innerText(), /Pro 25x/)
      await page.locator('[data-action="open-referral"]').click()
      await page.locator('#inviterEmail').fill('friend@example.test')
      assert.match(await page.locator('.referral-benefit').innerText(), /¥50/)
      await page.locator('[data-action="prepare-referral"]').click()
      await page.locator('[data-action="open-payment-method"]').waitFor()
      assert.ok(calls.some((call) => call.body.planId === 'pro25x' && call.body.inviterEmail === 'friend@example.test'))
      await page.screenshot({ path: path.join(artifacts, 'website-pro25x-checkout.png'), fullPage: true })
      await page.locator('#closeDialogButton').click()
      for (const email of ['bound@example.test', 'skipped@example.test']) {
        await page.locator('[data-plan-id="pro25x"]').click()
        await page.locator('#riskInput').fill('我同意')
        for (const action of ['confirm-risk', 'open-login', 'after-login', 'open-session']) await page.locator(`[data-action="${action}"]`).click()
        await page.locator('#sessionText').fill(JSON.stringify({ user: { email }, accessToken: 'synthetic-test-only' }))
        await page.locator('[data-action="identify-session"]').click()
        await page.locator('[data-action="open-referral"]').click()
        await page.locator('[data-action="open-payment-method"]').waitFor()
        assert.equal(await page.locator('#inviterEmail').count(), 0, 'website skips inviter input for an existing relation')
        await page.locator('#closeDialogButton').click()
      }
      assert.deepEqual(errors, [])
      await context.close()
    })
    console.log(`Browser QA screenshots: ${artifacts}`)
  } finally {
    await browser?.close()
    if (staticServer) { staticServer.closeAllConnections(); await new Promise((resolve) => staticServer.close(resolve)) }
    await server.close()
  }
})
