const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { themeRuntimeSource, nativeThemeAnchors, nativeFixture } = require('./codex-theme-native-fixture.cjs');
let browser, wallpaper;
const runtimeSource = themeRuntimeSource();
const rustThemeStatusSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_theme_status.rs'), 'utf8');
const expectedRuntimeVersion = Number(rustThemeStatusSource.match(/pub const RUNTIME_VERSION: u64 = (\d+);/)?.[1]);
before(async () => {
  const bundled = chromium.executablePath();
  const candidates = process.platform === 'win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe']
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const executablePath = process.env.CODEX_THEME_TEST_BROWSER || [bundled, ...candidates].find(value => fs.existsSync(value));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const image = await sharp({ create: { width: 40, height: 24, channels: 3, background: '#385a82' } }).webp().toBuffer();
  wallpaper = 'data:image/webp;base64,' + image.toString('base64');
});
after(async () => { await browser?.close(); });
function payload(overrides = {}) {
  return { id: 'fixture-theme', version: '1.0.0', signature: 'fixture-content-one', runtime: 'wallpaper', appearance: 'dark',
    backgroundDataUrl: wallpaper, background: { positionX: 50, positionY: 50, overlayOpacity: 0.2 },
    colors: { surface: '#142236', text: '#f8fafc', muted: '#b6c5d8', border: '#52627a', accent: '#67cfe8', secondary: '#8b84e6' },
    effects: { panelOpacity: 0.84, panelBlur: 8, radius: 8 }, ...overrides };
}
async function fixture(t, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setContent(nativeFixture);
  await page.evaluate('(() => {\n' + runtimeSource + '\n})()');
  return { page, errors, apply: theme => page.evaluate(value => window.__gaogeCodexThemeController.apply(value), theme),
    status: () => page.evaluate(() => window.__gaogeCodexThemeController.status()) };
}
const geometrySelectors = ['[data-app-navigation-rail]', 'aside', '[data-app-shell-main-surface]', '.thread-footer',
  '[data-app-shell-main-surface] [data-composer-layout]', '#scroll', '#portal', '[data-sonner-toaster]', '[data-image-preview-composer]'];
async function geometry(page) {
  return page.evaluate(selectors => selectors.map(selector => {
    const element = document.querySelector(selector), r = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { selector, x: r.x, y: r.y, width: r.width, height: r.height, position: style.position,
      display: style.display, transform: style.transform, zIndex: style.zIndex, pointerEvents: style.pointerEvents };
  }), geometrySelectors);
}
async function paints(page) {
  return page.evaluate(() => {
    const css = selector => { const s = getComputedStyle(document.querySelector(selector)); return { color: s.backgroundColor, image: s.backgroundImage, radius: s.borderRadius }; };
    return { body: css('body'), frame: css('[data-app-shell-frame]'), rail: css('[data-app-navigation-rail]'),
      sidebar: css('aside'), footer: css('.thread-footer'), surface: css('.surface-nr8PSS'), fade: css('.fade-AcMqqj'),
      composer: css('[data-composer-layout]'), tooltip: css('.Tooltip-FE0nMY'), toast: css('[role=alert]'), scroll: css('#scroll') };
  });
}
const fullPageSurfaceSelectors = ['html', 'body', '#root', '[data-app-shell-frame]',
  'main[data-app-shell-main-surface]', '.thread-scroll-container', '.thread-footer',
  '.background-uNUrfY.surface-nr8PSS', '.background-uNUrfY.fade-AcMqqj'];
