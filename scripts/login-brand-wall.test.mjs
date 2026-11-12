import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = {
  version: 1,
  updatedAt: '2026-11-11T00:00:00Z',
  defaultServerId: 'preview',
  servers: [{ id: 'preview', name: '界面预览', rootDomain: 'preview.invalid', enabled: true }],
}
const rendererErrors = []
const observations = []
let artifacts, dist, browser, server, baseUrl

before(async () => {
  artifacts = await mkdtemp(path.join(os.tmpdir(), 'gaoge-login-brand-wall-'))
  dist = path.join(artifacts, 'dist')
  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'error',
    build: { outDir: dist, emptyOutDir: false },
  })
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname))
      if (!file.startsWith(dist + path.sep)) { response.writeHead(403); response.end(); return }
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' }
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
      response.end(await readFile(file))
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!String(error).includes("Executable doesn't exist")) throw error
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  }
}, { timeout: 60000 })

after(async () => {
  await browser?.close()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  if (artifacts) {
    await writeFile(path.join(artifacts, 'measurements.json'), JSON.stringify({ observations, rendererErrors }, null, 2))
    console.log(`Login brand wall verification artifacts: ${artifacts}`)
  }
  assert.deepEqual(rendererErrors, [], 'Unexpected renderer errors')
})

async function pageFor(reducedMotion, viewport = { width: 1250, height: 800 }) {
  const page = await browser.newPage({ reducedMotion, viewport, deviceScaleFactor: 1 })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => rendererErrors.push(error.message))
  // Keep the real app bootstrap and login gate, but never contact production services.
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === baseUrl) return route.continue()
    const payload = url.hostname.endsWith('preview.invalid') ? { code: 0, data: [], status: 'ok' } : directory
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
  })
  await page.addInitScript(value => {
    window.gaogeDesktop = {}
    localStorage.setItem('gaoge_desktop_server_directory_v1', JSON.stringify({ directory: value, sourceEntry: 'preview', cachedAt: new Date().toISOString() }))
  }, directory)
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.getByRole('button', { name: '使用此服务器', exact: true }).click()
  await page.locator('.new-theme-login-gate').waitFor({ state: 'visible' })
  await page.locator('.new-theme-auth-card').getByRole('button', { name: '已有账号登录', exact: true }).click()
  await page.getByPlaceholder('填写账号', { exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.login-customer-card img')]
    return images.length === 40 && images.every(img => img.complete && img.naturalWidth > 0)
  })
  await page.locator('.new-theme-toast-stack').waitFor({ state: 'hidden' })
  await page.mouse.move(0, 0)
  assert.equal(await page.locator('#login-customer-title').innerText(), '致力服务好每一位用户')
  assert.equal(await page.locator('.login-customer-group:not([aria-hidden="true"]) .login-customer-card').count(), 20)
  return page
}

async function positions(page) {
  return page.locator('.login-customer-track').evaluateAll(tracks => tracks.map(track => {
    const transform = getComputedStyle(track).transform
    return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41
  }))
}

async function expectMotion(page, label) {
  const start = await positions(page)
  // Observe actual on-screen translation, not only a declared animation name.
  await page.waitForTimeout(320)
  const end = await positions(page)
  assert.equal(start.length, 3, `${label}: exactly three rows`)
  const delta = end.map((value, index) => value - start[index])
  delta.forEach((value, index) => assert.ok(Math.abs(value) > 0.5, `${label}: row ${index + 1} did not move (${value}px)`))
  assert.ok(delta[0] < 0 && delta[1] > 0 && delta[2] < 0, `${label}: rows should move in alternating directions (${delta})`)
  observations.push({ label, motionDelta: delta })
}

async function geometry(page) {
  return page.evaluate(() => {
    const box = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
    }
    const gate = document.querySelector('.new-theme-login-gate')
    return {
      viewport: { width: innerWidth, height: innerHeight },
      gate: { width: gate.clientWidth, height: gate.clientHeight, scrollWidth: gate.scrollWidth, scrollHeight: gate.scrollHeight },
      brand: box('.login-brand-panel'),
      form: box('.new-theme-auth-shell'),
      wall: box('.login-customer-wall'),
      rows: [...document.querySelectorAll('.login-customer-row')].map(row => {
        const cards = [...row.querySelector('.login-customer-group').children]
        return { height: row.getBoundingClientRect().height, cardTops: cards.map(card => card.getBoundingClientRect().top) }
      }),
    }
  })
}

