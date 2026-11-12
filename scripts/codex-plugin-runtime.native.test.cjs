const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { nativePluginFixture } = require('./codex-plugin-native-fixture.cjs');
const source = ['codex_plugin_bindings.js', 'codex_plugin_runtime.js'].map(name => fs.readFileSync(path.join(__dirname,'../src-tauri/src',name),'utf8')).join('\n');
const packagePath = process.env.CODEX_NATIVE_APP_ASAR;
const localCatalog = () => ({ featuredPluginIds: [], marketplaceLoadErrors: [], marketplaces: [{ name:'isolated-local-market',path:'C:/synthetic-only/market',plugins:[{id:'disabled@isolated-local-market',name:'disabled',installed:true,enabled:false}] }] });
async function sha256(file) { const hash=crypto.createHash('sha256');for await(const block of fs.createReadStream(file))hash.update(block);return hash.digest('hex'); }
function harness(native) {
  const calls=[], listeners=new Map(), timers=new Set(), created=[];
  const visible = { isConnected:true,disabled:false,closest:()=>null,getClientRects:()=>[{}],getAttribute:()=>null };
  const sidebar={...visible,children:[],style:{width:'48px'},matches:()=>true,appendChild(node){this.children.push(node);node.parentNode=this;node.isConnected=true;}};
  let nativeEntryMounted=false;
  const nativeEntry={...visible,style:{color:'inherit'},closest:selector=>selector.includes('data-sidebar-navigation-root')?sidebar:null};
  const root={tag:3,child:null,stateNode:null};root.stateNode={current:root};
  const scopeFiber={tag:0,return:root,memoizedState:{memoizedState:{current:native.scope},next:null}};
  const sidebarFiber={tag:5,return:scopeFiber,memoizedProps:{'data-sidebar-navigation-root':true}};
  root.child=scopeFiber;scopeFiber.child=sidebarFiber;sidebar.__reactFiber$nativeFixture=sidebarFiber;
  const nativeEntryFiber={tag:5,type:'a',return:sidebarFiber,memoizedProps:{href:'/plugins'}};
  nativeEntry.__reactFiber$nativeFixture=nativeEntryFiber;
  const container={isConnected:true,__reactContainer$nativeFixture:root,contains:element=>element===sidebar||(nativeEntryMounted&&element===nativeEntry)};
  const document={baseURI:'https://isolated.invalid/index.html',scripts:[{type:'module',src:'https://isolated.invalid'+native.anchors.appEntry}],
    getElementById:id=>id==='root'?container:null,querySelector:()=>null,
    querySelectorAll:selector=>selector.startsWith('[data-sidebar-navigation-root]')?[sidebar]:selector.startsWith('[data-sidebar-destination=')&&nativeEntryMounted?[nativeEntry]:[],
    addEventListener(){},removeEventListener(){},
    createElement(tag){const attrs=new Map(),handlers=new Map();const node={...visible,tagName:tag,style:{},isConnected:false,
      setAttribute:(k,v)=>attrs.set(k,v),getAttribute:k=>attrs.get(k),
      addEventListener:(k,v)=>handlers.set(k,v),removeEventListener:(k,v)=>{if(handlers.get(k)===v)handlers.delete(k);},
      click:()=>handlers.get('click')?.(),remove(){this.isConnected=false;sidebar.children=sidebar.children.filter(n=>n!==this);this.parentNode=null;}};created.push(node);return node;},
  };
  let respond=()=>Promise.resolve(localCatalog());
  const rpc=new Proxy({}, {get(_target,key){if(key!=='sendRequest')throw Error('Native remote proxy must not be inspected: '+String(key));return (method,params)=>{calls.push([method,params]);return respond(method,params);};},set(){throw Error('Native remote proxy cannot be mutated');}});
  native.setConnection({status:'ready',client:{rpc}});
  native.setNavigation({pathname:'/local',navigate:(...args)=>{calls.push(['navigate',...args]);},prepareNavigation(){}});
  const bridge=function(message){calls.push(['bridge',message]);return 'native-bridge';};
  const window={document,electronBridge:{sendMessageFromView:bridge},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:(key,fn)=>{if(listeners.get(key)===fn)listeners.delete(key);}};
  const context=vm.createContext({window,document,console,URL,Date,setTimeout,clearTimeout,
    setInterval(fn){timers.add(fn);return fn;},clearInterval(id){timers.delete(id);}});
  vm.runInContext(source,context);
  const runtime=context.installCodexPluginRuntime({enabled:true,appVersion:'26.1103.60933',localMarketplaces:localCatalog().marketplaces,
    assetUrl:name=>native.anchors.appEntry.endsWith(name)?'https://isolated.invalid'+native.anchors.appEntry:'',loadModule:async()=>native.module});
  return {runtime,window,sidebar,nativeEntry,calls,timers,created,listeners,bridge,setResponse(fn){respond=fn;},
    mountNativeEntry(){nativeEntryMounted=true;sidebarFiber.child=nativeEntryFiber;}};
}

