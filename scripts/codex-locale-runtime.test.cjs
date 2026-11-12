'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_locale_runtime.js'), 'utf8');
const managedKey = 'gaoge.forceChineseLocale.managed.v1';
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };

function harness(options={}) {
  let value = options.value ?? null, reloads=0, nextTimer=0, loads=0, readCount=0;
  const writes=[], timers=new Map(), stored=options.stored || new Map();
  const get = function(key,fallback) { return this.__value?.[key] ?? this.value?.[key] ?? fallback; };
  const layer={ __value:{enable_i18n:false, locale_source:'IDE', unrelated:42}, get };
  const dynamic={value:{enable_i18n:false, locale_source:'IDE', unrelated:43}, get};
  const client={getLayer(name){return name==='72216192'?layer:{get:()=>false};}, getDynamicConfig(name){return name==='72216192'?dynamic:{get:()=>false};}};
  const originalLayerMethod=client.getLayer, originalDynamicMethod=client.getDynamicConfig;
  const navigatorPrototype={get language(){return 'en-US';},get languages(){return ['en-US'];}};
  const navigator=Object.create(navigatorPrototype);
  const localStorage={getItem:key=>stored.get(key)??null,setItem:(key,val)=>stored.set(key,val),removeItem:key=>stored.delete(key)};
  if(options.storageUnavailable) localStorage.setItem=()=>{throw Error('storage denied');};
  const settings={async readAll(){ readCount++; if(options.beforeRead) await options.beforeRead(readCount); return {values:{localeOverride:value}}; }, async write(key,next){
    assert.equal(key,'localeOverride'); writes.push(next); if(options.beforeWrite) await options.beforeWrite(next); if(!options.dropWrite)value=next;
  }};
  const module={services:{settings,applicationState:{}}};
  const doc={scripts:[],documentElement:{lang:options.lang||'en'}};
  const window={document:doc,navigator,location:{href:'https://codex.local/index.html',reload(){reloads++;}},localStorage,
    setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}};
  if(!options.noStatsig)window.__STATSIG__={firstInstance:client};
  const clock={now:()=>options.now?.() ?? Date.now()};
  const context=vm.createContext({window,URL,console,Promise,Map,Set,WeakMap,WeakSet,JSON,Object,Reflect,Error,Date:clock});
  vm.runInContext(source,context);
  const runtimeOptions={enabled:options.enabled!==false,revision:'1',assetUrl:name=>name==='app-shared-'?'https://codex.local/assets/app-shared-fixture.js':'',
    loadModule:async name=>{loads++;if(options.loadError)throw Error('not ready');if(options.loadWait)await options.loadWait;return module;},...options.runtimeOptions};
  const runtime=context.installCodexLocaleRuntime(runtimeOptions);
  async function settle(){ await runtime.refresh(); for(let i=0;i<30;i++)await Promise.resolve(); }
  async function tick(){ const item=[...timers].sort((a,b)=>a[1].delay-b[1].delay)[0];if(!item)return false;timers.delete(item[0]);item[1].fn();await settle();return true; }
  return {context,window,doc,runtime,runtimeOptions,writes,timers,stored,settings,module,client,layer,dynamic,get,navigatorPrototype,originalLayerMethod,originalDynamicMethod,settle,tick,
    value:()=>value,setValue:next=>{value=next;},loads:()=>loads,reads:()=>readCount,reloads:()=>reloads};
}

async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}

test('fresh install writes and verifies the native locale without a prior language or a page reload',async()=>{
  const h=harness();await h.settle();
  assert.equal(h.value(),'zh-CN');assert.deepEqual(h.writes,['zh-CN']);
  assert.deepEqual(JSON.parse(h.stored.get(managedKey)),{version:1,appliedLocale:'zh-CN',previousValue:null});
  assert.equal(h.runtime.status().localeApplied,true);assert.equal(h.runtime.status().gateReady,true);assert.equal(h.runtime.status().configured,true);assert.equal(h.runtime.status().ready,false);
  assert.equal(h.runtime.status().needsRestart,true);assert.equal(h.reloads(),0);
  assert.equal(h.window.navigator.language,'zh-CN');assert.equal(h.navigatorPrototype.language,'en-US');
  assert.equal(h.layer.get('enable_i18n',false),true);assert.equal(h.layer.get('locale_source','IDE'),'SYSTEM');
  assert.equal(h.layer.get('unrelated',0),42);assert.equal(h.client.getLayer('another-experiment').get('enable_i18n'),false);
});

