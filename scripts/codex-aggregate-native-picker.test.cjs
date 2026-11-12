const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { before, after, test } = require('node:test')
const { chromium } = require('playwright')
const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_aggregate_picker.js'), 'utf8')

// Captured native shape, not its private lifecycle: Codex 26.1103.7773
// webview/assets/async/209288.7eb941c4d4.js: ModelList > Item,
// role=menuitemradio, aria-checked, data-model-selected, React key=model.id.
// The source's onSelect owns effort fallback, persistence and view transition.
let browser
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : process.platform === 'win32' ? { channel: 'msedge' } : {}) })
})
after(async () => { await browser?.close() })

async function fixture(t, setup = {}) {
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.route('https://aggregate-picker.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }))
  await page.goto('https://aggregate-picker.invalid')
  await page.evaluate(({ source, setup }) => {
    document.head.innerHTML = '<style>body{font:14px Arial} [role=menu]{width:420px;padding:10px;border:1px solid #ccc} [role=menuitemradio],[role=menuitem]{display:block;padding:8px} button{font:inherit} </style>'
    document.body.innerHTML = '<button data-composer-navigation-target="reasoning" aria-haspopup="menu">Model</button><div data-radix-popper-content-wrapper><div role="menu" data-state="open" tabindex="-1"><div data-model-picker-view="advanced"><div class="ModelList-I4a0SH" id="native-model-list"></div><div class="SimpleView-ZBgvlc"><div id="native-fast" role="menuitemradio" aria-checked="false" tabindex="0"><span>Fast</span></div></div></div></div></div>'
    const ids = ['gaoge/openai/a/gpt-6-sol', 'gaoge/custom/openai/a/gpt-6-sol', 'gaoge/anthropic/b/claude-opus-4-8']
    const model = (id, nativeLabel, source, levels) => ({ publicModel: id, upstreamModel: id.split('/').pop(), nativeLabel, source,
      reasoningLevels: levels, contextWindow: 128000 })
    window.catalog = { enabled: true, defaultModel: ids[0], providers: [
      { id: 'openai', label: 'GPT', source: 'builtin', groups: [{ id: 'a', name: '主账号', source: 'builtin', models: [model(ids[0], 'GPT-6 Sol · 主账号 · GPT', 'builtin', [])] }] },
      { id: 'openai', label: 'GPT', source: 'custom', groups: [{ id: 'a', name: '主账号', source: 'custom', models: [model(ids[1], 'GPT-6 Sol · 主账号 · GPT', 'custom', ['low'])] }] },
      { id: 'anthropic', label: 'Claude', source: 'builtin', groups: [{ id: 'b', name: '工作账号', models: [model(ids[2], 'Claude Opus 4.8 · 工作账号 · Claude', 'builtin', ['ultra'])] }] },
    ] }
    if (setup.labelsUnique) window.catalog.providers[1].groups[0].models[0].nativeLabel += ' · 自有'
    if (setup.disabledCatalog) window.catalog.enabled = false
    window.nativeCalls = []; window.typeaheadCalls = []; window.escapeCalls = 0; window.fastCalls = 0; window.fetchCalls = 0; window.intervals = 0
    window.fetch = () => { window.fetchCalls++; throw Error('No network allowed') }
    const nativeInterval = window.setInterval
    window.setInterval = (...args) => { window.intervals++; return nativeInterval(...args) }
    window.rows = []
    const list = document.getElementById('native-model-list')
    window.nativeParent = list
    ids.forEach((id, index) => {
      const row = document.createElement('div')
      row.setAttribute('role', 'menuitemradio'); row.setAttribute('aria-checked', index === 0 ? 'true' : 'false'); row.setAttribute('tabindex', '-1')
      if (index === 0) row.setAttribute('data-model-selected', 'true')
      row.id = 'model-' + index
      row.innerHTML = '<span class="native-content"><span data-model-label></span></span>'
      row.querySelector('[data-model-label]').textContent = window.catalog.providers[index].groups[0].models[0].nativeLabel
      if (setup.identity === 'attributes') row.setAttribute('data-model-id', id)
      else if (setup.identity !== 'labels') row.__reactFiber$fixture = { key: null, memoizedProps: { role: 'menuitemradio' }, stateNode: row,
        return: { key: id, memoizedProps: { children: row.textContent }, return: { stateNode: list } } }
      if (setup.disabled === index) row.setAttribute('aria-disabled', 'true')
      row.addEventListener('click', event => {
        if (row.getAttribute('aria-disabled') === 'true') return
        window.nativeCalls.push({ id, trusted: event.isTrusted })
        if (setup.cancel || setup.noSelection) return
        const update = () => {
          for (const item of window.rows) { item.setAttribute('aria-checked', 'false'); item.removeAttribute('data-model-selected') }
          row.setAttribute('aria-checked', 'true'); row.setAttribute('data-model-selected', 'true')
        }
        if (setup.delay) setTimeout(update, setup.delay); else update()
      })
      row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') row.click() })
      window.rows.push(row); list.append(row)
    })
    window.fast = document.getElementById('native-fast'); window.fastParent = window.fast.parentElement; window.fastBefore = window.fast.outerHTML
    window.fast.addEventListener('click', () => { window.fastCalls++ })
    window.menu = document.querySelector('[role=menu]')
    window.menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') window.escapeCalls++
      else window.typeaheadCalls.push(event.key)
    })
    eval(source + '\nwindow.installPicker = installGaogeAggregateNativePicker')
    window.result = window.installPicker(window.catalog, { revision: 20, bridgeBase: 'http://127.0.0.1:1', bridgeToken: 'test-only', diagnosticDelay: 100,
      confirmationTimeout: 250 })
    window.firstRuntime = window.__gaogeAggregateModelPickerRuntime
  }, { source, setup })
  return page
}