test('registered bundle keeps native rail unchanged and only validates the original native route in isolation',
  {skip:packagePath?false:'Set CODEX_NATIVE_APP_ASAR for installed bundle read-only verification',timeout:120000},async t=>{
    const before=await sha256(packagePath),native=nativePluginFixture(packagePath),f=harness(native);
    try {
      await f.runtime.refresh(); let status=f.runtime.status();
      assert.equal(status.runtimeReady,false);assert.equal(status.nativeEntryReady,false);assert.equal(status.entryMode,'unavailable');assert.equal(status.searchReady,false);
      assert.equal(status.configured,true);assert.equal(status.monitoring,true);assert.equal(status.reason,'awaiting-native-entry');
      assert.equal(status.listVerified,true);assert.equal(status.pluginCount,1);
      assert.deepEqual(native.accessCounters,{get:0,sub:0,authSubscribe:0});
      assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[['plugin/list',{marketplaceKinds:['local']}]]);
      assert.equal(f.sidebar.children.length,0);assert.equal(f.created.length,0);assert.deepEqual(f.sidebar.style,{width:'48px'});
      assert.equal(await f.runtime.openMarketplace(),false);
      await native.queryLocal([]);assert.equal(f.calls.at(-1)[0],'plugin/list');
      assert.equal(f.calls.some(call=>call[0]==='navigate'),false);
      f.mountNativeEntry();await f.runtime.refresh();assert.equal(f.runtime.status().runtimeReady,true);
      assert.equal(f.runtime.status().entryMode,'native-route');assert.equal(f.created.length,0);
      assert.deepEqual(f.nativeEntry.style,{color:'inherit'});assert.equal(await f.runtime.openMarketplace(),true);
      assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))),['navigate','/plugins',{state:{initialHostId:'local'}}]);
      f.runtime.configure({enabled:false});assert.equal(f.sidebar.children.length,0);assert.equal(f.runtime.status().listVerified,false);
      assert.equal(f.window.electronBridge.sendMessageFromView,f.bridge);
      f.runtime.configure({enabled:true});await f.runtime.refresh();assert.equal(f.runtime.status().ready,true);
      native.setAccount(Object.freeze({}));
      assert.equal(f.runtime.status().listVerified,false,'Same-RPC account change immediately invalidates prior list evidence');
      assert.equal(f.sidebar.children.length,0);await f.runtime.refresh();assert.equal(f.runtime.status().ready,true);
      let resolve;f.setResponse(()=>new Promise(yes=>{resolve=yes;}));const delayed=f.runtime.verify();
      await new Promise(yes=>setImmediate(yes));native.setAccount(Object.freeze({}));resolve(localCatalog());await delayed;
      assert.equal(f.runtime.status().listVerified,false,'An old account response cannot verify after an opaque epoch changes');
      f.setResponse(()=>Promise.resolve(localCatalog()));await f.runtime.refresh();assert.equal(f.runtime.status().ready,true);
      native.unmountAccount();assert.equal(f.runtime.status().ready,false);assert.equal(f.sidebar.children.length,0);
      native.restoreAccount();native.resetAccessCounters();await f.runtime.refresh();assert.equal(f.runtime.status().ready,true);
      assert.deepEqual(native.accessCounters,{get:0,sub:0,authSubscribe:0});
      f.setResponse(()=>Promise.reject(new Error('ChatGPT authentication required for remote plugin catalog')));
      await f.runtime.verify();assert.equal(f.runtime.status().ready,false);assert.equal(f.runtime.status().listVerified,false);
      assert.equal(f.runtime.status().fallbackUsed,false,'A direct native authentication denial must not verify a synthetic fallback');
      native.setConnection({status:'disconnected',client:null});await f.runtime.refresh();
      assert.equal(f.sidebar.children.length,0);assert.equal(f.runtime.status().ready,false);
      assert.equal(f.calls.every(call=>['plugin/list','navigate'].includes(call[0])),true);
    } finally { f.runtime.dispose(); }
    assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
    assert.equal(await sha256(packagePath),before,'Installed package is byte-for-byte unchanged');
    t.diagnostic(JSON.stringify({nativeFactoriesExecuted:true,liveCodexTouched:false,authenticationRead:false,sha256:before,anchors:native.anchors}));
  });
