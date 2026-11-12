const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_plugin_runtime.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const catalog = () => ({ marketplaces: [{ name: 'gaoge-curated', path: 'C:/synthetic/plugins', plugins: [{ name: 'alpha', id: 'alpha@gaoge-curated', enabled: false }] }], featuredPluginIds: [], marketplaceLoadErrors: [] });
function fixture(options = {}) {
  const calls = [], listeners = new Map(), docListeners = new Map(), timers = new Set();
  const entry = { isConnected: true, disabled: false, closest: () => null, getAttribute: () => null, getClientRects: () => [{}] };
  const nodes = [], navigationCalls = [], scope = {};
  const sidebar = { ...entry, children: [], matches: () => true,
    appendChild(node) { this.children.push(node); node.parentNode = this; node.isConnected = true; return node; } };
  function createElement(tagName) {
    const attrs = new Map(), events = new Map();
    const node = { ...entry, tagName, style: {}, isConnected: false,
      setAttribute(key,value) { attrs.set(key,value); }, getAttribute(key) { return attrs.get(key); },
      addEventListener(key,fn) { events.set(key,fn); }, removeEventListener(key,fn) { if(events.get(key)===fn) events.delete(key); },
      click() { events.get('click')?.(); },
      remove() { if(this.parentNode) this.parentNode.children=this.parentNode.children.filter(n=>n!==this); this.parentNode=null; this.isConnected=false; },
    }; nodes.push(node); return node;
  }
  const search = { ...entry };
  const directory = { ...entry, querySelectorAll: () => [search] };
  const document = {
    baseURI: 'https://fixture.invalid/index.html',
    scripts: [{ src: 'https://fixture.invalid/assets/348410.abcdef0123.js', type: 'module' }],
    createElement, querySelector: () => options.legacyDom ? {} : null,
    querySelectorAll(selector) { if (selector === '[data-gaoge-plugin-compat-entry="1"]') return nodes.filter(node => node.isConnected && node.getAttribute('data-gaoge-plugin-compat-entry') === '1'); return selector.includes('href=') ? options.entry === false ? [] : [entry] : options.search === false ? [] : [directory]; },
    addEventListener(type, handler) { docListeners.set(type, handler); },
    removeEventListener(type, handler) { if (docListeners.get(type) === handler) docListeners.delete(type); },
  };
  const originalBridge = function(message) { calls.push(['bridge', message]); return 'native-return'; };
  const window = { document, electronBridge: { sendMessageFromView: originalBridge },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
  };
  const client = { hostId: options.hostId || 'local', sendRequest: options.sendRequest || function(method, params, requestOptions) {
    calls.push([method, params, requestOptions]); return Promise.resolve(options.response || catalog());
  } };
  const originalClient = client.sendRequest;
  const navigation = options.navigation === false ? null : { token: {}, openMarketplace: () => { navigationCalls.push('/plugins'); } };
  const bindings = { clients: options.noClient ? [] : [client], scopeToken: scope, connectionToken: options.noClient ? null : client,
    accountToken: {}, isCurrent: () => true, navigation, sidebar: options.sidebar === false ? null : sidebar,
    ui: { nativeEntry: options.entry === false ? null : entry, search: options.search === false ? null : search } };
  const context = vm.createContext({ window, document, console, Date, URL, setTimeout, clearTimeout,
    discoverCodexPluginBindings: options.discover || (() => bindings),
    setInterval(callback) { timers.add(callback); return callback; }, clearInterval(id) { timers.delete(id); },
  });
  if (options.beforeInstall) options.beforeInstall(context, { sidebar, createElement, entry });
  vm.runInContext(source, context);
  const defaults = { enabled: true, appVersion: '26.1103.60933', localMarketplaces: catalog().marketplaces,
    assetUrl: name => name === '348410.abcdef0123.js' ? 'https://fixture.invalid/assets/348410.abcdef0123.js' : '',
    loadModule: async () => ({}),
  };
  const runtime = context.installCodexPluginRuntime({ ...defaults, ...options.runtime });
  const incoming = data => listeners.get('message')?.({ source: window, data });
  return { context, window, document, client, originalClient, originalBridge, runtime, calls, timers, listeners, docListeners, entry, search, incoming, defaults, nodes, sidebar, bindings, navigationCalls };
}

