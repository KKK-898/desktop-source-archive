const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_paste_runtime.js'), 'utf8')

function harness(options = {}) {
  const handlers = new Set()
  const document = { addEventListener(name, fn, capture) { assert.equal(name, 'paste'); assert.equal(capture, true); handlers.add(fn) }, removeEventListener(_name, fn) { handlers.delete(fn) } }
  const editor = { ownerDocument: document, isConnected: true,
    closest(selector) {
      if (selector === '.ProseMirror[contenteditable=\'true\']') return this
      if (selector === '[data-codex-composer-root]') return options.scope === false ? null : {}
      return options.disabled ? {} : null
    },
  }
  editor.pmViewDesc = { dom: editor, parent: null, node: { type: { name: 'doc' }, toJSON() { return {} } } }
  class DataTransfer {
    constructor() { this.values = {}; this.files = []; this.items = [] }
    setData(type, value) { this.values[type] = value }
    getData(type) { return this.values[type] || '' }
    get types() { return Object.keys(this.values) }
  }
  const window = { document, DataTransfer }
  const context = vm.createContext({ window })
  vm.runInContext(source, context)
  const runtime = vm.runInContext('installCodexPasteRuntime()', context)
  function paste(text, formats = { 'text/html': '<b>fixture</b>' }, extra = {}) {
    const original = new DataTransfer()
    original.setData('text/plain', text)
    for (const [type, value] of Object.entries(formats)) original.setData(type, value)
    const event = { target: editor, cancelable: true, defaultPrevented: false, clipboardData: original, ...extra }
    if (options.frozen) Object.defineProperty(event, 'clipboardData', { configurable: false, writable: false, value: original })
    for (const handler of [...handlers]) handler(event)
    return { event, original }
  }
  return { paste, runtime, editor, handlers, context, window }
}

test('rich text forwards only normalized plain text on the original uncanceled event', () => {
  const h = harness(), { event, original } = h.paste('first\r\nsecond\rthird')
  assert.equal(event.clipboardData.getData('text/plain'), 'first\nsecond\nthird')
  assert.equal(event.clipboardData.getData('text/html'), '')
  assert.equal(original.getData('text/html'), '<b>fixture</b>')
  assert.deepEqual(event.clipboardData.types, ['text/plain'])
  assert.equal(event.defaultPrevented, false)
  assert.equal(h.runtime.status().handled, 1)
})

test('plain text, empty content and oversized content keep the native paste payload', () => {
  const h = harness()
  for (const [text, formats] of [['plain', {}], ['', { 'text/html': '<p></p>' }], ['x'.repeat(20001), { 'text/html': '<b>x</b>' }]]) {
    const { event, original } = h.paste(text, formats)
    assert.equal(event.clipboardData, original)
  }
  assert.equal(h.runtime.status().handled, 0)
  assert.notEqual(h.paste('x'.repeat(20000)).event.clipboardData.getData('text/html'), '<b>fixture</b>')
})

test('native internal rich-text references retain their complete clipboard identity', () => {
  const h = harness()
  const { event, original } = h.paste('native page', { 'text/html': '<p>native page</p>', 'application/x-openai-rich-text': '{"reference":{"uri":"page://fixture"}}' })
  assert.equal(event.clipboardData, original)
  assert.equal(h.runtime.status().handled, 0)
})

test('RTF-only rich text is forwarded with spaces, tabs, and newlines intact', () => {
  const h = harness(), { event } = h.paste(' a\tb\r\n\r\nc ', { 'text/rtf': '{\\rtf1 fixture}' })
  assert.equal(event.clipboardData.getData('text/plain'), ' a\tb\n\nc ')
  assert.deepEqual(event.clipboardData.types, ['text/plain'])
})

test('images, files and unidentified file items keep their native payload', () => {
  const h = harness()
  for (const type of ['image/png', 'application/pdf']) {
    const data = { getData: key => key === 'text/plain' ? 'a' : key === 'text/html' ? '<b>a</b>' : '', files: [{ type }], items: [] }
    assert.equal(h.paste('a', {}, { clipboardData: data }).event.clipboardData, data)
  }
  const data = { getData: key => key === 'text/plain' ? 'a' : key === 'text/html' ? '<b>a</b>' : '', files: [], items: [{ kind: 'file', getAsFile: () => null }] }
  assert.equal(h.paste('a', {}, { clipboardData: data }).event.clipboardData, data)
})

test('non-composer, disabled and unrecognized native editors are untouched', () => {
  for (const options of [{ scope: false }, { disabled: true }]) { const { event, original } = harness(options).paste('a'); assert.equal(event.clipboardData, original) }
  for (const mutate of [editor => { delete editor.pmViewDesc }, editor => { editor.pmViewDesc.dom = {} }, editor => { editor.pmViewDesc.node.type.name = 'paragraph' }]) {
    const h = harness(); mutate(h.editor)
    const { event, original } = h.paste('a'); assert.equal(event.clipboardData, original)
  }
})

test('previously handled and noncancelable events are untouched', () => {
  const h = harness()
  for (const extra of [{ defaultPrevented: true }, { cancelable: false }]) { const { event, original } = h.paste('a', undefined, extra); assert.equal(event.clipboardData, original) }
  assert.equal(h.runtime.status().handled, 0)
})

test('an unavailable event override or DataTransfer constructor preserves the original payload', () => {
  const frozen = harness({ frozen: true }), missing = harness()
  delete missing.window.DataTransfer
  for (const h of [frozen, missing]) {
    const { event, original } = h.paste('a')
    assert.equal(event.clipboardData, original)
    assert.equal(event.defaultPrevented, false)
    assert.equal(h.runtime.status().fallbacks, 1)
  }
})