async function status(page) { return page.evaluate(() => window.__gaogeAggregateModelPickerRuntime.status()) }
async function diagnostics(page) { return page.evaluate(() => window.__gaogeAggregateModelPickerRuntime.diagnostic()) }

test('source parses and contains no network/save/controller/polling dependency', () => {
  assert.doesNotThrow(() => new Function(source))
  for (const forbidden of ['setInterval(', 'fetch(', 'XMLHttpRequest', 'onSelectModel(', 'discoverAggregateNativeSelection', '.store.', 'onSelectModelOption(', '.pointermove']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})

test('real native shape uses bounded read-only React key without moving or replacing native rows', async t => {
  const page = await fixture(t)
  assert.equal((await status(page)).nativeMenuFound, true)
  assert.equal(await page.locator('[data-gaoge-aggregate-toolbar]').count(), 1)
  assert.deepEqual(await page.evaluate(() => window.rows.map(row => ({ same: document.getElementById(row.id) === row, parent: row.parentElement === window.nativeParent }))),
    [{ same: true, parent: true }, { same: true, parent: true }, { same: true, parent: true }])
  await page.locator('#model-2').click()
  await page.waitForTimeout(100)
  assert.equal((await status(page)).selectedModel, 'gaoge/anthropic/b/claude-opus-4-8')
  assert.equal(await page.evaluate(() => window.nativeCalls.length), 1)
  assert.equal(await page.evaluate(() => window.fetchCalls), 0)
  assert.equal(await page.evaluate(() => window.intervals), 0)
})

test('identical labels across sources preserve full ID and independent groups', async t => {
  const page = await fixture(t)
  await page.getByRole('button', { name: '自有聚合', exact: true }).click()
  assert.equal(await page.locator('#model-0').isVisible(), false)
  assert.equal(await page.locator('#model-1').isVisible(), true)
  await page.locator('#model-1').click()
  await page.waitForTimeout(100)
  assert.equal((await status(page)).selectedModel, 'gaoge/custom/openai/a/gpt-6-sol')
  assert.equal(await page.evaluate(() => window.nativeCalls[0].id), 'gaoge/custom/openai/a/gpt-6-sol')
})

test('ambiguous nativeLabel without full model identity never maps either source', async t => {
  const page = await fixture(t, { identity: 'labels' })
  const results = await page.evaluate(() => [window.__gaogeAggregateModelPickerRuntime.selectModel(window.catalog.providers[0].groups[0].models[0].publicModel),
    window.__gaogeAggregateModelPickerRuntime.selectModel(window.catalog.providers[1].groups[0].models[0].publicModel)])
  assert.deepEqual(results.map(value => value.reason), ['native-model-missing', 'native-model-missing'])
  assert.equal(await page.evaluate(() => window.nativeCalls.length), 0)
  assert.equal(await page.locator('#model-0').getAttribute('data-gaoge-aggregate-filtered'), null)
})

test('unique exact nativeLabel fallback maps old native DOM without private state', async t => {
  const page = await fixture(t, { identity: 'labels', labelsUnique: true })
  await page.locator('#model-2').click()
  await page.waitForTimeout(100)
  assert.equal((await status(page)).selectedModel, 'gaoge/anthropic/b/claude-opus-4-8')
})

test('native disabled row is never bypassed and missing target does not claim success', async t => {
  const page = await fixture(t, { identity: 'attributes', disabled: 2 })
  const result = await page.evaluate(() => window.__gaogeAggregateModelPickerRuntime.selectModel('gaoge/anthropic/b/claude-opus-4-8'))
  assert.deepEqual(result, { requested: false, confirmed: false, reason: 'native-model-disabled' })
  await page.evaluate(() => document.getElementById('model-2').remove())
  await page.waitForTimeout(100)
  const missing = await page.evaluate(() => window.__gaogeAggregateModelPickerRuntime.selectModel('gaoge/anthropic/b/claude-opus-4-8'))
  assert.deepEqual(missing, { requested: false, confirmed: false, reason: 'native-model-missing' })
  assert.equal(await page.evaluate(() => window.nativeCalls.length), 0)
})

test('native click without selected evidence stays unconfirmed, including cancellation', async t => {
  const page = await fixture(t, { cancel: true })
  const result = await page.evaluate(() => window.__gaogeAggregateModelPickerRuntime.selectModel('gaoge/anthropic/b/claude-opus-4-8'))
  assert.deepEqual(result, { requested: true, confirmed: false })
  await page.waitForTimeout(350)
  assert.equal((await status(page)).selectedModel, 'gaoge/openai/a/gpt-6-sol')
  const history = (await diagnostics(page)).history
  assert.equal(history.some(item => item.event === 'native-selection-unconfirmed'), true)
  assert.equal(history.some(item => item.event === 'native-selection-observed' && item.publicModel.includes('anthropic')), false)
  assert.equal(await page.evaluate(() => window.fetchCalls), 0)
})

test('no effort and disjoint effort models use native selection without invented gating', async t => {
  const page = await fixture(t)
  await page.locator('#model-2').click()
  await page.waitForTimeout(80)
  await page.getByRole('button', { name: '自有聚合', exact: true }).click()
  await page.locator('#model-1').click()
  await page.waitForTimeout(80)
  await page.getByRole('button', { name: '内置聚合', exact: true }).click()
  await page.locator('#model-0').click()
  await page.waitForTimeout(80)
  assert.equal(await page.evaluate(() => window.nativeCalls.length), 3)
  assert.equal((await status(page)).selectedModel, 'gaoge/openai/a/gpt-6-sol')
})

test('same revision complete catalog and connection reuse runtime during delayed selection', async t => {
  const page = await fixture(t, { delay: 180 })
  await page.locator('#model-2').click()
  const result = await page.evaluate(() => window.installPicker(structuredClone(window.catalog), { revision: 20,
    bridgeBase: 'http://127.0.0.1:1', bridgeToken: 'test-only' }))
  assert.equal(result.reused, true)
  assert.equal(await page.evaluate(() => window.firstRuntime === window.__gaogeAggregateModelPickerRuntime), true)
  assert.equal((await status(page)).pendingModel, 'gaoge/anthropic/b/claude-opus-4-8')
  await page.waitForTimeout(280)
  assert.equal((await status(page)).selectedModel, 'gaoge/anthropic/b/claude-opus-4-8')
  assert.equal(await page.locator('[data-gaoge-aggregate-toolbar]').count(), 1)
})

test('complete catalog metadata or bridge connection changes replace instance once', async t => {
  const page = await fixture(t)
  const result = await page.evaluate(() => {
    window.catalog.providers[0].groups[0].models[0].contextWindow = 256000
    window.installPicker(window.catalog, { revision: 20, bridgeBase: 'http://127.0.0.1:1', bridgeToken: 'test-only' })
    const replacedForMetadata = window.firstRuntime !== window.__gaogeAggregateModelPickerRuntime
    const second = window.__gaogeAggregateModelPickerRuntime
    window.installPicker(window.catalog, { revision: 20, bridgeBase: 'http://127.0.0.1:2', bridgeToken: 'test-only' })
    return { replacedForMetadata, replacedForConnection: second !== window.__gaogeAggregateModelPickerRuntime }
  })
  assert.deepEqual(result, { replacedForMetadata: true, replacedForConnection: true })
  assert.equal(await page.locator('[data-gaoge-aggregate-toolbar]').count(), 1)
})

test('search bypasses native typeahead, ArrowDown enters native rows and Escape stays native', async t => {
  const page = await fixture(t)
  const search = page.getByRole('searchbox', { name: '搜索聚合模型' })
  await search.pressSequentially('claude')
  assert.equal(await page.locator('#model-0').isVisible(), false)
  assert.equal(await page.locator('#model-2').isVisible(), true)
  assert.deepEqual(await page.evaluate(() => window.typeaheadCalls), [])
  await search.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'model-2')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(80)
  assert.equal(await page.evaluate(() => window.nativeCalls.length), 1)
  await search.focus(); await search.press('Escape')
  assert.equal(await page.evaluate(() => window.escapeCalls), 1)
})