test('native list and available native entry are required for ready', async () => {
  const f = fixture(); await f.runtime.refresh(); const state = f.runtime.status();
  assert.equal(state.runtimeReady, true); assert.equal(state.nativeListVerified, true); assert.equal(state.nativeEntryReady, true);
  assert.equal(state.searchReady, true); assert.equal(state.pluginCount, 1);
  assert.deepEqual(clone(f.calls[0]), ['plugin/list', { marketplaceKinds: ['local'] }, null]);
  assert.equal(f.calls.length, 1); f.runtime.dispose();
});
test('injection or local snapshot alone never implies runtime ready', async () => {
  const f = fixture({ noClient: true }); await f.runtime.refresh();
  assert.equal(f.runtime.status().runtimeInjected, true); assert.equal(f.runtime.status().runtimeReady, false);
  assert.equal(f.runtime.status().listVerified, false); f.runtime.dispose();
});
test('missing native entry awaits the original UI while a disabled native entry remains unsupported', async () => {
  const f = fixture({ entry: false, sidebar: false }); await f.runtime.refresh();
  const status=f.runtime.status();
  assert.equal(status.listVerified,true);assert.equal(status.ready,false);assert.equal(status.nativeEntryReady,false);
  assert.equal(status.configured,true);assert.equal(status.monitoring,true);
  assert.equal(status.reason,'awaiting-native-entry');assert.equal(status.state,'pending');f.runtime.dispose();
  const g=fixture();g.entry.disabled=true;await g.runtime.refresh();
  assert.equal(g.runtime.status().ready,false);assert.equal(g.runtime.status().state,'unsupported');
  assert.equal(g.runtime.status().reason,'native-plugin-entry-disabled');g.runtime.dispose();
});
test('search is reported from the native directory independently, never fabricated', async () => {
  const f = fixture({ search: false }); await f.runtime.refresh();
  assert.equal(f.runtime.status().ready, true); assert.equal(f.runtime.status().searchReady, false); f.runtime.dispose();
});
test('malformed results, native load failures and invisible registrations are not verified', async t => {
  for (const response of [{}, { data: catalog() }, { ...catalog(), marketplaceLoadErrors: [{ error: 'synthetic' }] }, { marketplaces: [] }]) {
    await t.test(JSON.stringify(response), async () => {
      const f = fixture({ response }); await f.runtime.refresh(); assert.equal(f.runtime.status().ready, false); assert.equal(f.runtime.status().listVerified, false); f.runtime.dispose();
    });
  }
});
test('read-only verification neither enables nor installs disabled plugins', async () => {
  const f = fixture(); await f.runtime.refresh(); await f.runtime.verify();
  assert.equal(f.calls.every(call => call[0] === 'plugin/list'), true);
  assert.equal(catalog().marketplaces[0].plugins[0].enabled, false); f.runtime.dispose();
});
test('all non-list methods and permission failures retain native arguments and errors', async () => {
  const failure = new Error('native auth denied'); const calls = [];
  const f = fixture({ sendRequest(method, params) { calls.push({ method, params }); return method === 'plugin/list' ? Promise.resolve(catalog()) : Promise.reject(failure); } });
  await f.runtime.refresh(); const params = { pluginName: 'alpha', authMethod: 'apikey' };
  await assert.rejects(f.client.sendRequest('plugin/install', params), error => error === failure);
  assert.equal(calls.at(-1).params, params); assert.equal(params.authMethod, 'apikey'); f.runtime.dispose();
});
test('registered local snapshots never hide native authentication rejection', async () => {
  let fail = false; const denied = new Error('ChatGPT authentication required for remote plugin catalog; API key auth is not supported');
  const f = fixture({ sendRequest() { return fail ? Promise.reject(denied) : Promise.resolve(catalog()); } });
  await f.runtime.refresh(); fail = true;
  await assert.rejects(f.client.sendRequest('plugin/list', { marketplaceKinds: ['local'] }), error => error === denied);
  assert.equal(f.runtime.status().fallbackUsed, false); assert.equal(f.runtime.status().listVerified, false); assert.equal(f.runtime.status().ready, false); f.runtime.dispose();
});
test('cloud, workspace and paginated lists are not merged with local catalogs', async () => {
  const failure = new Error('ChatGPT authentication required for remote plugin catalog; API key auth is not supported'); let fail = false;
  const f = fixture({ sendRequest() { return fail ? Promise.reject(failure) : Promise.resolve(catalog()); } }); await f.runtime.refresh(); fail = true;
  for (const params of [{ marketplaceKinds: ['remote'] }, { marketplaceKinds: ['local'], scope: 'workspace' }, { marketplaceKinds: ['local'], cursor: 'next' }, { marketplaceKinds: ['local'], hostId: 'remote' }]) {
    await assert.rejects(f.client.sendRequest('plugin/list', params), error => error === failure);
  }
  assert.equal(f.runtime.status().fallbackUsed, false); f.runtime.dispose();
});
test('disable restores owned function pointers and clears verification', async () => {
  const f = fixture(); await f.runtime.refresh(); assert.notEqual(f.client.sendRequest, f.originalClient);
  f.runtime.configure({ enabled: false });
  assert.equal(f.client.sendRequest, f.originalClient); assert.equal(f.window.electronBridge.sendMessageFromView, f.originalBridge);
  assert.equal(f.runtime.status().needsRestart, false); assert.equal(f.runtime.status().runtimeReady, false); assert.equal(f.runtime.status().listVerified, false);
  f.runtime.dispose(); assert.equal(f.listeners.size, 0); assert.equal(f.docListeners.size, 0); assert.equal(f.timers.size, 0);
});
test('wrappers retained by another extension become inert and require a clean reload', async () => {
  const f = fixture(); await f.runtime.refresh(); const retained = f.client.sendRequest;
  const later = function(...args) { return retained.apply(this, args); }; f.client.sendRequest = later;
  f.runtime.configure({ enabled: false }); assert.equal(f.client.sendRequest, later); assert.equal(f.runtime.status().needsRestart, true);
  await retained.call(f.client, 'plugin/list', { marketplaceKinds: ['local'] }); assert.equal(f.runtime.status().listVerified, false); f.runtime.dispose();
});
test('disable while a native read is pending rejects late verification', async () => {
  let resolve; const waiting = new Promise(yes => { resolve = yes; });
  const f = fixture({ sendRequest: () => waiting }); const refresh = f.runtime.refresh();
  await new Promise(yes => setImmediate(yes)); f.runtime.configure({ enabled: false }); resolve(catalog()); await refresh;
  assert.equal(f.runtime.status().listVerified, false); assert.equal(f.runtime.status().ready, false); f.runtime.dispose();
});
test('legacy irreversible DOM mutation is reported instead of pretending restoration', async () => {
  const f = fixture({ legacyDom: true }); await f.runtime.refresh();
  assert.equal(f.runtime.status().needsRestart, true); assert.equal(f.calls.length, 0); assert.equal(f.runtime.status().runtimeReady, false); f.runtime.dispose();
});
test('unknown or legacy application versions never install speculative hooks', async () => {
  for (const appVersion of ['', 'new-build', '26.500.1']) { const f = fixture({ runtime: { appVersion } }); await f.runtime.refresh();
    assert.equal(f.runtime.status().state, 'unsupported'); assert.equal(f.calls.length, 0); assert.equal(f.window.electronBridge.sendMessageFromView, f.originalBridge); f.runtime.dispose(); }
});
test('reinstall is idempotent and configuration changes keep a single runtime', async () => {
  const f = fixture(); await f.runtime.refresh(); const wrapper = f.client.sendRequest;
  const again = f.context.installCodexPluginRuntime(f.defaults); await again.refresh();
  assert.equal(again, f.runtime); assert.equal(f.client.sendRequest, wrapper); assert.equal(f.timers.size, 1);
  f.runtime.configure({ localMarketplaces: catalog().marketplaces }); assert.equal(f.runtime.status().enabled, true); f.runtime.dispose();
});
test('bridge synthetic, remote and uncorrelated responses cannot establish native readiness', async () => {
  const f = fixture({ noClient: true }); await f.runtime.refresh();
  assert.equal(f.listeners.size, 0); assert.equal(f.docListeners.size, 0);
  assert.equal(f.window.electronBridge.sendMessageFromView, f.originalBridge);
  f.window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',request:{id:'collision',method:'plugin/list',params:{marketplaceKinds:['local']}}});
  for(const hostId of [undefined,'local','remote-a']) f.incoming({type:'mcp-response',hostId,message:{id:'collision',result:catalog()}});
  assert.equal(f.runtime.status().listVerified,false);assert.equal(f.runtime.status().ready,false);
  assert.equal(f.runtime.status().transport,'none');f.runtime.dispose();
});
test('source does not spoof React identity, unlock disabled controls, or replace global filter/fetch', () => {
  assert.doesNotMatch(source, /Array\.prototype\.filter\s*=|window\.fetch\s*=|disabled\s*=\s*false|authMethod\s*=|memoizedProps\s*=/);
});

