import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import sharp from 'sharp'
import { chromium } from 'playwright'

// Exercises the real MCP card in a browser with an in-memory two-frame GIF.
// No provider, account, model generation, or external network access is used.
const ui = readFileSync(new URL('../src-tauri/src/gaoge_image_mcp_ui.html', import.meta.url), 'utf8')
const width = 64
const pixels = Buffer.alloc(width * width * 2 * 3)
for (let index = 0; index < width * width; index++) {
  pixels[index * 3] = 255
  pixels[(index + width * width) * 3 + 2] = 255
}
const animation = await sharp(pixels, {
  raw: { width, height: width * 2, channels: 3, pageHeight: width },
}).gif({ delay: [220, 220], loop: 0 }).toBuffer()

function fixture({ fallback = false, unavailable = false } = {}) {
  const image = {
    fileName: 'loop.gif', mimeType: 'image/gif', bytes: animation.length,
    ...(unavailable
      ? { previewUnavailableReason: '文件已保存，超过预览大小限制，请从保存位置打开。' }
      : { resourceUri: 'ui://gaoge-image/generated/synthetic-loop' }),
  }
  const bootstrap = `<script>
    ${fallback ? 'URL.createObjectURL = () => { throw new Error("host blocks blob URLs") };' : ''}
    window.openai = { toolOutput: ${JSON.stringify({ structuredContent: { count: 1, images: [image] } })} };
  </script>`
  const embedded = ui.replace('</head>', `${bootstrap}</head>`)
    .replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  // Use a real parent frame: a top-level page would receive its own RPC request
  // as though it were a host response, unlike the actual MCP app transport.
  return `<script>
    window.addEventListener('message', event => {
      const message = event.data;
      if (!message?.method || message.id === undefined) return;
      let result;
      if (message.method === 'ui/initialize') result = { hostContext: { theme: 'light' } };
      else if (message.method === 'resources/read') result = { contents: [{ mimeType: 'image/gif', blob: '${animation.toString('base64')}' }] };
      else return;
      event.source.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
    });
  </script><iframe style="border:0;width:460px;height:450px" srcdoc="${embedded}"></iframe>`
}

for (const fallback of [false, true]) {
  test(`MCP GIF preview keeps both animation frames with ${fallback ? 'data URL fallback' : 'Blob URL'}`, { timeout: 20_000 }, async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.GAOGE_TEST_BROWSER_CHANNEL || undefined })
    try {
      const page = await browser.newPage({ viewport: { width: 480, height: 480 } })
      await page.route('**/*', route => route.abort())
      await page.setContent(fixture({ fallback }))
      const frame = await (await page.locator('iframe').elementHandle()).contentFrame()
      await frame.waitForFunction(() => {
        const image = document.querySelector('.preview img')
        return image?.complete && image.naturalWidth === 64
      }, undefined, { timeout: 5000 })
      assert.match(await frame.locator('#summary').innerText(), /GIF 动图/)
      assert.match(await frame.locator('.preview img').getAttribute('src'), fallback ? /^data:image\/gif;base64,/ : /^blob:/)
      const box = await frame.locator('.preview img').boundingBox()
      const observed = new Set()
      for (let sample = 0; sample < 10 && observed.size < 2; sample++) {
        const screenshot = await page.screenshot({ clip: {
          x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2), width: 1, height: 1,
        } })
        const rgb = await sharp(screenshot).removeAlpha().raw().toBuffer()
        if (rgb[0] > 200 && rgb[2] < 30) observed.add('red')
        if (rgb[2] > 200 && rgb[0] < 30) observed.add('blue')
        if (observed.size < 2) await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.deepEqual([...observed].sort(), ['blue', 'red'], 'the rendered card must play both frames, not freeze the first frame')
      if (fallback) assert.equal(await frame.locator('.preview img').getAttribute('title'), '已使用兼容预览方式')
    } finally {
      await browser.close()
    }
  })
}

test('saved GIF without an embeddable resource remains a saved result with an actionable reason', { timeout: 15_000 }, async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.GAOGE_TEST_BROWSER_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.abort())
    await page.setContent(fixture({ unavailable: true }))
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame()
    assert.match(await frame.locator('#summary').innerText(), /已生成 1 个 GIF 动图/)
    assert.match(await frame.locator('.preview .error').innerText(), /文件已保存.*预览大小限制/)
    assert.equal(await frame.locator('.caption').innerText(), 'loop.gif')
  } finally {
    await browser.close()
  }
})
