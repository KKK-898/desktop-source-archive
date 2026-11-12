import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { compile } from '@vue/compiler-dom'
import { build } from 'vite'
import { chromium } from 'playwright'

// Real production theme markup, CSS and handlers; mocked desktop replies only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceText = await readFile(path.join(root, 'src/components/新版主题.vue'), 'utf8')
const script = sourceText.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('theme-browser.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = [
  'isCodexThemeDialogOpen', 'codexThemeDialogTab', 'selectedCodexThemeId', 'isCodexThemeCatalogLoading',
  'codexThemeCatalogError', 'codexThemeActiveName', 'codexThemeRuntime', 'codexThemeCatalogGeneration',
  'codexThemeCatalog', 'codexThemeCarouselStart', 'codexThemeActionId', 'codexThemeActionType',
  'codexThemeDownloadProgress', 'activeCodexTheme', 'isCodexThemeCarouselMoving', 'codexThemeCarouselMoveTimer',
  'codexThemeCarouselSlots', 'formatCodexThemeBytes', 'normalizeCodexThemeItem', 'loadCodexThemeCatalog',
  'codexThemeRuntimeIsApplied', 'codexThemeSelectionStatus', 'codexThemePrimaryActionDisabled',
  'applyCodexThemeActionFeedback', 'invalidateCodexThemeCatalogReads', 'codexThemePrimaryActionText',
  'previewCodexThemeDownload', 'restoreNativeCodexTheme', 'codexThemePreviewStyle', 'rotateCodexThemeCarousel',
  'selectCodexThemeSlot', 'closeCodexThemeDialog',
]
const declarations = source.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.getText(source))),
)
assert.equal(declarations.length, names.length)
const compiled = ts.transpileModule(declarations.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const start = sourceText.lastIndexOf('<div', sourceText.indexOf('v-if="isCodexThemeDialogOpen"'))
const end = sourceText.indexOf('<div v-else class="new-theme-codex-theme-tutorial">', start)
assert.ok(start > 0 && end > start)
const template = sourceText.slice(start, end) + '</section></div>'
const render = compile(template, { mode: 'module', prefixIdentifiers: true }).code
const css = [...sourceText.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n')
let artifacts, server, browser, baseUrl
const pageErrors = []

before(async () => {
  artifacts = await mkdtemp(path.join(os.tmpdir(), 'gaoge-theme-ui-'))
  const entry = `import {createApp,computed,ref} from 'vue';
import * as icons from 'lucide-vue-next';
${render}
const calls=[],notices=[];
const seed=window.__themeSeed;
const theme=(index)=>({id:'theme-'+index,name:index===0?'紫藤午夜':'主题 '+index,author:'Gaoge Studio',sourceLabel:'主题',style:'沉浸深色',description:'主题预览',version:'1.0.0',installed:true,active:index===0,applied:false,pending:index===0,updateAvailable:index===0&&seed.update,enabled:true,sizeBytes:100,platforms:['windows'],accent:'#8b5cf6'});
let current={themes:Array.from({length:seed.count},(_,index)=>theme(index)),runtime:{selectedThemeId:'theme-0',appliedThemeId:'',runtimeReady:false,needsRestart:true,status:'pending'}};
const clone=value=>JSON.parse(JSON.stringify(value));
window.gaogeDesktop={listCodexThemes:async()=>{calls.push('list');return clone(current)},installCodexTheme:async id=>{calls.push('install:'+id);current.themes=current.themes.map(item=>item.id===id?{...item,version:'1.1.0',updateAvailable:false,applied:true,pending:false}:item);current.runtime={selectedThemeId:id,appliedThemeId:id,runtimeReady:true,needsRestart:false,status:'applied'};return {installed:true,themeId:id,status:clone(current),runtime:clone(current.runtime)}},activateCodexTheme:async id=>{calls.push('activate:'+id);current.themes=current.themes.map(item=>({...item,active:item.id===id,pending:item.id===id}));current.runtime={selectedThemeId:id,appliedThemeId:'',runtimeReady:false,needsRestart:true};return {runtime:clone(current.runtime)}},deactivateCodexTheme:async()=>{calls.push('deactivate');current.themes=current.themes.map(item=>({...item,active:false,pending:false}));current.runtime={selectedThemeId:'',appliedThemeId:'',runtimeReady:false,needsRestart:true};return {runtime:clone(current.runtime)}}};
const codexThemeFallbackCatalog=[];const buildCodexThemeFallbackCatalog=()=>[];const mergeCodexThemeFallbackCatalog=items=>items;const getCodexThemeCatalogError=error=>String(error?.message||error);const getErrorMessage=getCodexThemeCatalogError;const reportPageError=(...args)=>calls.push(args);const notify=(...args)=>notices.push(args);const previewCodexThemeImport=()=>{};const colorMode=ref(seed.dark?'dark':'light');
${compiled}
isCodexThemeDialogOpen.value=true;
const app=createApp({components:icons,render,setup(){return {${names.join(',')},previewCodexThemeImport,colorMode}}});app.mount('#app');window.__themeBrowser={calls,notices,ready:loadCodexThemeCatalog()};`
  await build({ root, configFile: false, logLevel: 'error', plugins: [{ name: 'isolated-theme-browser', resolveId(id) { if(id === 'virtual:theme-browser') return '\0theme-browser' }, load(id) { if(id === '\0theme-browser') return entry } }], build: { outDir: artifacts, emptyOutDir: false, rollupOptions: { input: 'virtual:theme-browser', output: { entryFileNames: 'theme-browser.js' } } } })
  server = createServer(async (req,res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if(url.pathname === '/') {res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><html><head><meta charset="UTF-8"><style>body{margin:0;font-family:Arial,sans-serif}*{box-sizing:border-box}'+css+'</style></head><body><div id="app"></div><script type="module" src="/theme-browser.js"></script></body></html>');return}
      const file=path.resolve(artifacts,'.'+url.pathname);if(!file.startsWith(artifacts+path.sep)){res.statusCode=403;res.end();return}
      res.setHeader('Content-Type','text/javascript');res.end(await readFile(file))
    } catch {res.statusCode=404;res.end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));baseUrl='http://127.0.0.1:'+server.address().port
  try {browser=await chromium.launch({headless:true})} catch(error){if(!String(error).includes("Executable doesn't exist"))throw error;browser=await chromium.launch({headless:true,channel:'chrome'})}
},{timeout:60000})
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))};console.log('Theme UI screenshots: '+artifacts);assert.deepEqual(pageErrors,[])})
async function pageFor(seed={}){
 const page=await browser.newPage({viewport:{width:seed.width||1280,height:seed.height||900}});page.on('pageerror',error=>pageErrors.push(error.message));
 await page.addInitScript(seed=>{window.__themeSeed=seed},{count:10,update:true,dark:false,...seed});await page.goto(baseUrl);await page.evaluate(()=>window.__themeBrowser.ready);return page
}