test('an already Chinese user has no replacement history and stays Chinese after disable',async()=>{
  const h=harness({value:'zh-CN',lang:'zh-CN'});await h.settle();
  assert.equal(h.writes.length,0);assert.equal(h.stored.has(managedKey),false);assert.equal(h.runtime.status().needsRestart,true);
  h.runtime.update({enabled:false,revision:'2'});await h.settle();
  assert.equal(h.value(),'zh-CN');assert.equal(h.writes.length,0);assert.equal(h.runtime.status().reason,'disabled');
});

test('disable restores the original locale and gate methods while preserving unrelated value changes',async()=>{
  const h=harness({value:'ja-JP'});await h.settle();h.layer.__value.unrelated=99;
  h.runtime.update({enabled:false,revision:'2'});await h.settle();
  assert.equal(h.value(),'ja-JP');assert.deepEqual(h.writes,['zh-CN','ja-JP']);assert.equal(h.stored.has(managedKey),false);
  assert.equal(h.client.getLayer,h.originalLayerMethod);assert.equal(h.client.getDynamicConfig,h.originalDynamicMethod);
  assert.equal(h.layer.get,h.get);assert.equal(h.layer.__value.enable_i18n,false);assert.equal(h.layer.__value.locale_source,'IDE');assert.equal(h.layer.__value.unrelated,99);
  assert.equal(Object.hasOwn(h.window.navigator,'language'),false);assert.equal(h.window.navigator.language,'en-US');
});

test('disable preserves a language the user selected after activation',async()=>{
  const h=harness({value:'ja-JP'});await h.settle();h.setValue('de-DE');
  h.runtime.update({enabled:false,revision:'2'});await h.settle();
  assert.equal(h.value(),'de-DE');assert.deepEqual(h.writes,['zh-CN']);assert.equal(h.stored.has(managedKey),false);
});

test('repeated injection is idempotent and reenable reinstalls released gates',async()=>{
  const h=harness();await h.settle();const before=h.client.getLayer;
  assert.equal(h.context.installCodexLocaleRuntime(h.runtimeOptions),h.runtime);await h.settle();
  assert.equal(h.client.getLayer,before);assert.deepEqual(h.writes,['zh-CN']);
  h.runtime.update({enabled:false,revision:'2'});await h.settle();
  h.runtime.update({enabled:true,revision:'3'});await h.settle();
  assert.equal(h.value(),'zh-CN');assert.equal(h.layer.get('enable_i18n'),true);assert.equal(h.runtime.status().gateReady,true);
});

test('turning off while native discovery waits prevents the queued enable write',async()=>{
  const wait=deferred(),h=harness({loadWait:wait.promise});await flush();
  h.runtime.update({enabled:false,revision:'2'});wait.resolve();await h.settle();await h.settle();
  assert.deepEqual(h.writes,[]);assert.equal(h.runtime.status().enabled,false);assert.equal(h.runtime.status().reason,'disabled');
});

test('turning off during a native write serializes the original locale restoration',async()=>{
  const wait=deferred(),h=harness({value:'fr-FR',beforeWrite:next=>next==='zh-CN'?wait.promise:undefined});await flush();
  assert.deepEqual(h.writes,['zh-CN']);h.runtime.update({enabled:false,revision:'2'});wait.resolve();await h.settle();await h.settle();
  assert.deepEqual(h.writes,['zh-CN','fr-FR']);assert.equal(h.value(),'fr-FR');assert.equal(h.runtime.status().enabled,false);
});