test('missing native entry never adds a button, mutates rail styles, or fabricates native readiness', async () => {
  const f=fixture({entry:false});f.sidebar.style={width:'48px'};f.entry.style={color:'inherit'};
  await f.runtime.refresh();const status=f.runtime.status();
  assert.equal(f.sidebar.children.length,0);assert.equal(f.nodes.length,0);
  assert.deepEqual(f.sidebar.style,{width:'48px'});assert.deepEqual(f.entry.style,{color:'inherit'});
  assert.equal(status.entryMode,'unavailable');assert.equal(status.nativeEntryReady,false);
  assert.equal(status.listVerified,true);assert.equal(status.ready,false);assert.equal(status.configured,true);assert.equal(status.monitoring,true);
  assert.equal(await f.runtime.openMarketplace(),false);assert.equal(f.navigationCalls.length,0);
  f.runtime.configure({enabled:false});assert.equal(f.sidebar.children.length,0);assert.equal(f.runtime.status().configured,true);f.runtime.dispose();
  assert.equal(f.runtime.status().configured,false);assert.equal(f.runtime.status().monitoring,false);
});
test('only exact owned legacy nodes are removed while native sidebar children stay unchanged',async()=>{
  let old,foreign,nativeNode;
  const f=fixture({entry:false,beforeInstall(_context,{sidebar,createElement}){
    old=createElement('button');old.setAttribute('data-gaoge-plugin-compat-entry','1');sidebar.appendChild(old);
    foreign=createElement('button');foreign.setAttribute('data-gaoge-plugin-compat-entry','third-party');sidebar.appendChild(foreign);
    nativeNode={native:true};sidebar.children.push(nativeNode);
  }});
  await f.runtime.refresh();assert.equal(old.isConnected,false);assert.deepEqual(f.sidebar.children,[foreign,nativeNode]);
  f.runtime.dispose();assert.deepEqual(f.sidebar.children,[foreign,nativeNode]);assert.equal(f.navigationCalls.length,0);
});
test('a visible original native entry becomes ready without any injected sidebar node',async()=>{
  const f=fixture({entry:false});await f.runtime.refresh();assert.equal(f.runtime.status().ready,false);
  f.bindings.ui.nativeEntry=f.entry;await f.runtime.refresh();
  assert.equal(f.sidebar.children.length,0);assert.equal(f.nodes.length,0);assert.equal(f.entry.disabled,false);
  assert.equal(f.runtime.status().entryMode,'native-route');assert.equal(f.runtime.status().ready,true);
  assert.equal(await f.runtime.openMarketplace(),true);assert.deepEqual(f.navigationCalls,['/plugins']);f.runtime.dispose();
});
test('unverified sidebar or unavailable navigator never creates a speculative entry',async()=>{
  for(const options of [{sidebar:false},{navigation:false}]){
    const f=fixture({entry:false,...options});await f.runtime.refresh();
    assert.equal(f.nodes.length,0);assert.equal(f.runtime.status().state,'pending');assert.equal(f.runtime.status().nativeEntryReady,false);f.runtime.dispose();
  }
  const f=fixture({entry:false});f.sidebar.matches=()=>false;await f.runtime.refresh();
  assert.equal(f.nodes.length,0);assert.equal(f.runtime.status().state,'pending');f.runtime.dispose();
});
test('late module discovery cannot recreate an entry after disable', async () => {
  let resolve; const moduleWait=new Promise(yes=>{resolve=yes;});
  const f=fixture({entry:false,runtime:{loadModule:()=>moduleWait}}); const work=f.runtime.refresh();
  await new Promise(yes=>setImmediate(yes)); f.runtime.configure({enabled:false}); resolve({}); await work;
  assert.equal(f.nodes.length,0); assert.equal(f.sidebar.children.length,0); assert.equal(f.runtime.status().ready,false); f.runtime.dispose();
});
test('connection replacement restores old wrapper and prevents stale results verifying new connection', async () => {
  let delayed=false, resolve; const wait=new Promise(yes=>{resolve=yes;});
  const f=fixture({sendRequest(){return delayed?wait:Promise.resolve(catalog());}}); await f.runtime.refresh();
  const retained=f.client.sendRequest; delayed=true; const oldCall=retained.call(f.client,'plugin/list',{marketplaceKinds:['local']});
  const failure=new Error('new connection denied');
  const next={sendRequest(){return Promise.reject(failure);}};
  f.bindings.clients=[next]; f.bindings.connectionToken=next; f.bindings.scopeToken={};
  await f.runtime.refresh(); assert.equal(f.client.sendRequest,f.originalClient); assert.equal(f.runtime.status().listVerified,false);
  resolve(catalog()); await oldCall; assert.equal(f.runtime.status().listVerified,false);
  await retained.call(f.client,'plugin/list',{marketplaceKinds:['local']}); assert.equal(f.runtime.status().listVerified,false); f.runtime.dispose();
});
test('loss of current native connection removes stale client and list evidence', async () => {
  const f=fixture({entry:false}); await f.runtime.refresh(); assert.equal(f.runtime.status().listVerified,true);
  f.bindings.clients=[]; f.bindings.connectionToken=null; f.bindings.navigation=null;
  await f.runtime.refresh(); assert.equal(f.client.sendRequest,f.originalClient); assert.equal(f.runtime.status().ready,false);
  assert.equal(f.runtime.status().listVerified,false); assert.equal(f.sidebar.children.length,0); f.runtime.dispose();
});
test('foreign replacement is detected while enabled rather than stacked beneath another hook', async () => {
  const f=fixture({entry:false}); await f.runtime.refresh(); const retained=f.client.sendRequest;
  f.client.sendRequest=function(...args){return retained.apply(this,args);};
  assert.equal(f.runtime.status().needsRestart,true); assert.equal(f.runtime.status().ready,false); assert.equal(f.sidebar.children.length,0);
  await f.runtime.refresh(); assert.equal(f.runtime.status().listVerified,false); f.runtime.dispose();
});
test('remote RPC discovery uses read-only probe and never writes the native proxy', async () => {
  const seen=[];
  const remote=new Proxy({}, {get(target,key){if(key==='sendRequest')return (method,params)=>{seen.push([method,params]);return Promise.resolve(catalog());};throw new Error('unexpected proxy property '+String(key));},set(){throw new Error('native proxy cannot be assigned');}});
  const f=fixture({noClient:true}); f.bindings.clients=[remote]; f.bindings.connectionToken=remote; f.bindings.probeOnly=true;
  await f.runtime.refresh(); assert.equal(seen.length,1); assert.equal(f.runtime.status().ready,true); f.runtime.dispose();
});
test('workspace and mixed remote/local requests pass through without local fallback', async () => {
  let fail=false; const denied=new Error('ChatGPT authentication required for remote plugin catalog');
  const f=fixture({sendRequest(){return fail?Promise.reject(denied):Promise.resolve(catalog());}}); await f.runtime.refresh(); fail=true;
  for(const params of [{marketplaceKinds:['local','remote']},{marketplaceKinds:['local'],cwds:['C:/workspace']},{marketplaceKinds:['local'],cwd:'C:/workspace'},{marketplaceKinds:['local'],workspaceId:'workspace'}])
    await assert.rejects(f.client.sendRequest('plugin/list',params),error=>error===denied);
  assert.equal(f.runtime.status().fallbackUsed,false); f.runtime.dispose();
});
test('imports outside the loaded same-origin renderer assets are ignored', async () => {
  let imports=0;const f=fixture({runtime:{loadModule:async()=>{imports++;return {};},assetUrl:name=>'https://foreign.invalid/assets/'+name}});
  f.document.scripts[0].src='https://foreign.invalid/assets/348410.abcdef0123.js'; await f.runtime.refresh();
  assert.equal(imports,0); assert.equal(f.runtime.status().listVerified,false); f.runtime.dispose();
});
test('native client verification never wraps the application bridge in any version', async () => {
  const f=fixture({runtime:{appVersion:'26.610.10'}}); await f.runtime.refresh();
  assert.equal(f.window.electronBridge.sendMessageFromView,f.originalBridge); assert.equal(f.runtime.status().transport,'native-client'); f.runtime.dispose();
});
test('updated registered marketplaces invalidate earlier list evidence immediately', async () => {
  const f=fixture(); await f.runtime.refresh(); assert.equal(f.runtime.status().ready,true);
  f.runtime.configure({localMarketplaces:[{name:'new-market',path:'C:/synthetic/new-market',plugins:[]}]});
  assert.equal(f.runtime.status().ready,false); assert.equal(f.runtime.status().listVerified,false); f.runtime.dispose();
});