test('reinstallation is idempotent and disposal removes the capture listener', () => {
  const h = harness()
  assert.equal(vm.runInContext(source + '\ninstallCodexPasteRuntime()', h.context), h.runtime)
  assert.equal(h.handlers.size, 1)
  h.runtime.dispose()
  assert.equal(h.handlers.size, 0)
  const { event, original } = h.paste('a'); assert.equal(event.clipboardData, original)
  assert.equal(h.runtime.status().installed, false)
  assert.notEqual(vm.runInContext('installCodexPasteRuntime()', h.context), h.runtime)
  assert.equal(h.handlers.size, 1)
})

test('status records no clipboard content or exception details', () => {
  const h = harness(); h.paste('private clipboard secret')
  assert.equal(JSON.stringify(h.runtime.status()).includes('private'), false)
})

const packagePath = process.env.CODEX_NATIVE_APP_ASAR
test('registered Codex ProseMirror preserves selection, paragraphs, marks and undo in an isolated browser',
  { skip: !packagePath ? 'Set CODEX_NATIVE_APP_ASAR to validate the registered native installation' : false, timeout: 120000 }, async t => {
    const { nativePasteFixture } = require('./codex-paste-native-fixture.cjs')
    const { chromium } = require('playwright')
    const crypto = require('node:crypto')
    const sha256 = async () => { const hash=crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(packagePath)) hash.update(chunk); return hash.digest('hex') }
    const beforeHash = await sha256()
    const fixture = nativePasteFixture(packagePath)
    let browser
    try { browser = await chromium.launch({ headless: true }) }
    catch (error) { if (!String(error).includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ channel: 'chrome', headless: true }) }
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.setContent('<html><body></body></html>')
      await page.addScriptTag({ content: fixture.script })
      await page.addScriptTag({ content: source + '\nwindow.__pasteRuntime = installCodexPasteRuntime();' })
      await t.test('formatted Word text replaces selection as unmarked paragraphs and remains undoable', async () => {
        const result = await page.evaluate(() => {
          const f = window.__nativePasteFixture
          f.create('Before OLD after', 8, 11)
          const prevented = f.paste('first\r\n\r\nsecond', '<p><strong>first</strong></p><p></p><p>second</p>')
          const pasted = f.result(), undo = f.undo(), restored = f.result()
          return { prevented, pasted, undo, restored, status: window.__pasteRuntime.status() }
        })
        assert.equal(result.prevented, true)
        assert.equal(result.pasted.text, 'Before first\n\nsecond after')
        assert.equal(JSON.stringify(result.pasted.json).includes('"marks"'), false)
        assert.equal(result.undo, true)
        assert.equal(result.restored.text, 'Before OLD after')
        assert.equal(result.restored.from, 8)
        assert.equal(result.restored.to, 11)
        assert.equal(result.status.handled, 1)
      })
      await t.test('RTF text, whitespace, tabs and code-block newlines survive the native transaction', async () => {
        const result = await page.evaluate(() => {
          const f = window.__nativePasteFixture
          f.create('old', 1, 4, true)
          f.paste('  alpha\tvalue\r\nbeta  ', '', [], '{\\rtf1 fixture}')
          return f.result()
        })
        assert.equal(result.text, '  alpha\tvalue\nbeta  ')
        assert.equal(result.json.content[0].type, 'code_block')
      })
      await t.test('Word preview-only bitmaps are handled but embedded images, real files and screenshots stay native', async () => {
        const result = await page.evaluate(() => {
          const f = window.__nativePasteFixture
          const remove = f.passCounter(), records = []
          for (const variant of [
            { html: '<meta name="Generator" content="Microsoft Word 16"><p>Hello world</p>', files: [{ name: 'image.png', type: 'image/png' }] },
            { html: '<meta name="Generator" content="Microsoft Word 16"><p>Hello world<img src="embedded.png"></p>', files: [{ name: 'image.png', type: 'image/png' }] },
            { html: '<meta name="Generator" content="Microsoft Word 16"><p>Hello world</p>', files: [{ name: 'report.pdf', type: 'application/pdf' }] },
            { html: '<img src="image.png">', text: '', files: [{ name: 'image.png', type: 'image/png' }] },
          ]) {
            f.create()
            window.__nativePasteView.setProps({ handlePaste: (_view, event) => event.clipboardData.files.length > 0 })
            const before = window.__pasteRuntime.status().handled
            f.paste(variant.text ?? 'Hello world', variant.html, variant.files)
            records.push({ handled: window.__pasteRuntime.status().handled - before, text: f.result().text })
          }
          remove(); return { records, nativePasses: window.__nativePasses }
        })
        assert.deepEqual(result.records.map(record => record.handled), [1, 0, 0, 0])
        assert.equal(result.records[0].text, 'Hello world')
        assert.equal(result.nativePasses, 4)
      })
      await t.test('long rich text and ordinary plain text keep native attachment and paste handlers', async () => {
        const result = await page.evaluate(() => {
          const f = window.__nativePasteFixture
          f.create(); let native = 0
          window.__nativePasteView.setProps({ handlePaste: () => { native++; return true } })
          const before = window.__pasteRuntime.status().handled
          f.paste('x'.repeat(20001), '<p>long</p>')
          f.paste('plain text')
          return { native, handled: window.__pasteRuntime.status().handled - before }
        })
        assert.deepEqual(result, { native: 2, handled: 0 })
      })
      assert.deepEqual(errors, [])
      assert.equal(await sha256(), beforeHash, 'Read-only native validation leaves app.asar unchanged')
      t.diagnostic(JSON.stringify({ nativeExecuted: true, asar: path.resolve(packagePath), sha256: beforeHash, modules: fixture.modules, anchors: fixture.anchors }))
    } finally { await browser.close() }
  })
