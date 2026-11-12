import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const noticeKey = 'gaoge_desktop_codex_update_notice_version'

test('post-update notice does not inspect or migrate Codex configuration', { timeout: 120000 }, async (t) => {
  const artifacts = await mkdtemp(path.join(tmpdir(), 'gaoge-update-notice-ui-'))
  const parent = await readFile(path.join(root, 'src/components/新版主题.vue'), 'utf8')
  const source = ts.createSourceFile('theme.ts', parent.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const confirmations = ts.transpileModule(source.statements
    .filter(node => ts.isFunctionDeclaration(node) && ['confirmAction', 'closeConfirmDialog'].includes(node.name?.text))
    .map(node => node.getText(source)).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const server = await createServer({
    root, configFile: false, envDir: false, cacheDir: path.join(artifacts, 'vite'),
    plugins: [vue(), {
      name: 'update-notice-fixture',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === '/__notice-entry.js') return '\0notice-entry'
        if (id === '../domain-config' && importer?.includes('CodexConfigUpgradeDialog.vue')) return '\0notice-domain-config'
      },
      load(id) {
        if (id === '\0notice-domain-config') return "export const getApiBaseUrl=()=> 'https://control.test/custom/api/v1'; export const getOpenAIBaseUrl=()=> 'https://relay.test/v1';"
        if (id !== '\0notice-entry') return
        return `import { createApp, h, nextTick, reactive, ref } from 'vue';
          import Notice from '/src/components/CodexConfigUpgradeDialog.vue';
          const params = new URLSearchParams(location.search);
          if(params.has('storage-failure')) Storage.prototype.setItem=()=>{throw Error('storage blocked')};
          const props=reactive({enabled:!params.has('disabled'),busy:params.has('busy'),version:params.has('no-version')?'':'1.6.0'});
          window.qaProps=props; window.qaCalls=[]; window.qaBusy=[];
          window.qaLock=''; window.qaDone=false;
          const forbidden=name=>async()=>{window.qaCalls.push(name);window.qaLock=name;throw Error('unexpected configuration inspection')};
          window.gaogeDesktop={
            getCodexConfigUpgradeStatus:forbidden('status'),
            deferCodexConfigUpgrade:forbidden('defer'),
            applyCodexConfigUpgrade:forbidden('migrate'),
            onCodexLoginProgress:fn=>{window.qaProgress=fn;return ()=>{window.qaProgress=null}},
            restartCodex:async(request)=>{
              window.qaRestartRequest=request;
              window.qaCalls.push('restart');
              if(params.has('failure'))throw Error('模拟启动失败');
              if(params.has('slow'))await new Promise(resolve=>window.qaFinish=resolve);
              return {codexLaunched:!params.has('launch-failure')&&!params.has('queued'),codexLaunchQueued:params.has('queued'),warnings:params.has('policy-warning')?['模型支持配置暂不可用，已保留上次成功的模型支持配置。']:[]};
            }
          };
          let confirmResolve=null;
          const confirmDialog=ref({open:false});
          const stripSensitiveErrorText=value=>value;
          ${confirmations}
          window.qaCloseConfirm=closeConfirmDialog;
          window.qaBeginConfirmedAction=async()=>{
            window.qaDone=false;
            if(await confirmAction('重启 Codex')) {
              if(window.qaLock)throw Error('action blocked by '+window.qaLock);
              await window.gaogeDesktop.restartCodex();
            }
            window.qaDone=true;
          };
          window.qaSettle=async()=>{await nextTick();await nextTick()};
          createApp({render:()=>h('main',[
            h('h1','Gaoge Free'),
            h('button',{id:'outside'},'后台操作'),
            h(Notice,{...props,busy:props.busy||confirmDialog.value.open,
              onBusyChange:value=>{window.qaBusy.push(value);props.busy=value}})
          ])}).mount('#app');`
      },
      configureServer(vite) {
        vite.middlewares.use('/__notice', (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>更新通知验证</title><style>body{margin:0;background:#0b1220;color:#e2e8f0;font-family:system-ui}main{padding:32px}</style><main id="app"></main><script type="module" src="/__notice-entry.js"></script></html>')
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
    const open = async (query = '') => {
      const context = await browser.newContext({ viewport: { width: 960, height: 720 } })
      const page = await context.newPage()
      page.setDefaultTimeout(10000)
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${server.resolvedUrls.local[0]}__notice${query}`)
      await page.waitForFunction(() => window.qaSettle)
      await page.evaluate(() => window.qaSettle())
      return page
    }
    const restartButton = page => page.getByRole('button', { name: '重启 Codex', exact: true })
    const assertCalls = async (page, calls) => assert.deepEqual(await page.evaluate(() => window.qaCalls), calls)

    await t.test('initial notice is visible and dismissal uses no native commands', async () => {
      const page = await open()
      await restartButton(page).waitFor()
      assert.match(await page.getByRole('dialog').innerText(), /关闭登录.*开始登录/)
      assert.match(await page.getByRole('dialog').innerText(), /已有账号加油.*关闭加油.*开始加油/)
      assert.match(await page.getByRole('dialog').innerText(), /官方登录的用户无需重新配置/)
      assert.match(await page.getByRole('dialog').innerText(), /同步当前由本软件管理的模型支持配置/)
      assert.match(await page.getByRole('dialog').innerText(), /不会改动官方登录状态或其他个人配置/)
      await page.screenshot({ path: path.join(artifacts, 'notice.png') })
      await assertCalls(page, [])
      await page.getByRole('button', { name: '知道了，稍后处理' }).click()
      assert.equal(await page.locator('dialog[open]').count(), 0)
      await assertCalls(page, [])
      await page.reload()
      await page.waitForFunction(() => window.qaSettle)
      await page.evaluate(() => window.qaSettle())
      assert.equal(await page.locator('dialog[open]').count(), 0)
      await assertCalls(page, [])
      await page.evaluate(() => { window.qaProps.version = '1.6.1' })
      await restartButton(page).waitFor()
      assert.equal(await page.evaluate(key => localStorage.getItem(key), noticeKey), '1.6.1')
    })

    await t.test('version and enabled/busy changes never trigger configuration inspection', async () => {
      const page = await open('?disabled&no-version&busy')
      assert.equal(await page.locator('dialog[open]').count(), 0)
      await page.evaluate(() => { window.qaProps.enabled=true; window.qaProps.version='1.6.0' })
      await page.evaluate(() => window.qaSettle())
      assert.equal(await page.locator('dialog[open]').count(), 0)
      await page.evaluate(() => { window.qaProps.busy=false })
      await restartButton(page).waitFor()
      await page.keyboard.press('Escape')
      for (const busy of [true, false, true, false]) {
        await page.evaluate(value => { window.qaProps.busy=value; window.dispatchEvent(new Event('focus')) }, busy)
        await page.evaluate(() => window.qaSettle())
      }
      assert.equal(await page.locator('dialog[open]').count(), 0)
      await assertCalls(page, [])
    })

    await t.test('restart calls the restart bridge once, no second confirmation or migration', async () => {
      const page = await open('?slow')
      await restartButton(page).click()
      await page.getByRole('heading', { name: '正在重启 Codex', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('dialog[open]').count(), 1)
      await assertCalls(page, ['restart'])
      assert.deepEqual(await page.evaluate(() => window.qaRestartRequest), {modelPolicyApiBaseUrl:'https://control.test/custom/api/v1',relayBaseUrl:'https://relay.test/v1'})
      assert.deepEqual(await page.evaluate(() => window.qaBusy), [true])
      await page.evaluate(() => { window.qaProgress({ message: '正在启动 Codex' }); window.qaFinish() })
      await page.getByRole('heading', { name: 'Codex 已重启', exact: true }).waitFor()
      assert.deepEqual(await page.evaluate(() => window.qaBusy), [true, false])
      assert.equal(await page.evaluate(() => window.qaProgress), null)
      await assertCalls(page, ['restart'])
    })

    await t.test('restart displays a retained-policy warning from the native bridge', async () => {
      const page = await open('?policy-warning')
      await restartButton(page).click()
      await page.getByRole('heading', { name: 'Codex 已重启', exact: true }).waitFor()
      assert.match(await page.getByRole('dialog').innerText(), /已保留上次成功的模型支持配置/)
      await assertCalls(page, ['restart'])
    })

    await t.test('accepting a restart is not dropped when a busy prop changes', async () => {
      const page = await open()
      await restartButton(page).waitFor()
      await page.evaluate(() => { window.qaProps.busy=true })
      await restartButton(page).click()
      await page.getByRole('heading', { name: 'Codex 已重启', exact: true }).waitFor()
      await assertCalls(page, ['restart'])
    })

    for (const [query, heading] of [
      ['?failure', 'Codex 重启未完成'],
      ['?launch-failure', 'Codex 未能自动打开'],
      ['?queued', 'Codex 正在启动'],
    ]) {
      await t.test(`reports ${heading} truthfully and releases busy`, async () => {
        const page = await open(query)
        await restartButton(page).click()
        await page.getByRole('heading', { name: heading, exact: true }).waitFor()
        assert.deepEqual(await page.evaluate(() => window.qaBusy), [true, false])
        await assertCalls(page, ['restart'])
        if (query === '?failure') assert.match(await page.getByRole('alert').innerText(), /模拟启动失败/)
      })
    }

    await t.test('unavailable local storage does not prevent dismissal or later actions', async () => {
      const page = await open('?storage-failure')
      await restartButton(page).waitFor()
      await page.keyboard.press('Escape')
      await page.evaluate(() => { window.qaProps.busy=true })
      await page.evaluate(() => { window.qaProps.busy=false })
      await page.evaluate(() => window.qaSettle())
      assert.equal(await page.locator('dialog[open]').count(), 0)
      await assertCalls(page, [])
    })

    await t.test('closing the production confirmation cannot let the notice grab a configuration lock', async () => {
      const page = await open()
      await page.getByRole('button', { name: '知道了，稍后处理' }).click()
      await page.evaluate(() => { void window.qaBeginConfirmedAction() })
      await page.evaluate(() => window.qaSettle())
      await page.evaluate(() => { window.qaCloseConfirm(true) })
      await page.waitForFunction(() => window.qaDone)
      await assertCalls(page, ['restart'])
      assert.equal(await page.evaluate(() => window.qaLock), '')
      assert.equal(await page.locator('dialog[open]').count(), 0)
    })

    await t.test('notice fits a narrow window', async () => {
      const page = await open()
      await page.setViewportSize({ width: 390, height: 844 })
      await restartButton(page).waitFor()
      const box = await page.getByRole('dialog').boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 390)
      assert.ok(box.y >= 0 && box.y + box.height <= 844)
      await page.screenshot({ path: path.join(artifacts, 'notice-narrow.png') })
    })
    assert.deepEqual(errors, [])
    console.log(`Update notice UI screenshots: ${artifacts}`)
  } finally {
    await browser?.close()
    await server.close()
  }
})
