// Semantic attributes/classes verified read-only against Codex 26.1103.
const fs = require('node:fs');
const path = require('node:path');
function themeRuntimeSource() {
  const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
  const start = source.indexOf('  async function installThemeRuntime(theme) {');
  const end = source.indexOf('\n  function installAggregateModelPickerRuntime', start);
  if (start < 0 || end < start) throw Error('Theme runtime boundary missing');
  return source.slice(start, end);
}
function nativeThemeAnchors(packagePath) {
  const asar = require('@electron/asar');
  const tokens = ['data-app-navigation-rail', 'data-app-shell-left-panel-appearance',
    'data-sidebar-navigation-root', 'data-composer-layout', 'data-composer-surface-variant',
    'data-thread-footer-background', 'background-uNUrfY', 'surface-nr8PSS', 'fade-AcMqqj',
    'combined-vZM0uN', 'group/scroll-to-bottom', 'Tooltip-FE0nMY', 'data-sonner-toast',
    'alert-ZnLiYv', 'data-image-preview-composer'];
  const found = new Map();
  for (const file of asar.listPackage(packagePath).map(p => p.replace(/^[\\/]/, ''))) {
    if (!/webview[\\/]assets[\\/].*\.(js|css)$/.test(file)) continue;
    const text = asar.extractFile(packagePath, file).toString('utf8');
    for (const token of tokens) if (!found.has(token) && text.includes(token)) found.set(token, file);
    if (found.size === tokens.length) break;
  }
  for (const token of tokens) if (!found.has(token)) throw Error('Native theme contract changed: ' + token);
  return Object.fromEntries(found);
}
const nativeFixture =
'<!doctype html><html class="electron-light" data-codex-os="win32" data-codex-window-type="electron" style="--color-native-test:#123456;color-scheme:light"><head><style>' +
'*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font:14px Arial}button{font:inherit}#root{height:100%}' +
'[data-app-shell-frame]{display:flex;height:100%;background:#202024}' +
'[data-app-navigation-rail]{width:78px;flex:none;position:relative;background:#101010}' +
'aside[data-app-shell-left-panel-appearance]{width:260px;flex:none;background:#181818;position:relative}' +
'.sidebar-navigation{background:#181818;height:100%;padding:16px}' +
'main[data-app-shell-main-surface]{position:static;display:flex;flex-direction:column;flex:1;min-width:0;background:#202020}' +
'.thread-scroll-container{position:relative;flex:1;min-height:0;overflow:auto}' +
'.thread-content{height:1000px;padding:32px}.thread-footer{position:absolute;bottom:0;left:0;right:0;height:150px;padding:20px;background:#181818}' +
'.background-uNUrfY{pointer-events:none;position:absolute;z-index:0;inset:0;background:#181818}' +
'.fade-AcMqqj{height:32px;background:linear-gradient(to top,#181818,transparent)}' +
'.ComposerLayoutRoot-XCKS7O{--composer-layout-surface-background:#333;--composer-layout-surface-backdrop-filter:none;position:relative;z-index:1;background-color:var(--composer-layout-surface-background);backdrop-filter:var(--composer-layout-surface-backdrop-filter);width:100%;height:100px;border-radius:24px;padding:15px;}' +
'.ComposerLayoutBody-uBBf1A{height:100%}textarea{width:100%;height:50px;border:0;resize:none}' +
'button[class~="group/scroll-to-bottom"]{position:absolute;z-index:30;bottom:170px;left:50%;transform:translateX(-50%);width:32px;height:32px;border-radius:50%;background:#222;border:1px solid #666;}' +
'#portal{position:fixed;z-index:100;top:45px;right:20px}.Tooltip-FE0nMY{padding:10px;border:1px solid #888;border-radius:7px;background:#111;color:white;position:relative}' +
'[data-sonner-toaster]{position:fixed;z-index:120;right:20px;top:100px;list-style:none;padding:0}[data-sonner-toast]{position:relative;width:230px}.alert-ZnLiYv{padding:12px;background:#111;color:white;}' +
'[data-image-preview-composer]{position:fixed;z-index:90;top:190px;right:20px;width:230px}' +
'@media(max-width:700px){[data-app-navigation-rail]{width:52px}aside[data-app-shell-left-panel-appearance]{display:none}.thread-content{padding:16px}.thread-footer{padding:12px}}' +
'</style></head><body><div id="root"><div data-app-shell-frame="true" data-app-shell-page-surface="true" data-app-shell-page-sidebar="true"><nav data-app-navigation-rail><button id="native-home">Home</button></nav>' +
'<aside data-app-shell-left-panel-appearance="content-surface"><div data-sidebar-navigation-root class="sidebar-navigation">Native sidebar</div></aside>' +
'<main data-app-shell-main-surface="default"><div class="thread-scroll-container" data-thread-footer-background><div class="thread-content">Messages and native scroll area</div>' +
'<div class="thread-footer bg-surface"><div aria-hidden="true" class="background-uNUrfY surface-nr8PSS"></div><div aria-hidden="true" class="background-uNUrfY fade-AcMqqj"></div>' +
'<div data-composer-layout="default" data-composer-surface-variant="default" class="ComposerLayoutRoot-XCKS7O"><div class="ComposerLayoutBody-uBBf1A"><textarea aria-label="Native composer"></textarea><button id="send">Send</button></div></div></div>' +
'<button class="group/scroll-to-bottom" id="scroll" aria-label="Scroll to bottom">↓</button></div></main></div></div>' +
'<div id="portal"><div class="Tooltip-FE0nMY" data-side="bottom">Native tooltip</div></div>' +
'<ol data-sonner-toaster><li data-sonner-toast data-styled="false"><div role="alert" class="alert-ZnLiYv">Native toast</div></li></ol>' +
'<div data-image-preview-composer><div data-composer-layout="default" data-composer-surface-variant="default" class="ComposerLayoutRoot-XCKS7O">Annotation composer</div></div>' +
'<script>window.scrollClicks=0;document.querySelector("#scroll").onclick=()=>window.scrollClicks++;window.nativeHomeClicks=0;document.querySelector("#native-home").onclick=()=>window.nativeHomeClicks++;window.sendClicks=0;document.querySelector("#send").onclick=()=>window.sendClicks++;</script></body></html>';
module.exports = { themeRuntimeSource, nativeThemeAnchors, nativeFixture };