test('provider and account-group filters never affect original speed rows', async t => {
  const page = await fixture(t)
  await page.getByRole('combobox', { name: '模型供应商' }).selectOption('builtin:anthropic')
  await page.getByRole('combobox', { name: '账号分组' }).selectOption('builtin:anthropic:b')
  assert.equal(await page.locator('#model-0').isVisible(), false)
  assert.equal(await page.locator('#model-2').isVisible(), true)
  await page.locator('#native-fast').click()
  assert.deepEqual(await page.evaluate(() => ({ same: window.fast === document.getElementById('native-fast'),
    parent: window.fast.parentElement === window.fastParent, unchanged: window.fast.outerHTML === window.fastBefore, calls: window.fastCalls })),
  { same: true, parent: true, unchanged: true, calls: 1 })
})

test('pointermove and unrelated transcript mutations do not scan or write diagnostics', async t => {
  const page = await fixture(t)
  await page.waitForTimeout(180)
  const before = await diagnostics(page)
  await page.evaluate(() => {
    const transcript = document.createElement('div'); transcript.id = 'transcript'; document.body.append(transcript)
  })
  await page.waitForTimeout(80)
  const afterInsertion = await diagnostics(page)
  await page.evaluate(() => {
    for (let i = 0; i < 100; i++) {
      window.rows[0].dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      const span = document.createElement('span'); span.textContent = String(i); document.getElementById('transcript').append(span)
    }
  })
  await page.waitForTimeout(180)
  const after = await diagnostics(page)
  assert.equal(after.scans, afterInsertion.scans)
  assert.equal(after.reconciles, afterInsertion.reconciles)
  assert.equal(after.diagnosticWrites, before.diagnosticWrites)
})