test('the persistent restore record works in a fresh page without a second language backup',async()=>{
  const first=harness({value:'fr-FR'});await first.settle();first.runtime.dispose();
  const next=harness({value:'zh-CN',stored:first.stored});await next.settle();
  assert.equal(next.writes.length,0);next.runtime.update({enabled:false,revision:'2'});await next.settle();
  assert.deepEqual(next.writes,['fr-FR']);assert.equal(next.value(),'fr-FR');
});

test('unavailable backup storage prevents a setting change that could not be restored',async()=>{
  const h=harness({storageUnavailable:true});await h.settle();assert.deepEqual(h.writes,[]);assert.equal(h.value(),null);assert.equal(h.runtime.status().ready,false);
});

test('an unverified native write is not reported as applied',async()=>{
  const h=harness({dropWrite:true});await h.settle();assert.equal(h.runtime.status().localeApplied,false);assert.match(h.runtime.status().error,/unverified/);
});

test('late Statsig initialization and replacement clients are patched without polling forever',async()=>{
  const h=harness({noStatsig:true});await h.settle();assert.equal(h.runtime.status().gateReady,false);
  const root={};h.window.__STATSIG__=root;root.firstInstance=h.client;
  assert.equal(h.layer.get('enable_i18n'),true);assert.equal(h.runtime.status().gateReady,true);
  h.runtime.update({enabled:false,revision:'2'});await h.settle();
  assert.equal(h.window.__STATSIG__,root);assert.equal(root.firstInstance,h.client);assert.equal(h.client.getLayer,h.originalLayerMethod);
});

test('a newer third party method replacement survives cleanup and our retained wrapper becomes inert',async()=>{
  const h=harness();await h.settle();const wrapped=h.client.getLayer;
  const newer=function(...args){return Reflect.apply(wrapped,this,args);};h.client.getLayer=newer;
  h.runtime.update({enabled:false,revision:'2'});await h.settle();
  assert.equal(h.client.getLayer,newer);assert.equal(h.client.getLayer('72216192').get('enable_i18n',false),false);
});

test('native discovery retries are bounded and disposal clears retries',async()=>{
  const h=harness({loadError:true});await h.settle();for(let i=0;i<10;i++){if(!await h.tick())break;}
  assert.equal(h.loads(),7);assert.equal(h.timers.size,0);assert.equal(h.runtime.status().ready,false);
  h.runtime.update({revision:'2'});await h.settle();assert.ok(h.timers.size);h.runtime.dispose();assert.equal(h.timers.size,0);
});

test('disabled fresh installation does not discover or write native settings',async()=>{
  const h=harness({enabled:false});await h.settle();assert.equal(h.loads(),0);assert.equal(h.writes.length,0);assert.equal(h.runtime.status().reason,'disabled');
  assert.equal(h.client.getLayer,h.originalLayerMethod);
});

test('host readAll validation rejects an unrelated response instead of treating it as unset',async()=>{
  const h=harness();h.settings.readAll=async()=>({unexpected:true});await h.settle();assert.equal(h.writes.length,0);assert.match(h.runtime.status().error,/invalid-locale-settings-response/);
});

test('legacy state APIs receive only the locale key and retain the original value',async()=>{
  let value='ko-KR';const calls=[];
  function stateCall(method,payload){const contracts=['get-global-state','set-global-state'];const params=payload.params;calls.push({method,params});
    if(method==='get-setting')return Promise.resolve({value});if(method==='set-setting'){value=params.value;return Promise.resolve({});}throw Error(contracts.join());}
  const h=harness({runtimeOptions:{assetUrl:name=>name==='vscode-api-'?'https://codex.local/assets/vscode-api-fixture.js':'',loadModule:async()=>({native:stateCall})}});await h.settle();
  assert.equal(value,'zh-CN');assert.equal(h.runtime.status().adapter,'legacy-state');
  h.runtime.update({enabled:false,revision:'2'});await h.settle();assert.equal(value,'ko-KR');
  assert.ok(calls.every(c=>c.params.key==='localeOverride'));assert.ok(calls.every(c=>['get-setting','set-setting'].includes(c.method)));
});