async function filterEffects(page, selectors) {
  return page.evaluate(values => values.map(selector => {
    const style = getComputedStyle(document.querySelector(selector));
    return { selector, filter: style.filter, backdrop: style.backdropFilter,
      webkitBackdrop: style.getPropertyValue('-webkit-backdrop-filter') || 'none' };
  }), selectors);
}
async function assertClearPageSurfaces(page) {
  for (const effect of await filterEffects(page, fullPageSurfaceSelectors)) {
    assert.equal(effect.filter, 'none', effect.selector + ' must not filter the wallpaper or all page content');
    assert.equal(effect.backdrop, 'none', effect.selector + ' must not blur the wallpaper across the page');
    assert.equal(effect.webkitBackdrop, 'none', effect.selector + ' must not apply a prefixed full-page blur');
  }
}
test('JavaScript controller, applied runtime and restore status use the Rust runtime version', async t => {
  assert.ok(Number.isInteger(expectedRuntimeVersion) && expectedRuntimeVersion > 0, 'Rust runtime version is available');
  assert.equal(Number(runtimeSource.match(/const runtimeVersion = (\d+);/)?.[1]), expectedRuntimeVersion);
  const f = await fixture(t);
  assert.equal(await f.page.evaluate(() => __gaogeCodexThemeController.version), expectedRuntimeVersion);
  assert.equal((await f.status()).version, expectedRuntimeVersion);
  assert.equal((await f.apply(payload())).version, expectedRuntimeVersion);
  assert.equal(await f.page.evaluate(() => __gaogeCodexThemeRuntime.version), expectedRuntimeVersion);
  assert.equal((await f.apply(null)).version, expectedRuntimeVersion);
});
for (const width of [1440, 390]) {
  test(`wallpaper stays sharp on full-page shell state flags at ${width}px while local panels keep their blur`, async t => {
    const f = await fixture(t, { width, height: 900 });
    await f.page.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.id = 'local-dialog'; dialog.setAttribute('role', 'dialog');
      dialog.textContent = 'Local dialog surface';
      document.querySelector('#portal').appendChild(dialog);
    });
    const localSelectors = ['[data-app-shell-main-surface] [data-composer-layout]', '#local-dialog', '.Tooltip-FE0nMY'];
    const before = await filterEffects(f.page, [...fullPageSurfaceSelectors, ...localSelectors]);
    assert.deepEqual(await f.page.locator('[data-app-shell-frame]').evaluate(e => ({
      frame: e.getAttribute('data-app-shell-frame'), page: e.getAttribute('data-app-shell-page-surface'),
      sidebar: e.getAttribute('data-app-shell-page-sidebar'), width: e.getBoundingClientRect().width,
      height: e.getBoundingClientRect().height,
    })), { frame: 'true', page: 'true', sidebar: 'true', width, height: 900 });
    for (const panelBlur of [14, 0, 24]) {
      const result = await f.apply(payload({ signature: 'fixture-blur-' + panelBlur,
        effects: { panelOpacity: 0.84, panelBlur, radius: 8 } }));
      assert.equal(result.ready, true);
      await assertClearPageSurfaces(f.page);
      for (const effect of await filterEffects(f.page, localSelectors)) {
        assert.equal(effect.filter, 'none', effect.selector + ' must keep its own text and controls sharp');
        assert.ok(effect.backdrop.includes('blur(' + panelBlur + 'px)'), effect.selector + ' follows panelBlur');
      }
    }
    assert.equal((await f.apply(null)).ready, true);
    assert.deepEqual(await filterEffects(f.page, [...fullPageSurfaceSelectors, ...localSelectors]), before);
    assert.equal(await f.page.locator('#gaoge-codex-theme-style').count(), 0);
    assert.deepEqual(f.errors, []);
  });
}
for (const width of [1440, 390]) {
  test(`wallpaper paints native two-sidebar and footer surfaces at ${width}px without changing geometry or events`, async t => {
    const f = await fixture(t, { width, height: 900 });
    const beforeGeometry = await geometry(f.page);
    const result = await f.apply(payload());
    assert.equal(result.ready, true); assert.equal(result.version, expectedRuntimeVersion); assert.equal(result.themeVersion, '1.0.0');
    assert.deepEqual(await geometry(f.page), beforeGeometry);
    const colors = await paints(f.page);
    assert.match(colors.body.image, /blob:/);
    for (const name of ['frame', 'footer', 'surface', 'fade']) assert.equal(colors[name].color, 'rgba(0, 0, 0, 0)', name);
    assert.equal(colors.fade.image, 'none');
    for (const name of ['rail', 'sidebar', 'composer', 'tooltip', 'toast', 'scroll']) assert.match(colors[name].color, /^rgba\(20, 34, 54, 0\./, name);
    assert.equal(colors.scroll.radius, '50%');
    assert.equal(colors.composer.radius, '24px');
    await f.page.locator('#scroll').click(); await f.page.locator('#native-home').click();
    await f.page.locator('textarea').fill('Native input stays usable'); await f.page.locator('#send').click();
    assert.deepEqual(await f.page.evaluate(() => [scrollClicks, nativeHomeClicks, sendClicks]), [1, 1, 1]);
    assert.equal(await f.page.locator('textarea').inputValue(), 'Native input stays usable');
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(f.errors, []);
  });
}
test('active signature is idempotent and updated same-id content replaces the owned blob once', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => { window.revoked = []; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = value => { revoked.push(value); revoke(value); }; });
  await f.apply(payload());
  const before = await f.page.evaluate(() => ({ blob: __gaogeCodexThemeRuntime.blobUrl, style: document.querySelector('#gaoge-codex-theme-style').textContent }));
  await f.apply(payload());
  assert.equal(await f.page.evaluate(() => __gaogeCodexThemeRuntime.blobUrl), before.blob);
  assert.deepEqual(await f.page.evaluate(() => revoked), []);
  const result = await f.apply(payload({ version: '1.0.1', signature: 'fixture-content-two' }));
  assert.equal(result.ready, true); assert.equal(result.themeVersion, '1.0.1'); assert.equal(result.signature, 'fixture-content-two');
  assert.deepEqual(await f.page.evaluate(() => revoked), [before.blob]);
  assert.equal(await f.page.locator('#gaoge-codex-theme-style').count(), 1);
});
test('a ready older runtime upgrades the same theme without keeping its full-page blur', async t => {
  const f = await fixture(t);
  const before = await paints(f.page);
  await f.apply(payload());
  const olderVersion = expectedRuntimeVersion - 1;
  await f.page.evaluate(version => {
    const runtime = window.__gaogeCodexThemeRuntime;
    const status = runtime.status();
    window.olderThemeRuntime = runtime;
    window.olderThemeBlob = runtime.blobUrl;
    runtime.version = version;
    // A previously loaded controller considers its own old stylesheet valid.
    runtime.status = () => ({ ...status, version });
    window.__gaogeCodexThemeController.version = version;
    document.querySelector('#gaoge-codex-theme-style').textContent =
      ':root[data-gaoge-codex-theme="fixture-theme"][data-gaoge-codex-theme-runtime="wallpaper"] [data-app-shell-frame] {' +
      'backdrop-filter:blur(14px)!important;-webkit-backdrop-filter:blur(14px)!important;}';
    window.upgradeRevoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = value => { upgradeRevoked.push(value); revoke(value); };
  }, olderVersion);
  assert.equal((await f.status()).version, olderVersion);
  assert.equal((await f.status()).ready, true);
  assert.equal((await filterEffects(f.page, ['[data-app-shell-frame]']))[0].backdrop, 'blur(14px)');
  await f.page.evaluate('(() => {\n' + runtimeSource + '\n})()');
  const result = await f.apply(payload());
  assert.equal(result.version, expectedRuntimeVersion); assert.equal(result.ready, true);
  assert.equal(result.themeVersion, '1.0.0'); assert.equal(result.signature, 'fixture-content-one');
  assert.deepEqual(await f.page.evaluate(() => ({
    controller: __gaogeCodexThemeController.version, runtime: __gaogeCodexThemeRuntime.version,
    status: __gaogeCodexThemeController.status().version,
    replaced: __gaogeCodexThemeRuntime !== olderThemeRuntime,
    newBlob: __gaogeCodexThemeRuntime.blobUrl !== olderThemeBlob,
    released: upgradeRevoked.length === 1 && upgradeRevoked[0] === olderThemeBlob,
  })), { controller: expectedRuntimeVersion, runtime: expectedRuntimeVersion, status: expectedRuntimeVersion,
    replaced: true, newBlob: true, released: true });
  await assertClearPageSurfaces(f.page);
  assert.equal(await f.page.locator('#gaoge-codex-theme-style').count(), 1);
  await f.apply(payload());
  assert.equal(await f.page.evaluate(() => upgradeRevoked.length), 1);
  await f.apply(null);
  assert.deepEqual(await paints(f.page), before);
  await assertClearPageSurfaces(f.page);
  assert.deepEqual(f.errors, []);
});
test('restore removes theme surfaces and observers and restores the original native appearance', async t => {
  const f = await fixture(t); const before = await paints(f.page);
  await f.apply(payload());
  const result = await f.apply(null);
  assert.deepEqual(result, { version: expectedRuntimeVersion, enabled: false, applied: true, ready: true, id: '', themeVersion: '', signature: '', error: '' });
  assert.deepEqual(await paints(f.page), before);
  assert.deepEqual(await f.page.evaluate(() => ({ css: document.documentElement.style.getPropertyValue('--color-native-test'),
    mode: document.documentElement.style.colorScheme, light: document.documentElement.classList.contains('electron-light'),
    active: document.documentElement.hasAttribute('data-gaoge-codex-theme') })), { css: '#123456', mode: 'light', light: true, active: false });
  assert.equal((await f.apply(payload({ appearance: 'light' }))).ready, true);
});
test('late native tooltip and Sonner alert inherit local surfaces without changing portal stacking', async t => {
  const f = await fixture(t); await f.apply(payload());
  await f.page.evaluate(() => {
    document.querySelector('#portal').innerHTML = '<div id="late-tooltip" class="Tooltip-FE0nMY" data-side="bottom">Later tooltip</div>';
    document.querySelector('[data-sonner-toast]').innerHTML = '<div role="alert" class="alert-ZnLiYv">Later toast</div>';
  });
  const value = await f.page.evaluate(() => { const e = document.querySelector('#late-tooltip'), r = e.getBoundingClientRect(); return {
    top: document.elementFromPoint(r.x + 5, r.y + 5) === e, z: getComputedStyle(e.parentElement).zIndex,
    position: getComputedStyle(e.parentElement).position, color: getComputedStyle(e).backgroundColor,
    toast: getComputedStyle(document.querySelector('[role=alert]')).backgroundColor }; });
  assert.equal(value.top, true); assert.equal(value.z, '100'); assert.equal(value.position, 'fixed');
  assert.match(value.color, /^rgba\(20, 34, 54, 0\./); assert.match(value.toast, /^rgba\(20, 34, 54, 0\./);
});
test('status detects removed styles and apply repairs them instead of returning stale success', async t => {
  const f = await fixture(t); await f.apply(payload());
  await f.page.locator('#gaoge-codex-theme-style').evaluate(e => e.remove());
  assert.equal((await f.status()).ready, false);
  assert.equal((await f.apply(payload())).ready, true);
});
test('unknown native layout and undecodable background are not reported as applied', async t => {
  const f = await fixture(t);
  await f.page.locator('[data-app-shell-main-surface]').evaluate(e => e.removeAttribute('data-app-shell-main-surface'));
  let result = await f.apply(payload()); assert.equal(result.applied, false); assert.equal(result.reason, 'native-theme-surface-unavailable'); assert.equal(result.error, '');
  await f.page.locator('main').evaluate(e => e.setAttribute('data-app-shell-main-surface', 'default'));
  result = await f.apply(payload({ signature: 'bad-image', backgroundDataUrl: 'data:image/webp;base64,YmFk' }));
  assert.equal(result.applied, false); assert.equal(result.error, 'theme-image-load-failed');
});
test('a pending image completion cannot reenable a theme after restoring native appearance', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => { window.imageFinish = null; window.Image = class { set src(value) { imageFinish = () => this.onload?.(); } }; });
  await f.page.evaluate(theme => { window.pendingTheme = window.__gaogeCodexThemeController.apply(theme); }, payload());
  await f.page.waitForFunction(() => typeof imageFinish === 'function');
  assert.equal((await f.apply(null)).enabled, false);
  const result = await f.page.evaluate(async () => { imageFinish(); return pendingTheme; });
  assert.equal(result.applied, false);
  assert.equal((await f.status()).enabled, false);
  assert.equal(await f.page.locator('#gaoge-codex-theme-style').count(), 0);
});
test('installed native bundle contains the reviewed semantic surface contracts', { skip: !process.env.CODEX_NATIVE_APP_ASAR }, () => {
  const anchors = nativeThemeAnchors(process.env.CODEX_NATIVE_APP_ASAR);
  assert.equal(Object.keys(anchors).length, 15);
});
test('QQ cleanup releases its own decorations when switching back to wallpaper', async t => {
  const f = await fixture(t);
  await f.page.evaluate(image => {
    window.__GAOGE_QQ2007_CSS__ = ':root.codex-dream-skin { --qq-fixture: 1; }';
    window.__GAOGE_QQ2007_UPSTREAM_COMMIT__ = 'fixture';
    window.__GAOGE_QQ2007_ASSETS__ = { iconSprite: image, assistant: image, qqShow: image };
  }, wallpaper);
  const qq = await f.apply(payload({ id: 'qq-retro', runtime: 'qq-retro', signature: 'fixture-qq' }));
  assert.equal(qq.ready, true);
  assert.equal(await f.page.locator('#codex-dream-skin-chrome').count(), 1);
  assert.equal((await f.apply(payload())).ready, true);
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await f.page.locator('#codex-dream-skin-chrome, #gaoge-codex-qq2007-upstream-style, [data-qq2007-styled], [data-ds2007-native-dock]').count(), 0);
  assert.deepEqual(await f.page.evaluate(() => ({ dream: document.documentElement.hasAttribute('data-dream-shell'),
    sprite: document.documentElement.style.getPropertyValue('--ds2007-icon-sprite'), root: !!document.querySelector('.ds2007-app-root') })),
    { dream: false, sprite: '', root: false });
  assert.deepEqual(f.errors, []);
});