test('same RPC account epoch changes invalidate list and entry synchronously', async () => {
  let account={}; const initial=account; const f=fixture({entry:false});
  f.bindings.accountToken=initial;f.bindings.isCurrent=()=>account===initial;
  await f.runtime.refresh();assert.equal(f.runtime.status().listVerified,true);const original=f.originalClient;
  account={};
  assert.equal(f.runtime.status().listVerified,false);assert.equal(f.runtime.status().ready,false);
  assert.equal(f.sidebar.children.length,0);assert.equal(f.client.sendRequest,original);
  f.runtime.dispose();
});
test('inflight native list cannot verify after an account epoch changes on the same RPC', async () => {
  let account={},resolve;const initial=account;const response=new Promise(yes=>{resolve=yes;});
  const f=fixture({entry:false,sendRequest:()=>response});f.bindings.accountToken=initial;f.bindings.isCurrent=()=>account===initial;
  const work=f.runtime.refresh();await new Promise(yes=>setImmediate(yes));account={};resolve(catalog());await work;
  assert.equal(f.runtime.status().listVerified,false);assert.equal(f.runtime.status().ready,false);assert.equal(f.sidebar.children.length,0);f.runtime.dispose();
});
test('bridge messages remain inert across account changes without controller event handlers', async () => {
  let account={};const first=account;const f=fixture({noClient:true});
  f.bindings.accountToken=first;f.bindings.isCurrent=()=>account===first;await f.runtime.refresh();
  const request={type:'mcp-request',hostId:'local',request:{id:'previous-account',method:'plugin/list',params:{marketplaceKinds:['local']}}};
  f.window.electronBridge.sendMessageFromView(request);account={};
  f.incoming({type:'mcp-response',message:{id:'previous-account',result:catalog()}});
  assert.equal(f.runtime.status().listVerified,false);
  const second=account;f.bindings.accountToken=second;f.bindings.isCurrent=()=>account===second;await f.runtime.refresh();
  f.incoming({type:'mcp-response',message:{id:'previous-account',result:catalog()}});
  assert.equal(f.runtime.status().listVerified,false);f.runtime.dispose();
});
test('missing or unverifiable account epoch cannot produce ready from an otherwise valid native list', async () => {
  const f=fixture();delete f.bindings.accountToken;delete f.bindings.isCurrent;await f.runtime.refresh();
  assert.equal(f.runtime.status().listVerified,false);assert.equal(f.runtime.status().ready,false);
  assert.equal(f.runtime.status().state,'unsupported');assert.equal(f.runtime.status().reason,'native-account-epoch-unverified');f.runtime.dispose();
});