async function expectDesktopLayout(page, label) {
  const value = await geometry(page)
  assert.ok(value.gate.scrollWidth <= value.gate.width + 1, `${label}: horizontal overflow`)
  assert.ok(value.gate.scrollHeight <= value.gate.height + 1, `${label}: vertical overflow (${value.gate.scrollHeight} > ${value.gate.height})`)
  assert.ok(value.form.x > value.brand.right, `${label}: login card must remain on the right`)
  assert.ok(Math.abs(value.form.y + value.form.height / 2 - value.viewport.height / 2) < 2, `${label}: login card should be vertically centered`)
  assert.equal(value.rows.length, 3)
  for (const row of value.rows) {
    assert.ok(row.height <= 90, `${label}: a row expanded into a grid (${row.height}px)`)
    assert.ok(Math.max(...row.cardTops) - Math.min(...row.cardTops) < 1, `${label}: cards must stay on one horizontal line`)
  }
  assert.ok(Math.max(...value.rows.map(row => row.height)) - Math.min(...value.rows.map(row => row.height)) < 1, `${label}: row heights differ`)
  observations.push({ label, geometry: value })
  return value
}

for (const preference of ['no-preference', 'reduce']) {
  test(`continuous autoplay, compact desktop layout and pointer interactions with ${preference} from initial load`, async () => {
    const page = await pageFor(preference)
    try {
      await expectMotion(page, `${preference}: initial autoplay`)
      await expectDesktopLayout(page, `${preference}: 1250x800`)
      await page.setViewportSize({ width: 1250, height: 700 })
      await expectDesktopLayout(page, `${preference}: 1250x700`)
      await expectMotion(page, `${preference}: shorter desktop`)

      assert.equal(await page.locator('.login-brand-customers button').count(), 0, 'Customer wall should have no playback controls')
      assert.equal(await page.getByRole('button', { name: /暂停标识滚动|播放标识滚动/ }).count(), 0)
      const wall = page.locator('.login-customer-wall')
      await wall.hover()
      await expectMotion(page, `${preference}: continues during hover`)
      await wall.click({ position: { x: 40, y: 20 } })
      await expectMotion(page, `${preference}: continues after click inside wall`)
      await page.mouse.move(0, 0)
      await expectMotion(page, `${preference}: continues after pointer leave`)
      await page.setViewportSize({ width: 1250, height: 800 })
      await page.screenshot({ path: path.join(artifacts, `login-${preference}.png`), animations: 'disabled' })
    } finally { await page.close() }
  }, { timeout: 30000 })
}

test('changing reduced-motion preference never changes the wall or form geometry', async () => {
  const page = await pageFor('no-preference')
  try {
    const initial = await expectDesktopLayout(page, 'before media change')
    for (const preference of ['reduce', 'no-preference']) {
      await page.emulateMedia({ reducedMotion: preference })
      await expectMotion(page, `media changed to ${preference}`)
      const current = await expectDesktopLayout(page, `after media ${preference}`)
      for (const element of ['brand', 'form', 'wall']) {
        for (const dimension of ['x', 'y', 'width', 'height']) {
          assert.ok(Math.abs(current[element][dimension] - initial[element][dimension]) < 1, `${element}.${dimension} changed when media preference became ${preference}`)
        }
      }
    }
  } finally { await page.close() }
}, { timeout: 20000 })

test('narrow reduced-motion viewport keeps login reachable without horizontal overflow', async () => {
  const page = await pageFor('reduce', { width: 390, height: 844 })
  try {
    const value = await geometry(page)
    assert.ok(value.gate.scrollWidth <= value.gate.width + 1, 'Narrow page overflows horizontally')
    assert.ok(value.form.x >= 0 && value.form.right <= 390, 'Login card leaves the narrow viewport')
    assert.ok(value.form.y >= 0 && value.form.bottom < value.brand.y, 'Login should precede the brand panel on narrow screens')
    assert.ok(value.rows.every(row => row.height <= 90), 'Narrow wall expanded into a grid')
    await page.locator('.login-customer-wall').scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await expectMotion(page, 'narrow reduce autoplay')
    observations.push({ label: '390x844 reduce', geometry: value })
    await page.screenshot({ path: path.join(artifacts, 'login-narrow.png'), animations: 'disabled' })
  } finally { await page.close() }
}, { timeout: 20000 })