test('local native mutation bursts coalesce and diagnostic writes are throttled', async t => {
  const page = await fixture(t)
  await page.waitForTimeout(180)
  const before = await diagnostics(page)
  await page.evaluate(() => { for (let i = 0; i < 100; i++) window.rows[2].setAttribute('data-state', 'open-' + i) })
  await page.waitForTimeout(100)
  const after = await diagnostics(page)
  assert.ok(after.reconciles - before.reconciles <= 1)
  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) window.__gaogeAggregateModelPickerRuntime.selectModel('gaoge/anthropic/b/claude-opus-4-8')
  })
  await page.waitForTimeout(180)
  const final = await diagnostics(page)
  assert.ok(final.diagnosticWrites - after.diagnosticWrites <= 2)
  assert.equal(await page.evaluate(() => localStorage.getItem('gaoge.aggregate.picker-diagnostic').includes('test-only')), false)
})

test('disable restores native rows and upgrade cleanup disposes only once', async t => {
  const page = await fixture(t)
  await page.evaluate(() => {
    window.__gaogeAggregateModelPickerRuntime.dispose()
    window.disposes = 0
    window.__gaogeAggregateModelPickerRuntime = { dispose() { window.disposes++ } }
    const old = document.createElement('div'); old.id = 'gaoge-aggregate-model-picker'; document.body.append(old)
    const legacy = document.createElement('style'); legacy.id = 'gaoge-aggregate-model-picker-style'; document.head.append(legacy)
    window.catalog.enabled = false
    window.installPicker(window.catalog, { revision: 20 })
    window.installPicker(window.catalog, { revision: 20 })
  })
  assert.equal(await page.evaluate(() => window.disposes), 1)
  assert.equal(await page.locator('[data-gaoge-aggregate-toolbar]').count(), 0)
  assert.equal(await page.locator('[data-gaoge-aggregate-filtered]').count(), 0)
  assert.equal(await page.locator('#gaoge-aggregate-model-picker').count(), 0)
  assert.equal((await status(page)).enabled, false)
})

test('filtered rows follow native hidden contract and restore original hidden attributes', async t => {
  const page = await fixture(t)
  assert.equal(await page.locator('#model-1').getAttribute('hidden'), '')
  await page.evaluate(() => {
    // Native 26.1103 eS / eT navigation excludes hidden/inert/aria-hidden.
    window.menu.addEventListener('keydown', event => {
      if (event.target.closest('[data-gaoge-aggregate-toolbar]') || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
      const items = Array.from(window.menu.querySelectorAll('[role^="menuitem"]')).filter(row => !row.closest('[inert],[hidden],[aria-hidden="true"]'))
      const index = items.indexOf(document.activeElement)
      const next = items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
      event.preventDefault(); event.stopPropagation(); next?.focus()
    }, true)
    window.rows[0].focus()
  })
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'model-2')
  await page.getByRole('button', { name: '自有聚合', exact: true }).click()
  assert.equal(await page.locator('#model-1').getAttribute('hidden'), null)
  await page.evaluate(() => window.__gaogeAggregateModelPickerRuntime.dispose())
  assert.equal(await page.locator('#model-0').getAttribute('hidden'), null)
  assert.equal(await page.locator('#model-2').getAttribute('hidden'), null)
})