test('legacy mutation markers installed after this controller invalidate previous success', async()=>{
  const f=fixture();await f.runtime.refresh();assert.equal(f.runtime.status().ready,true);
  f.window.__gaogeCodexPluginFetchPatchInstalled=true;
  assert.equal(f.runtime.status().ready,false);assert.equal(f.runtime.status().needsRestart,true);f.runtime.dispose();
});
test('current binding exceptions clear evidence and never escape background refresh', async()=>{
  const f=fixture();await f.runtime.refresh();f.bindings.isCurrent=()=>{throw Error('stale native scope');};
  await f.runtime.refresh();assert.equal(f.runtime.status().ready,false);assert.equal(f.runtime.status().listVerified,false);f.runtime.dispose();
});

test('synchronous native list rejection preserves error identity and invalidates earlier evidence', async()=>{
  let denied=false;const failure=new Error('native synchronous permission denied');
  const f=fixture({sendRequest(){if(denied)throw failure;return Promise.resolve(catalog());}});await f.runtime.refresh();denied=true;
  assert.throws(()=>f.client.sendRequest('plugin/list',{marketplaceKinds:['local']}),error=>error===failure);
  assert.equal(f.runtime.status().listVerified,false);f.runtime.dispose();
});
test('disable before a scheduled probe begins prevents its native RPC dispatch', async()=>{
  const f=fixture();await f.runtime.refresh();const count=f.calls.length;
  const verifying=f.runtime.verify();f.runtime.configure({enabled:false});await verifying;
  assert.equal(f.calls.length,count);assert.equal(f.runtime.status().ready,false);f.runtime.dispose();
});