test('an active theme update is actionable in the real carousel and becomes applied',async()=>{
 const page=await pageFor();await page.getByRole('button',{name:'更新',exact:true}).click();await page.getByRole('button',{name:'已应用',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__themeBrowser.calls),['list','install:theme-0']);
 await page.screenshot({path:path.join(artifacts,'desktop-light.png')});await page.close()
})

test('a one-theme library retains its center action and a read-only update check',async()=>{
 const page=await pageFor({count:1});assert.equal(await page.locator('.new-theme-codex-theme-card.is-center').count(),1);
 assert.equal(await page.getByRole('button',{name:'更新',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'检查更新',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__themeBrowser.calls),['list','list']);await page.close()
})

test('a narrow dark theme dialog keeps its actions inside the viewport',async()=>{
 const page=await pageFor({count:2,width:390,height:844,dark:true});
 const sizes=await page.evaluate(()=>({width:window.innerWidth,scroll:document.documentElement.scrollWidth,headDisplay:getComputedStyle(document.querySelector('.new-theme-codex-theme-head')).display,toolbarBottom:document.querySelector('.new-theme-codex-theme-toolbar').getBoundingClientRect().bottom,galleryTop:document.querySelector('.new-theme-codex-theme-gallery-head').getBoundingClientRect().top,titleWidth:document.querySelector('.new-theme-codex-theme-head h2').getBoundingClientRect().width,buttons:[...document.querySelectorAll('.new-theme-codex-theme-toolbar-actions button')].map(button=>{const rect=button.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width}})}));
 assert.ok(sizes.scroll<=sizes.width,'No horizontal overflow');assert.equal(sizes.headDisplay,'grid');assert.ok(sizes.galleryTop>=sizes.toolbarBottom,'Toolbar must not overlap the gallery');assert.ok(sizes.titleWidth>200,'Theme title must retain room');for(const button of sizes.buttons){assert.ok(button.left>=0&&button.right<=sizes.width&&button.width>30,JSON.stringify(button))}
 await page.screenshot({path:path.join(artifacts,'mobile-dark.png')});await page.close()
})