test('native transition to inert simple view still observes native selected model state', async t => {
  const page = await fixture(t)
  await page.evaluate(() => {
    window.rows[2].addEventListener('click', () => {
      document.getElementById('native-model-list').setAttribute('inert', '')
      document.getElementById('native-model-list').setAttribute('aria-hidden', 'true')
      document.querySelector('[data-model-picker-view]').setAttribute('data-model-picker-view', 'simple')
    })
  })
  await page.locator('#model-2').click()
  await page.waitForTimeout(100)
  assert.equal((await status(page)).selectedModel, 'gaoge/anthropic/b/claude-opus-4-8')
  assert.equal((await status(page)).pendingModel, '')
})

test('row identity changing to unknown restores native visibility instead of preserving a stale filter', async t => {
  const page = await fixture(t, { identity: 'attributes' })
  assert.equal(await page.locator('#model-1').getAttribute('hidden'), '')
  await page.evaluate(() => window.rows[1].setAttribute('data-model-id', 'other-provider/not-in-catalog'))
  await page.waitForTimeout(100)
  assert.equal(await page.locator('#model-1').getAttribute('hidden'), null)
  assert.equal(await page.locator('#model-1').getAttribute('data-gaoge-aggregate-filtered'), null)
  const result = await page.evaluate(() => window.__gaogeAggregateModelPickerRuntime.selectModel('gaoge/custom/openai/a/gpt-6-sol'))
  assert.equal(result.reason, 'native-model-missing')
})

test('closed portals release filtered rows and repeated reopening does not accumulate observers or state', async t => {
  const page = await fixture(t, { identity: 'attributes' })
  await page.evaluate(async () => {
    const pause = () => new Promise(resolve => setTimeout(resolve, 80))
    const runtime = window.__gaogeAggregateModelPickerRuntime
    const ids = window.catalog.providers.map(provider => provider.groups[0].models[0].publicModel)
    window.memoryCounts = []
    for (let attempt = 0; attempt < 12; attempt++) {
      document.querySelector('[data-radix-popper-content-wrapper]').remove()
      await pause()
      window.memoryCounts.push(runtime.diagnostic().trackedRowCount)
      const portal = document.createElement('div'); portal.setAttribute('data-radix-popper-content-wrapper', '')
      const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.setAttribute('data-state', 'open')
      for (const id of ids) {
        const row = document.createElement('div'); row.setAttribute('role', 'menuitemradio'); row.setAttribute('data-model-id', id); row.textContent = id
        menu.append(row)
      }
      portal.append(menu); document.body.append(portal); await pause()
    }
  })
  assert.deepEqual(await page.evaluate(() => window.memoryCounts), new Array(12).fill(0))
  const counts = await diagnostics(page)
  assert.equal(counts.trackedRowCount, 1)
  assert.equal(counts.controllerCount, 1)
  assert.equal(counts.portalObserverCount, 1)
  assert.equal(await page.locator('[data-gaoge-aggregate-toolbar]').count(), 1)
})