test('newly disabled native entry blocks explicit native navigation before timer refresh',async()=>{
  const f=fixture();await f.runtime.refresh();f.entry.disabled=true;
  assert.equal(await f.runtime.openMarketplace(),false);
  assert.equal(f.navigationCalls.length,0);assert.equal(f.sidebar.children.length,0);assert.equal(f.runtime.status().ready,false);f.runtime.dispose();
});

test('each persistent legacy runtime marker blocks probing and compatibility UI before install',async t=>{
  const markers=['window.__gaogeCodexPluginMarketplaceRuntimeV5','window.__gaogePluginMarketplaceFetchPatch','Array.prototype.__gaogePluginOriginalFilter','window.__gaogePluginMarketplaceRuntimeTimer'];
  for(const marker of markers)await t.test(marker,async()=>{
    const f=fixture({entry:false,beforeInstall:context=>vm.runInContext(marker+'=true',context)});await f.runtime.refresh();
    assert.equal(f.runtime.status().needsRestart,true);assert.equal(f.runtime.status().ready,false);assert.equal(f.calls.length,0);assert.equal(f.nodes.length,0);f.runtime.dispose();
  });
});
test('each late persistent legacy marker immediately invalidates success without false rollback',async t=>{
  const markers=['window.__gaogeCodexPluginMarketplaceRuntimeV5','window.__gaogePluginMarketplaceFetchPatch','Array.prototype.__gaogePluginOriginalFilter','window.__gaogePluginMarketplaceRuntimeTimer'];
  for(const marker of markers)await t.test(marker,async()=>{
    const f=fixture();await f.runtime.refresh();assert.equal(f.runtime.status().ready,true);
    vm.runInContext(marker+'=true',f.context);assert.equal(f.runtime.status().needsRestart,true);assert.equal(f.runtime.status().ready,false);assert.equal(f.sidebar.children.length,0);
    f.runtime.configure({enabled:false});assert.equal(vm.runInContext(marker,f.context),true);assert.equal(f.runtime.status().needsRestart,true);f.runtime.dispose();
  });
});