function nativeFixture(){
  let value='ja-JP',factories=0;const writes=[];
  const a={appServices:{settings:{async read(key){assert.equal(key,'localeOverride');return {effective:value};},async write(key,next){assert.equal(key,'localeOverride');writes.push(next);value=next;}}}};
  const s={P:promise=>promise};
  // Exact native function bodies from installed 26.1103 RxZZ, minus export names.
  async function b(e){if(a.appServices?.settings!=null)return(await (0,s.P)(a.appServices.settings.read(e.key))).effective;throw Error('Settings are unavailable on this host');}
  async function L(e,t){if(a.appServices?.settings!=null)return void await (0,s.P)(a.appServices.settings.write(e.key,t));throw Error('Settings are unavailable on this host');}
  const descriptor={key:'localeOverride',default:null};
  const native={};Object.defineProperties(native,{LA:{enumerable:true,get:()=>b},cz:{enumerable:true,get:()=>L}});
  const descriptors={};Object.defineProperty(descriptors,'Szl',{enumerable:true,get:()=>({localeOverride:descriptor})});
  function require(){factories++;throw Error('must not initialize a module');}
  require.c={RxZZ:{exports:native},DBCl:{exports:descriptors}};require.m={RxZZ(){factories++;},DBCl(){factories++;}};
  return {module:{__webpack_require__:require},writes,value:()=>value,factories:()=>factories};
}

test('reviewed Rspack settings getters are read from the cache without invoking any module factory',async()=>{
  const fixture=nativeFixture(),h=harness({runtimeOptions:{assetUrl:name=>name==='main.abc123.js'?'https://codex.local/assets/main.abc123.js':'',loadModule:async()=>fixture.module}});
  h.doc.scripts=[{type:'module',src:'https://codex.local/assets/main.abc123.js'}];await h.settle();
  assert.equal(fixture.value(),'zh-CN');assert.deepEqual(fixture.writes,['zh-CN']);assert.equal(fixture.factories(),0);assert.equal(h.runtime.status().adapter,'native-settings');
  h.runtime.update({enabled:false,revision:'2'});await h.settle();assert.equal(fixture.value(),'ja-JP');assert.equal(fixture.factories(),0);
});

test('an uninitialized or changed Rspack contract is rejected without executing factories',async()=>{
  const fixture=nativeFixture(),h=harness({enabled:false});await h.settle();delete fixture.module.__webpack_require__.c.DBCl;
  assert.equal(h.context.codexLocaleSettingsFromRegistry(fixture.module),null);assert.equal(fixture.factories(),0);
  const changed=nativeFixture();changed.module.__webpack_require__.c.RxZZ.exports={LA:async()=>null,cz:async()=>{throw Error('wrong capability');}};
  assert.equal(h.context.codexLocaleSettingsFromRegistry(changed.module),null);assert.equal(changed.factories(),0);
});

test('foreign and nested module script URLs are never used for native settings discovery',async()=>{
  const h=harness({enabled:false});await h.settle();h.doc.scripts=[{type:'module',src:'https://other.local/assets/main.abc.js'},{type:'module',src:'https://codex.local/assets/async/123.abc.js'}];
  assert.equal(h.context.codexLocaleEntryUrls().length,0);
});

test('a writable DynamicConfig cannot conceal a frozen disabled native Layer',async()=>{
  const h=harness({enabled:false});await h.settle();
  const frozen=Object.freeze({__value:Object.freeze({enable_i18n:false,locale_source:'IDE'}),get(){return false;}});
  h.client.getLayer=()=>frozen;
  h.runtime.update({enabled:true,revision:'2'});await h.settle();
  assert.equal(h.dynamic.get('enable_i18n'),true);assert.equal(frozen.get('enable_i18n'),false);
  assert.equal(h.runtime.status().localeApplied,true);assert.equal(h.runtime.status().gateReady,false);assert.equal(h.runtime.status().ready,false);
});