test('unrelated open menus and a submenu added later remain untouched', async t => {
  const page = await fixture(t, { identity: 'attributes' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluate(() => {
    const portal = document.createElement('div'); portal.setAttribute('data-radix-popper-content-wrapper', '')
    portal.innerHTML = '<div role="menu" id="other-menu"><div role="menuitem" id="other-action">Delete conversation</div></div>'
    document.body.append(portal)
  })
  await page.waitForTimeout(100)
  await page.getByRole('button', { name: '自有聚合', exact: true }).click()
  assert.equal(await page.locator('#other-action').getAttribute('hidden'), null)
  assert.equal(await page.locator('#other-menu [data-gaoge-aggregate-toolbar]').count(), 0)
  assert.deepEqual(errors, [])
})

test('reused native portal releases removed menu rows and decorates the next native menu', async t => {
  const page = await fixture(t, { identity: 'attributes' })
  await page.evaluate(() => window.menu.remove())
  await page.waitForTimeout(100)
  let counts = await diagnostics(page)
  assert.equal(counts.trackedRowCount, 0)
  assert.equal(counts.controllerCount, 0)
  await page.evaluate(() => {
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.setAttribute('data-state', 'open')
    const row = document.createElement('div'); row.setAttribute('role', 'menuitemradio')
    row.setAttribute('data-model-id', window.catalog.providers[0].groups[0].models[0].publicModel)
    row.textContent = 'Native rebuilt row'; menu.append(row)
    document.querySelector('[data-radix-popper-content-wrapper]').append(menu)
  })
  await page.waitForTimeout(100)
  counts = await diagnostics(page)
  assert.equal(counts.controllerCount, 1)
  assert.equal(counts.portalObserverCount, 1)
  assert.equal(await page.locator('[data-gaoge-aggregate-toolbar]').count(), 1)
})

test('conflicting full model IDs fail closed instead of falling back to text', async t => {
  const page = await fixture(t, { identity: 'attributes', labelsUnique: true })
  await page.evaluate(() => {
    window.rows[2].setAttribute('data-model', window.catalog.providers[0].groups[0].models[0].publicModel)
  })
  await page.waitForTimeout(100)
  const result = await page.evaluate(() => window.__gaogeAggregateModelPickerRuntime.selectModel('gaoge/anthropic/b/claude-opus-4-8'))
  assert.equal(result.requested, false)
  assert.equal(result.reason, 'native-model-missing')
  assert.equal(await page.evaluate(() => window.nativeCalls.length), 0)
})

test('native Radix and tooltip wrapper depth retains full row ID without crossing the next DOM parent', async t => {
  const page = await fixture(t)
  await page.evaluate(() => {
    for (let index = 0; index < window.rows.length; index++) {
      const row = window.rows[index]
      const key = window.catalog.providers[index].groups[0].models[0].publicModel
      let ancestor = { key, memoizedProps: { children: row.textContent }, return: { stateNode: window.nativeParent,
        return: { key: window.catalog.providers[0].groups[0].models[0].publicModel } } }
      // 26.1103 Item > tooltip > DropdownMenuItem > MenuItemImpl > Collection /
      // Slot > RovingFocus / Slot > Primitive asChild / Slot can exceed 12.
      for (let depth = 0; depth < 24; depth++) ancestor = { key: null, memoizedProps: {}, return: ancestor }
      row.__reactFiber$fixture = { stateNode: row, key: null, memoizedProps: {}, return: ancestor }
    }
    window.rows[1].firstChild.append(document.createTextNode(''))
  })
  await page.waitForTimeout(100)
  await page.getByRole('button', { name: '自有聚合', exact: true }).click()
  assert.equal(await page.locator('#model-1').isVisible(), true)
  assert.equal(await page.locator('#model-0').isVisible(), false)
  await page.locator('#model-1').click()
  await page.waitForTimeout(100)
  assert.equal((await status(page)).selectedModel, 'gaoge/custom/openai/a/gpt-6-sol')
})

test('an ancestor composer model beyond the native row DOM boundary is never used as row identity', async t => {
  const page = await fixture(t)
  await page.evaluate(() => {
    window.rows[1].__reactFiber$fixture = { stateNode: window.rows[1], memoizedProps: {}, return: { stateNode: window.nativeParent,
      return: { key: window.catalog.providers[0].groups[0].models[0].publicModel, memoizedProps: { model: window.catalog.defaultModel } } } }
    window.rows[1].querySelector('[data-model-label]').textContent = 'Unknown native row'
  })
  await page.waitForTimeout(100)
  assert.equal(await page.locator('#model-1').getAttribute('hidden'), null)
  const result = await page.evaluate(() => window.__gaogeAggregateModelPickerRuntime.selectModel('gaoge/custom/openai/a/gpt-6-sol'))
  assert.equal(result.reason, 'native-model-missing')
})

test('native per-conversation selection controls initial source instead of stale global default', async t => {
  const page = await fixture(t)
  await page.evaluate(() => {
    window.__gaogeAggregateModelPickerRuntime.dispose()
    for (const row of window.rows) { row.setAttribute('aria-checked', 'false'); row.removeAttribute('data-model-selected') }
    window.rows[1].setAttribute('aria-checked', 'true'); window.rows[1].setAttribute('data-model-selected', 'true')
    window.installPicker(window.catalog, { revision: 20 })
  })
  assert.equal(await page.getByRole('button', { name: '自有聚合', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('#model-1').isVisible(), true)
  assert.equal((await status(page)).selectedModel, 'gaoge/custom/openai/a/gpt-6-sol')
})


function contrastRatio(foreground, background) {
  const luminance = color => {
    const components = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const channel = value / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
  return (values[1] + 0.05) / (values[0] + 0.05)
}

test('native select and option colors stay readable through light dark and wallpaper theme changes', async t => {
  const page = await fixture(t)
  const themes = [
    { name: 'native light', scheme: 'light', text: '#18212f', surface: '#ffffff', wallpaper: false },
    { name: 'native dark', scheme: 'dark', text: '#f8fafc', surface: '#18212f', wallpaper: false },
    // A dark wallpaper over a system-light appearance reproduces the popup
    // mismatch. Popup colors must follow the palette, not inherited light text.
    { name: 'dark wallpaper with light system controls', scheme: 'light', text: '#f8fafc', surface: '#131a31', wallpaper: true },
    { name: 'light wallpaper with dark system controls', scheme: 'dark', text: '#1e293b', surface: '#f5f3ef', wallpaper: true },
  ]
  const initialScans = (await diagnostics(page)).scans
  for (const theme of themes) {
    const colors = await page.evaluate(theme => {
      const root = document.documentElement
      root.style.colorScheme = theme.scheme
      document.body.style.color = theme.text
      for (const name of ['--gaoge-theme-text', '--gaoge-theme-surface']) root.style.removeProperty(name)
      root.style.setProperty('--color-text-foreground', theme.text)
      root.style.setProperty('--color-background-control-opaque', theme.wallpaper ? '#abcdef' : theme.surface)
      root.style.setProperty('--color-background-surface', theme.wallpaper ? 'rgba(255,255,255,.1)' : theme.surface)
      if (theme.wallpaper) {
        root.style.setProperty('--gaoge-theme-text', theme.text)
        root.style.setProperty('--gaoge-theme-surface', theme.surface)
      }
      return [...document.querySelectorAll('[data-gaoge-aggregate-toolbar] select,[data-gaoge-aggregate-toolbar] option')]
        .map(node => { const style = getComputedStyle(node); return { color: style.color, background: style.backgroundColor } })
    }, theme)
    assert.ok(colors.length > 4)
    for (const color of colors) {
      assert.match(color.background, /^rgb\(/, `${theme.name}: popup must have an opaque background`)
      assert.ok(contrastRatio(color.color, color.background) >= 4.5, `${theme.name}: ${JSON.stringify(color)}`)
    }
  }
  await page.waitForTimeout(100)
  assert.equal((await diagnostics(page)).scans, initialScans, 'palette changes do not add menu scans')
})

test('custom source shows one full-width supplier control and ignores account-group state', async t => {
  const page = await fixture(t)
  await page.getByRole('combobox', { name: '模型供应商' }).selectOption('builtin:anthropic')
  await page.getByRole('combobox', { name: '账号分组' }).selectOption('builtin:anthropic:b')
  await page.getByRole('button', { name: '自有聚合', exact: true }).click()
  assert.equal(await page.getByRole('combobox').count(), 1)
  const group = page.locator('select[aria-label="账号分组"]')
  assert.equal(await group.isVisible(), false)
  assert.equal(await group.isDisabled(), true)
  assert.equal(await group.inputValue(), '')
  await group.evaluate(node => {
    node.append(new Option('stale hidden group', 'builtin:anthropic:b'))
    node.value = 'builtin:anthropic:b'; node.dispatchEvent(new Event('change', { bubbles: true }))
  })
  assert.equal(await page.locator('#model-1').isVisible(), true)
  assert.equal(await group.inputValue(), '')
  const sizes = await page.evaluate(() => ({
    parent: document.querySelector('.gaoge-aggregate-selects').getBoundingClientRect().width,
    select: document.querySelector('select[aria-label="模型供应商"]').getBoundingClientRect().width,
  }))
  assert.ok(Math.abs(sizes.parent - sizes.select) < 1)
  await page.getByRole('button', { name: '内置聚合', exact: true }).click()
  assert.equal(await page.getByRole('combobox').count(), 2)
  assert.equal(await group.isDisabled(), false)
  assert.equal(await page.locator('#model-0').isVisible(), true)
  assert.equal(await page.locator('#model-2').isVisible(), true)
  assert.equal(await page.evaluate(() => window.nativeCalls.length), 0)
})

test('custom vendor filtering combines supplier labels while preserving distinct endpoint model identity', async t => {
  const page = await fixture(t, { identity: 'attributes' })
  await page.evaluate(() => {
    window.catalog.providers = window.catalog.providers.filter(provider => provider.source !== 'custom')
    window.rows[1].remove(); window.rows.splice(1, 1)
    const entries = [
      ['external-deepseek-a', 'deepseek', 'DeepSeek', 'deepseek-reasoner'],
      ['external-deepseek-b', 'deepseek', 'DeepSeek', 'deepseek-reasoner'],
      ['external-kimi', 'kimi', 'Kimi', 'kimi-k2-thinking'],
    ]
    entries.forEach(([providerId, vendorId, vendorLabel, model], index) => {
      const id = `gaoge/custom/${providerId}/custom/${model}`
      const nativeLabel = `${model} · ${vendorLabel}`
      window.catalog.providers.push({ id: providerId, name: `用户接口 ${index}`, source: 'custom', vendorId, vendorLabel,
        groups: [{ id: 'custom', name: '自有接口', models: [{ publicModel: id, nativeLabel, upstreamModel: model, source: 'custom' }] }] })
      const row = document.createElement('div'); row.id = `custom-model-${index}`
      row.setAttribute('role', 'menuitemradio'); row.setAttribute('aria-checked', 'false'); row.setAttribute('data-model-id', id)
      row.textContent = nativeLabel
      row.addEventListener('click', event => {
        window.nativeCalls.push({ id, trusted: event.isTrusted })
        for (const item of window.rows) { item.setAttribute('aria-checked', 'false'); item.removeAttribute('data-model-selected') }
        row.setAttribute('aria-checked', 'true'); row.setAttribute('data-model-selected', 'true')
      })
      window.rows.push(row); window.nativeParent.append(row)
    })
    window.installPicker(window.catalog, { revision: 21 })
  })
  await page.getByRole('button', { name: '自有聚合', exact: true }).click()
  assert.deepEqual(await page.locator('select[aria-label="模型供应商"] option').allTextContents(), ['全部供应商', 'DeepSeek', 'Kimi'])
  await page.getByRole('combobox', { name: '模型供应商' }).selectOption('custom:deepseek')
  assert.equal(await page.locator('#custom-model-0').isVisible(), true)
  assert.equal(await page.locator('#custom-model-1').isVisible(), true)
  assert.equal(await page.locator('#custom-model-2').isVisible(), false)
  await page.locator('#custom-model-1').click()
  await page.waitForTimeout(100)
  assert.equal((await status(page)).selectedModel, 'gaoge/custom/external-deepseek-b/custom/deepseek-reasoner')
  assert.deepEqual(await page.evaluate(() => window.nativeCalls.map(item => item.id)), ['gaoge/custom/external-deepseek-b/custom/deepseek-reasoner'])
  await page.getByRole('combobox', { name: '模型供应商' }).selectOption('custom:kimi')
  assert.equal(await page.locator('#custom-model-0').isVisible(), false)
  assert.equal(await page.locator('#custom-model-2').isVisible(), true)
})

test('custom source without a configured supplier explains its empty state', async t => {
  const page = await fixture(t, { identity: 'attributes' })
  await page.evaluate(() => {
    window.catalog.providers = window.catalog.providers.filter(provider => provider.source !== 'custom')
    window.rows[1].remove()
    window.installPicker(window.catalog, { revision: 21 })
  })
  await page.getByRole('button', { name: '自有聚合', exact: true }).click()
  assert.equal(await page.locator('.gaoge-aggregate-empty').textContent(), '尚未添加自有供应商')
})

test('no search matches and configured models missing from the native list have different empty states', async t => {
  const page = await fixture(t, { identity: 'attributes' })
  await page.getByRole('searchbox', { name: '搜索聚合模型' }).fill('not-a-configured-model')
  assert.equal(await page.locator('.gaoge-aggregate-empty').textContent(), '没有匹配的模型')
  await page.getByRole('searchbox', { name: '搜索聚合模型' }).fill('')
  await page.evaluate(() => window.rows[1].remove())
  await page.waitForTimeout(100)
  await page.getByRole('button', { name: '自有聚合', exact: true }).click()
  assert.equal(await page.locator('.gaoge-aggregate-empty').textContent(), '已配置模型尚未出现在列表中，请重新打开菜单')
})

test('toolbar does not force a horizontal scrollbar inside a narrow native menu', async t => {
  const page = await fixture(t)
  await page.evaluate(() => { window.menu.style.width = '230px'; window.menu.style.overflow = 'auto' })
  for (const source of ['内置聚合', '自有聚合']) {
    await page.getByRole('button', { name: source, exact: true }).click()
    const sizes = await page.locator('[data-gaoge-aggregate-toolbar]').evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }))
    assert.ok(sizes.scroll <= sizes.client, `${source}: ${JSON.stringify(sizes)}`)
  }
})