test('v2 upgrade disposes the old runtime and removes its rail button without reusing closures',async()=>{
  let oldDisposed=0,oldConfigured=0,oldButton;
  const f=fixture({beforeInstall(context,{sidebar,createElement}){
    oldButton=createElement('button');oldButton.setAttribute('data-gaoge-plugin-compat-entry','1');sidebar.appendChild(oldButton);
    context.window.__gaogeCodexPluginRuntime={version:2,disposed:false,configure(){oldConfigured++;},
      dispose(){oldDisposed++;this.disposed=true;oldButton.remove();},status(){return {needsRestart:false};}};
  }});
  await f.runtime.refresh();assert.equal(oldDisposed,1);assert.equal(oldConfigured,0);assert.equal(f.runtime.version,3);
  assert.equal(oldButton.isConnected,false);assert.equal(f.sidebar.children.length,0);assert.equal(f.timers.size,1);assert.equal(f.runtime.status().needsRestart,false);f.runtime.dispose();
});

test('replacing a disposed runtime keeps retained old wrappers inert and one active timer',async()=>{
  const f=fixture();await f.runtime.refresh();const old=f.runtime,retained=f.client.sendRequest;old.dispose();
  const next=f.context.installCodexPluginRuntime(f.defaults);await next.refresh();assert.notEqual(next,old);assert.equal(f.timers.size,1);
  await retained.call(f.client,'plugin/list',{marketplaceKinds:['local']});assert.equal(old.status().listVerified,false);assert.equal(next.status().ready,true);
  next.dispose();assert.equal(f.timers.size,0);
});