test('module discovery does not invoke arbitrary plain-object export getters',async()=>{
  const h=harness({enabled:false});await h.settle();let reads=0;const module={};
  Object.defineProperty(module,'unknown',{enumerable:true,get(){reads++;throw Error('side effect');}});
  assert.equal(h.context.codexLocaleSettingsFromModule(module),null);assert.equal(reads,0);
});

test('installed Codex native settings adapter applies and restores Chinese in an isolated service',
  {skip:process.env.CODEX_NATIVE_APP_ASAR?false:'Set CODEX_NATIVE_APP_ASAR for read-only native validation',timeout:120000},async()=>{
    const {nativeLocaleFixture}=require('./codex-locale-native-fixture.cjs');
    const {createHash}=require('node:crypto');const packagePath=process.env.CODEX_NATIVE_APP_ASAR;
    const fingerprint=()=>createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex');
    const before=fingerprint(),native=nativeLocaleFixture(packagePath);
    const url='https://codex.local'+native.anchors.entry;
    const h=harness({runtimeOptions:{assetUrl:name=>url.endsWith(name)?url:'',loadModule:async()=>native.module}});
    h.doc.scripts=[{type:'module',src:url}];await h.settle();
    assert.equal(native.value(),'zh-CN');assert.equal(native.executedFactories(),0);assert.equal(h.runtime.status().localeApplied,true);
    assert.equal(h.runtime.status().needsRestart,true);assert.equal(h.reloads(),0);assert.equal(h.runtime.status().adapter,'native-settings');
    h.runtime.update({enabled:false,revision:'2'});await h.settle();assert.equal(native.value(),null);assert.equal(native.executedFactories(),0);
    assert.deepEqual(native.calls.filter(call=>call[0]==='write'),[['write','localeOverride','zh-CN'],['write','localeOverride',null]]);
    assert.equal(fingerprint(),before);h.runtime.dispose();
  });

test('late injection of an older same-process revision cannot reenable a newer disabled choice',async()=>{
  const h=harness({runtimeOptions:{revision:'process-a:9007199254740993'}});await h.settle();
  h.runtime.update({enabled:false,revision:'process-a:9007199254740994'});await h.settle();
  h.context.installCodexLocaleRuntime({...h.runtimeOptions,enabled:true,revision:'process-a:9007199254740993'});await h.settle();
  assert.equal(h.runtime.status().enabled,false);assert.equal(h.value(),null);assert.deepEqual(h.writes,['zh-CN',null]);
  h.runtime.update({enabled:true,revision:'process-b:1'});await h.settle();assert.equal(h.runtime.status().enabled,true);assert.equal(h.value(),'zh-CN');
});

test('watcher ensure is throttled and can recover a native module appearing after bounded startup retries',async()=>{
  let now=100000;const options={loadError:true,now:()=>now},h=harness(options);await h.settle();
  for(let i=0;i<10;i++){if(!await h.tick())break;}
  assert.equal(h.loads(),7);assert.equal(h.timers.size,0);
  for(let i=0;i<20;i++)h.runtime.ensure();await flush();assert.equal(h.loads(),7);
  now+=15000;options.loadError=false;h.runtime.ensure();await h.settle();
  assert.equal(h.loads(),8);assert.equal(h.value(),'zh-CN');assert.equal(h.runtime.status().localeApplied,true);
  h.runtime.ensure();await flush();assert.equal(h.loads(),8);
});

test('cleanup preserves a later change to the same raw i18n object',async()=>{
  const h=harness();await h.settle();h.layer.__value.enable_i18n='later-value';h.layer.__value.locale_source='USER';
  h.runtime.update({enabled:false,revision:'2'});await h.settle();
  assert.equal(h.layer.__value.enable_i18n,'later-value');assert.equal(h.layer.__value.locale_source,'USER');
});

test('native HHvo updates a previously memoized disabled i18n Layer and loads Chinese messages without reload',
  {skip:process.env.CODEX_NATIVE_APP_ASAR?false:'Set CODEX_NATIVE_APP_ASAR for native renderer verification',timeout:120000},async()=>{
    const {createNativeLocaleRendererFixture}=require('./codex-locale-renderer-native-fixture.cjs');
    const f=await createNativeLocaleRendererFixture({archivePath:process.env.CODEX_NATIVE_APP_ASAR,locale:'zh-CN',gateEnabled:false});
    await f.settle();const nativeMemo=f.compilerCaches.find(item=>item.size===30).cache;
    assert.equal(nativeMemo[0],f.layer);assert.equal(nativeMemo[1],false);assert.equal(f.messages(),undefined);
    const compiler=f.module.__webpack_require__.c.F0CT.exports,original=compiler.c;
    const runtime=f.install(source);await runtime.refresh();await f.settle();
    assert.equal(nativeMemo[1],true);assert.equal(f.intl().locale,'zh-CN');assert.equal(f.messages().fixtureSettings,'设置');
    assert.equal(runtime.status().uiReady,true);assert.equal(runtime.status().ready,true);assert.equal(runtime.status().needsRestart,false);
    assert.equal(f.events(),1);assert.ok(f.translationLoads.length>0);assert.equal(f.writes.length,0);
    await runtime.refresh();await f.settle();assert.equal(f.events(),1);
    runtime.update({enabled:false,revision:'native-fixture:2'});await runtime.refresh();await f.settle();
    assert.equal(f.layer.get('enable_i18n',false),false);assert.equal(nativeMemo[1],false);assert.equal(f.messages(),undefined);
    assert.equal(compiler.c,original);assert.equal(f.events(),2);assert.equal(runtime.status().enabled,false);
  });

test('the native memo adapter leaves unrelated compiler caches and later third party wrappers intact',
  {skip:process.env.CODEX_NATIVE_APP_ASAR?false:'Set CODEX_NATIVE_APP_ASAR for native renderer verification',timeout:120000},async()=>{
    const {createNativeLocaleRendererFixture}=require('./codex-locale-renderer-native-fixture.cjs');
    const f=await createNativeLocaleRendererFixture({archivePath:process.env.CODEX_NATIVE_APP_ASAR});await f.settle();
    const runtime=f.install(source);await runtime.refresh();await f.settle();
    const registry=f.module.__webpack_require__,compiler=registry.c.F0CT.exports;
    const dispatcher=registry.c.zd8w.exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    const originalMemo=dispatcher.useMemoCache;
    const foreignLayer={get:()=>false};const unrelated=Array(30).fill(null);unrelated[0]=foreignLayer;unrelated[1]=true;
    dispatcher.useMemoCache=()=>unrelated;assert.equal(compiler.c(30),unrelated);assert.equal(unrelated[0],foreignLayer);assert.equal(unrelated[1],true);
    const differentSize=Array(29).fill(null);differentSize[0]=f.layer;differentSize[1]=false;
    dispatcher.useMemoCache=()=>differentSize;assert.equal(compiler.c(29),differentSize);assert.equal(differentSize[0],f.layer);assert.equal(differentSize[1],false);
    dispatcher.useMemoCache=originalMemo;
    const wrapped=compiler.c;const other=function(...args){return Reflect.apply(wrapped,this,args);};compiler.c=other;
    runtime.update({enabled:false,revision:'native-fixture:2'});await runtime.refresh();await f.settle();assert.equal(compiler.c,other);
    const stopped=Array(30).fill(null);stopped[0]=f.layer;stopped[1]=true;dispatcher.useMemoCache=()=>stopped;
    compiler.c(30);assert.equal(stopped[0],f.layer);assert.equal(stopped[1],true);dispatcher.useMemoCache=originalMemo;
  });