test('same-name marketplace from a different or missing native path cannot verify registration',async t=>{
  for(const nativePath of ['C:/wrong-origin',null,undefined,'C:/synthetic/plugins/../wrong-origin'])await t.test(String(nativePath),async()=>{
    const response=catalog();response.marketplaces[0].path=nativePath;const f=fixture({response});await f.runtime.refresh();
    assert.equal(f.runtime.status().listVerified,false);assert.equal(f.runtime.status().ready,false);
    assert.equal(f.runtime.status().reason,'registered-marketplace-not-visible');f.runtime.dispose();
  });
});
test('marketplace verification accepts explicit backend manifest or root identities only',async()=>{
  const expected=catalog().marketplaces;expected[0].path='C:/synthetic/plugins/.agents/plugins/marketplace.json';expected[0].marketplaceRoot='C:/synthetic/plugins';
  for(const nativePath of ['C:\\SYNTHETIC\\plugins\\.agents\\plugins\\marketplace.json','\\\\?\\C:\\synthetic\\plugins','C:/synthetic/plugins/']){
    const response=catalog();response.marketplaces[0].path=nativePath;const f=fixture({response,runtime:{localMarketplaces:expected}});await f.runtime.refresh();
    assert.equal(f.runtime.status().ready,true);f.runtime.dispose();
  }
  const manifestOnly=JSON.parse(JSON.stringify(expected));delete manifestOnly[0].marketplaceRoot;
  const f=fixture({runtime:{localMarketplaces:manifestOnly}});await f.runtime.refresh();assert.equal(f.runtime.status().ready,false);f.runtime.dispose();
});

test('native entry beneath a disabled ancestor is neither ready nor replaced with compatibility UI',async t=>{
  for(const selector of ['[disabled]','[aria-disabled="true"]'])await t.test(selector,async()=>{
    const f=fixture();f.entry.closest=query=>query.includes(selector)?{}:null;await f.runtime.refresh();
    assert.equal(f.runtime.status().nativeEntryReady,false);assert.equal(f.runtime.status().ready,false);
    assert.equal(f.runtime.status().reason,'native-plugin-entry-disabled');assert.equal(f.sidebar.children.length,0);f.runtime.dispose();
  });
});
test('a newly ancestor-disabled native entry remains blocked without adding a substitute',async()=>{
  const f=fixture({entry:false});await f.runtime.refresh();assert.equal(f.sidebar.children.length,0);
  f.entry.closest=query=>query.includes('[aria-disabled="true"]')?{}:null;f.bindings.ui.nativeEntry=f.entry;
  await f.runtime.refresh();assert.equal(f.sidebar.children.length,0);assert.equal(f.runtime.status().nativeEntryReady,false);
  assert.equal(f.runtime.status().ready,false);assert.equal(f.navigationCalls.length,0);f.runtime.dispose();
});