test('an unknown native renderer contract stays pending even when the document language says Chinese',
  {skip:process.env.CODEX_NATIVE_APP_ASAR?false:'Set CODEX_NATIVE_APP_ASAR for native renderer verification',timeout:120000},async()=>{
    const {createNativeLocaleRendererFixture}=require('./codex-locale-renderer-native-fixture.cjs');
    const f=await createNativeLocaleRendererFixture({archivePath:process.env.CODEX_NATIVE_APP_ASAR});await f.settle();
    const registry=f.module.__webpack_require__,original=registry.c.F0CT.exports.c;
    registry.m.HHvo=function unsupportedFactory(){};
    const runtime=f.install(source);await runtime.refresh();await f.settle();
    assert.equal(f.window.document.documentElement.lang,'zh-CN');assert.equal(f.messages(),undefined);
    assert.equal(runtime.status().localeApplied,true);assert.equal(runtime.status().gateReady,true);
    assert.equal(runtime.status().uiReady,false);assert.equal(runtime.status().ready,false);assert.equal(runtime.status().needsRestart,true);
    assert.equal(registry.c.F0CT.exports.c,original);assert.equal(f.events(),0);
    runtime.dispose();
  });

test('native Chinese is only reported ready after the original translation loader resolves',
  {skip:process.env.CODEX_NATIVE_APP_ASAR?false:'Set CODEX_NATIVE_APP_ASAR for native renderer verification',timeout:120000},async()=>{
    const {createNativeLocaleRendererFixture}=require('./codex-locale-renderer-native-fixture.cjs');const translation=deferred();
    const f=await createNativeLocaleRendererFixture({archivePath:process.env.CODEX_NATIVE_APP_ASAR,translationBarrier:translation.promise});await f.settle();
    const runtime=f.install(source);await runtime.refresh();await f.settle();
    assert.equal(f.intl().locale,'zh-CN');assert.equal(f.messages(),undefined);assert.equal(f.translationLoads.length,1);
    assert.equal(runtime.status().localeApplied,true);assert.equal(runtime.status().gateReady,true);
    assert.equal(runtime.status().ready,false);assert.equal(runtime.status().needsRestart,true);assert.equal(runtime.status().reason,'awaiting-native-messages');
    translation.resolve();await f.settle();assert.equal(f.messages().fixtureSettings,'设置');
    assert.equal(runtime.status().ready,true);assert.equal(runtime.status().needsRestart,false);assert.equal(f.translationLoads.length,1);assert.equal(f.events(),1);
    runtime.dispose();
  });

test('the real Statsig ErrorBoundary wrapper still delivers one native language render event',
  {skip:process.env.CODEX_NATIVE_APP_ASAR?false:'Set CODEX_NATIVE_APP_ASAR for native renderer verification',timeout:120000},async()=>{
    const {createNativeLocaleRendererFixture}=require('./codex-locale-renderer-native-fixture.cjs');
    const f=await createNativeLocaleRendererFixture({archivePath:process.env.CODEX_NATIVE_APP_ASAR,locale:'zh-CN'});await f.settle();
    const factory=f.module.__webpack_require__.m.CAnX;assert.equal(typeof factory,'function');
    const boundaryModule={exports:{}};
    factory(boundaryModule,boundaryModule.exports,id=>{
      if(id==='qn8S')return {Log:{warn(){},error(){}}};
      if(id==='sUS3')return {SDKType:{_get:()=> 'fixture'}};
      if(id==='MB5G')return {StatsigMetadataProvider:{get:()=>({})}};
      throw Error('Unexpected ErrorBoundary native dependency '+id);
    });
    const boundary=new boundaryModule.exports.ErrorBoundary('fixture',{networkConfig:{preventAllNetworkTraffic:true}},()=>{});
    f.client._errorBoundary=boundary;boundary.wrap(f.client);
    const emitter=f.client.$emt;assert.equal(emitter.$EB,true);assert.match(Function.prototype.toString.call(emitter),/_capture/);
    const runtime=f.install(source);await runtime.refresh();await f.settle();
    assert.equal(f.client.$emt,emitter);assert.equal(f.messages().fixtureSettings,'设置');
    assert.equal(f.events(),1);assert.equal(runtime.status().ready,true);assert.equal(runtime.status().needsRestart,false);
    runtime.update({enabled:false,revision:'native-fixture:2'});await runtime.refresh();await f.settle();
    assert.equal(f.client.$emt,emitter);assert.equal(f.events(),2);assert.equal(f.messages(),undefined);
  });
