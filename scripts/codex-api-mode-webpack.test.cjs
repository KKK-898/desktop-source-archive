const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const path=require('node:path')
const test=require('node:test')
const {installedAsar}=require('./verify-codex-ultra-installed.cjs')
const {nativeWebpackApiFixture}=require('./codex-api-mode-webpack-native-fixture.cjs')
const packagePath=process.env.CODEX_API_MODE_ASAR||process.env.CODEX_NATIVE_APP_ASAR||installedAsar()
const isWebpack=!require('@electron/asar').listPackage(packagePath).some(name=>/app-initial-[^\\/]+\.js$/.test(name))
const fixture=isWebpack?nativeWebpackApiFixture(packagePath):null
const webpackTest=isWebpack?test:()=>{}
const bindingSource=fs.readFileSync(path.join(__dirname,'../src-tauri/src/codex_api_mode_bindings.js'),'utf8')
const runtimeSource=fs.readFileSync(path.join(__dirname,'../src-tauri/src/codex_api_mode_runtime.js'),'utf8')
const discover=vm.runInThisContext(bindingSource+'\ncodexApiModeWebpackBindings;')
const createGuard=vm.runInThisContext(runtimeSource+'\ncreateCodexApiModeGuard;')
const api={accountId:null,userId:null,authMethod:'apikey',stableId:'synthetic-device'}
const account={accountId:'synthetic-account',userId:'synthetic-user',authMethod:'chatgpt',stableId:'synthetic-device'}
function harness(t,options){const h=fixture.createHarness(options);const bindings=discover(h);assert.equal(bindings.error,null);let state={apiCodingModeEnabled:true};const guard=createGuard(bindings,{getState:()=>state,eventTarget:null});t?.after(()=>guard.dispose());return Object.assign(h,{bindings,guard,setState:value=>{state=value}})}

webpackTest('installed webpack native settings use API Coding policy without granting account access',async t=>{
  const h=harness(t),beforeAuth=h.scope.get(h.descriptors.realAuth),beforeInput=h.scope.get(h.descriptors.input)
  const cloudBefore=h.module.__webpack_require__.c.eFn4.exports.xI
  assert.deepEqual(h.scope.get(cloudBefore),{status:'denied',reason:'unsupported-auth'})
  await h.guard.refresh()
  assert.deepEqual(h.guard.status(),{ready:true,reason:'coding',error:''})
  assert.deepEqual(await h.settings.read('conversationDetailMode'),{configured:'STEPS_COMMANDS',effective:'STEPS_COMMANDS'})
  assert.equal(h.bindings.read(h.scope).detailLevel,'STEPS_COMMANDS')
  assert.equal(h.scope.get(h.descriptors.realAuth),beforeAuth)
  assert.equal(h.scope.get(h.descriptors.input),beforeInput)
  assert.deepEqual(h.scope.get(cloudBefore),{status:'denied',reason:'unsupported-auth'})
  assert.deepEqual(h.settings.workModeAccessByAccount,[{...api,policy:'coding'}])
})

webpackTest('installed webpack renderer bindings use native state and setter without initializing modules',async t=>{
  const h=fixture.createHarness();const registry=h.module.__webpack_require__;const deny=()=>{throw Error('Discovery must not call webpack require')};deny.m=registry.m;deny.c=registry.c
  const bindings=discover({...h,module:{__webpack_require__:deny}});assert.equal(bindings.error,null)
  assert.equal(h.events.length,0);assert.deepEqual(bindings.scopes(),[h.scope])
  const guard=createGuard(bindings,{getState:()=>({apiCodingModeEnabled:true}),eventTarget:null});t.after(()=>guard.dispose());await guard.refresh()
  assert.equal(guard.status().ready,true)
  for(let i=0;i<2;i++){h.scope.set(bindings.optimisticDescriptor,{detailLevel:'STEPS_PROSE'});await h.settings.write('conversationDetailMode','STEPS_PROSE');assert.equal(bindings.read(h.scope).detailLevel,'STEPS_COMMANDS');await guard.refresh();assert.equal(guard.status().ready,true)}
  assert.ok(h.events.every(event=>event.key==='conversationDetailMode'&&event.value==='STEPS_COMMANDS'))
})

webpackTest('installed webpack ChatGPT policy and identity survive API to account to API switching',async t=>{
 const h=harness(t);await h.guard.refresh();h.setIdentity(account);h.setState({apiCodingModeEnabled:false});await h.guard.refresh();await h.settings.publish({...account,policy:'preference'});await h.settings.write('conversationDetailMode','STEPS_PROSE');assert.equal((await h.settings.read('conversationDetailMode')).effective,'STEPS_PROSE');assert.equal(h.scope.get(h.descriptors.realAuth).hasChatGptToken,true)
 h.setIdentity(api);h.setState({apiCodingModeEnabled:true});await h.guard.refresh();assert.equal(h.guard.status().ready,true);assert.equal((await h.settings.read('conversationDetailMode')).effective,'STEPS_COMMANDS');assert.equal(h.settings.workModeAccessByAccount.find(value=>value.accountId===account.accountId).policy,'preference')
})

webpackTest('installed webpack stale account or loading metadata never normalizes the mode',async t=>{
 for(const patch of [{authLoading:true},{accountId:'stale'},{authenticatedAccountId:'stale'},{hasChatGptToken:true},{authMethod:'chatgpt'}]){
 const h=harness(t);h.scope.set(h.descriptors.realAuth,{...h.scope.get(h.descriptors.realAuth),...patch});await h.guard.refresh();assert.equal(h.guard.status().ready,false);assert.equal(h.events.length,0);assert.equal(h.settings.workModeAccessByAccount.length,0)
 }
})

webpackTest('installed webpack missing or foreign identity does not fabricate an account',async t=>{
 for(const identity of [null,{...api,authMethod:'chatgpt'}, {...api,accountId:'stale'}]){const h=harness(t);h.scope.set(h.descriptors.stats,{getContext:()=>({user:identity?{userID:identity.userId,customIDs:{account_id:identity.accountId,stableID:identity.stableId},custom:{auth_method:identity.authMethod}}:null})});await h.guard.refresh();assert.equal(h.guard.status().ready,false);assert.equal(h.events.length,0)}
})

webpackTest('installed webpack direct mode setter preserves native rollback on failed settings write',async t=>{
 const h=fixture.createHarness();h.settings.write=async()=>{throw Error('native save failed')};const b=discover(h);assert.equal(b.error,null);const previous=h.scope.get(b.optimisticDescriptor);await assert.rejects(b.setCoding(h.scope),/native save failed/);assert.notEqual(h.scope.get(b.optimisticDescriptor)?.detailLevel,'STEPS_COMMANDS');assert.equal(h.events.length,0)
})

webpackTest('installed webpack committed scopes exclude stale alternate and unmounted trees',()=>{
 const h=fixture.createHarness(),b=discover(h);assert.equal(b.scopes().length,1);h.root.stateNode.current={stateNode:h.root.stateNode,alternate:h.root};assert.deepEqual(b.scopes(),[])
})

webpackTest('installed webpack unknown module contracts fail closed and unloaded modules stay pending',()=>{
 const h=fixture.createHarness(),registry=h.module.__webpack_require__;const missing={...registry.c};delete missing.qixt;const unloaded=()=>{};unloaded.m=registry.m;unloaded.c=missing;assert.equal(discover({...h,module:{__webpack_require__:unloaded}}).pending,true)
 const changed=()=>{};changed.c=registry.c;changed.m={...registry.m,r8WG:function r8WG(){'workModeAccess!=null';'"preference":"everyday"';'"unsupported-auth"'}};const result=discover({...h,module:{__webpack_require__:changed}});assert.match(result.error,/^Unsupported Codex API mode contract:/);assert.equal(h.events.length,0)
})

webpackTest('installed webpack runtime accepts multiple loaded module entries and never writes onboarding',async()=>{
 const h=fixture.createHarness(),calls=[],timers=new Map();let id=0
 const urls=['782259.a.js','727403.b.js','158624.c.js','348410.d.js'].map(name=>'https://native.test/assets/'+name)
 const document={...h.document,scripts:urls.map(src=>({type:'module',src})),addEventListener(){},removeEventListener(){}}
 const context={URL,Map,Set,WeakMap,WeakSet,Symbol,document,location:{href:'https://native.test/index.html',origin:'https://native.test'},window:{},setTimeout,clearTimeout,setInterval:callback=>{timers.set(++id,callback);return id},clearInterval:key=>timers.delete(key),queueMicrotask}
 vm.createContext(context);vm.runInContext(bindingSource+'\n'+runtimeSource,context)
 const runtime=context.installCodexApiModeRuntime({state:{apiCodingModeEnabled:true},assetUrl:name=>urls.find(url=>url.includes(name))||'',loadModule:async name=>{calls.push(name);return name.startsWith('348410')?h.module:{}},bridge:async()=>({ok:true,apiCodingModeEnabled:true})})
 await runtime.refresh();await new Promise(done=>setImmediate(done));await runtime.refresh();assert.equal(runtime.status().ready,true,runtime.status().error);assert.equal(runtime.status().reason,'coding');assert.equal(calls.length,4);assert.ok(h.events.every(event=>event.key==='conversationDetailMode'));runtime.dispose();assert.equal(timers.size,0)
})

webpackTest('installed webpack runtime discovery does not change API identity or welcome state',()=>{
 assert.doesNotMatch(bindingSource+runtimeSource,/onboarding-welcome-pending|projectless-onboarding-completed|loginWithApiKey|navigate\(["']\/welcome/)
})

webpackTest('installed webpack native Coding selects Codex sidebar without rewriting home composer preference', async t => {
 const original=fixture.createHarness()
 assert.equal(original.scope.get(original.productMode.homeDescriptor),'work')
 assert.equal(original.scope.get(original.productMode.sidebarDescriptor),'work')
 original.productMode.setProduct(original.scope,'codex')
 await new Promise(done=>setImmediate(done))
 assert.equal(original.scope.get(original.productMode.sidebarDescriptor),'codex')
 assert.equal(original.scope.get(original.productMode.workEnabled),false)
 assert.equal(original.scope.get(original.productMode.homeDescriptor),'work')
 const adapted=harness(t)
 await adapted.guard.refresh()
 assert.equal(adapted.scope.get(adapted.productMode.sidebarDescriptor),'codex')
 assert.equal(adapted.scope.get(adapted.productMode.workEnabled),false)
 assert.equal(adapted.scope.get(adapted.productMode.homeDescriptor),'work')
 assert.ok(adapted.events.every(event=>event.key==='conversationDetailMode'))
 assert.ok(original.events.every(event=>event.key==='conversationDetailMode'))
})

webpackTest('installed webpack mode events recognize only the committed native product selector', () => {
 const h=fixture.createHarness(),bindings=discover(h)
 const owner={type:h.controlType,memoizedProps:{mode:'codex',codexAvailable:true,disabled:false,onModeSelect(){},onNewChat:undefined,workModeAccess:'work'},return:h.root}
 const element={nodeType:1,isConnected:true}
 const leaf={stateNode:element,return:owner};owner.child=leaf;h.root.child=owner;element.__reactFiber$native=leaf
 assert.equal(bindings.isModeControlEvent(element),true)
 owner.memoizedProps.onNewChat=()=>{}
 assert.equal(bindings.isModeControlEvent(element),false)
 owner.memoizedProps.onNewChat=undefined;owner.memoizedProps.disabled=true
 assert.equal(bindings.isModeControlEvent(element),false)
 owner.memoizedProps.disabled=false;owner.type=()=>null
 assert.equal(bindings.isModeControlEvent(element),false)
 owner.type=h.controlType;h.root.stateNode.current={stateNode:h.root.stateNode,alternate:h.root}
 assert.equal(bindings.isModeControlEvent(element),false)
})

webpackTest('installed webpack API mode captures native selector and portal events until account switch or disposal', async t => {
 const h=fixture.createHarness(),bindings=discover(h)
 assert.equal(bindings.error,null)
 class TrackedEventTarget extends EventTarget {
  listeners=[]
  addEventListener(type,callback,capture) {
   this.listeners.push({type,callback,capture})
   super.addEventListener(type,callback,capture)
  }
  removeEventListener(type,callback,capture) {
   this.listeners=this.listeners.filter(item=>item.type!==type||item.callback!==callback||item.capture!==capture)
   super.removeEventListener(type,callback,capture)
  }
 }
 const eventTarget=new TrackedEventTarget()
 let notifications=0,nativeActions=0
 const guard=createGuard(bindings,{getState:()=>({apiCodingModeEnabled:true}),eventTarget,notify:()=>{notifications++}})
 t.after(()=>guard.dispose())
 assert.deepEqual(eventTarget.listeners.map(({type,capture})=>({type,capture})),[
  {type:'pointerdown',capture:true},{type:'click',capture:true},{type:'keydown',capture:true},
 ])
 const installedListeners=[...eventTarget.listeners]
 for(const type of ['pointerdown','click','keydown'])eventTarget.addEventListener(type,()=>{nativeActions++},false)
 const owner={type:h.controlType,memoizedProps:{mode:'codex',codexAvailable:true,disabled:false,
  onModeSelect(){},onNewChat:undefined,workModeAccess:'work'},return:h.root}
 // A menu portal is outside the trigger's DOM subtree, but belongs to the
 // same committed native selector. Preserve the committed AppScope sibling.
 h.root.child.sibling=owner
 const trigger={nodeType:1,isConnected:true},item={nodeType:1,isConnected:true}
 const triggerFiber={stateNode:trigger,return:owner}
 const portal={tag:4,stateNode:{containerInfo:{}},return:owner}
 const itemFiber={stateNode:item,return:portal}
 owner.child=triggerFiber;triggerFiber.sibling=portal;portal.child=itemFiber
 trigger.__reactFiber$native=triggerFiber;item.__reactFiber$native=itemFiber
 assert.equal(bindings.isModeControlEvent(trigger),true)
 assert.equal(bindings.isModeControlEvent(item),true)
 function dispatch(type,target,key) {
  const event=new Event(type,{cancelable:true})
  Object.defineProperty(event,'target',{value:target})
  if(key!==undefined)Object.defineProperty(event,'key',{value:key})
  const before=nativeActions,notices=notifications
  const accepted=eventTarget.dispatchEvent(event)
  return {accepted,prevented:event.defaultPrevented,nativeActions:nativeActions-before,notifications:notifications-notices}
 }
 const blocked={accepted:false,prevented:true,nativeActions:0,notifications:1}
 const allowed={accepted:true,prevented:false,nativeActions:1,notifications:0}
 await guard.refresh()
 for(const target of [trigger,item]) {
  for(const type of ['pointerdown','click'])assert.deepEqual(dispatch(type,target),blocked)
  for(const key of ['Enter',' ','ArrowDown','ArrowUp'])assert.deepEqual(dispatch('keydown',target,key),blocked)
  for(const key of ['Tab','Escape','w'])assert.deepEqual(dispatch('keydown',target,key),allowed)
 }
 const lookalike={nodeType:1,isConnected:true}
 assert.deepEqual(dispatch('click',lookalike),allowed)
 const originalType=owner.type
 owner.type=()=>null
 assert.deepEqual(dispatch('click',trigger),allowed)
 owner.type=originalType
 // The native component returns a Home link instead of a mode menu when
 // onNewChat is supplied; its unrelated navigation must stay usable.
 owner.memoizedProps.onNewChat=()=>{}
 assert.deepEqual(dispatch('click',trigger),allowed)
 owner.memoizedProps.onNewChat=undefined
 await guard.refresh()
 assert.equal(guard.status().ready,true)
 // Real auth wins immediately, even while helper state still says API-only.
 h.setIdentity(account)
 assert.deepEqual(dispatch('click',trigger),allowed)
 assert.deepEqual(dispatch('keydown',item,'Enter'),allowed)
 h.setIdentity(api)
 assert.deepEqual(dispatch('click',item),blocked)
 await guard.refresh()
 await guard.dispose()
 assert.ok(installedListeners.every(installed=>!eventTarget.listeners.includes(installed)))
 assert.equal(eventTarget.listeners.length,3,'Only the independent native event listeners remain')
 assert.deepEqual(dispatch('click',trigger),allowed)
 assert.deepEqual(dispatch('keydown',item,'Enter'),allowed)
})

async function gracefulExitHarness(t) {
 const h=fixture.createHarness(),messages=[],timeouts=new Map(),intervals=new Map();let sequence=0,now=100000
 let state={apiCodingModeEnabled:true,apiLocalProjects:{version:1,revision:1,scope:'synthetic-home',runtimeRevision:7,
  globals:{'local-projects':{}},memberships:{assignments:{},projectlessThreadIds:[]}}}
 const urls=['782259.a.js','727403.b.js','158624.c.js','348410.d.js'].map(name=>'https://native.test/assets/'+name)
 const document={...h.document,scripts:urls.map(src=>({type:'module',src})),addEventListener(){},removeEventListener(){}}
 const nativeBridge={sendMessageFromView(message){assert.equal(this,nativeBridge);messages.push(JSON.parse(JSON.stringify(message)))}}
 const context={URL,Map,Set,WeakMap,WeakSet,Symbol,document,location:{href:'https://native.test/index.html',origin:'https://native.test'},window:{electronBridge:nativeBridge},
  Date:{now:()=>now},setTimeout:(callback,ms)=>{const id=++sequence;timeouts.set(id,{callback,ms});return id},clearTimeout:id=>timeouts.delete(id),
  setInterval:callback=>{const id=++sequence;intervals.set(id,callback);return id},clearInterval:id=>intervals.delete(id),queueMicrotask}
 vm.createContext(context);vm.runInContext(bindingSource+'\n'+runtimeSource,context)
 const requests=[]
 const runtime=context.installCodexApiModeRuntime({state,assetUrl:name=>urls.find(url=>url.includes(name))||'',loadModule:async name=>name.startsWith('348410')?h.module:{},
  bridge:async route=>{requests.push(route);assert.equal(route,'/fuel/status');return{ok:true,...state}}})
 t.after(()=>runtime.dispose())
 const beforeLoad=runtime.requestGracefulExit({scope:'synthetic-home',runtimeRevision:7})
 await runtime.refresh();await new Promise(done=>setImmediate(done));await runtime.refresh()
 const sendQueued=()=>{for(const[id,timer]of [...timeouts])if(timer.ms===50){timeouts.delete(id);timer.callback()}}
 return {h,context,runtime,messages,timeouts,intervals,requests,beforeLoad,sendQueued,expected:{scope:'synthetic-home',runtimeRevision:7},
  advance:ms=>{now+=ms},update:patch=>{state={...state,...patch};runtime.update(state)},get state(){return state}}
}
webpackTest('installed webpack graceful quit requires the current API grant and defers the native message',async t=>{
 const h=await gracefulExitHarness(t)
 assert.equal(h.beforeLoad.requested,false)
 assert.equal(h.runtime.requestGracefulExit({...h.expected,runtimeRevision:8}).requested,false)
 assert.equal(h.runtime.requestGracefulExit({...h.expected,scope:'another-home'}).requested,false)
 assert.equal(h.runtime.requestGracefulExit(h.expected).requested,true)
 assert.equal(h.runtime.requestGracefulExit(h.expected).requested,true)
 assert.equal([...h.timeouts.values()].filter(timer=>timer.ms===50).length,1);assert.deepEqual(h.messages,[])
 h.sendQueued();assert.deepEqual(h.messages,[{type:'quit-app'}]);assert.equal(h.requests.includes('/projects/local-state'),false)
})
webpackTest('installed webpack graceful quit rejects stale disabled unsupported and official sessions',async t=>{
 for(const kind of ['stale','disabled','missing-bridge','missing-method','account','loading','disposed']){
  const h=await gracefulExitHarness(t)
  if(kind==='stale')h.advance(60001)
  if(kind==='disabled')h.update({apiCodingModeEnabled:false})
  if(kind==='missing-bridge')delete h.context.window.electronBridge
  if(kind==='missing-method')h.context.window.electronBridge={}
  if(kind==='account')h.h.setIdentity(account)
  if(kind==='loading')h.h.scope.set(h.h.descriptors.realAuth,{authMethod:'apikey',isLoading:true})
  if(kind==='disposed')h.runtime.dispose()
  assert.equal(h.runtime.requestGracefulExit(h.expected).requested,false,kind)
  h.sendQueued();assert.deepEqual(h.messages,[],kind)
 }
})
webpackTest('installed webpack queued graceful quit rechecks grant identity freshness and disposal before sending',async t=>{
 for(const kind of ['home','runtime','account','stale','disabled','replaced-bridge','disposed']){
  const h=await gracefulExitHarness(t);assert.equal(h.runtime.requestGracefulExit(h.expected).requested,true)
  if(kind==='home')h.update({apiLocalProjects:{...h.state.apiLocalProjects,scope:'another-home'}})
  if(kind==='runtime')h.update({apiLocalProjects:{...h.state.apiLocalProjects,runtimeRevision:8}})
  if(kind==='account')h.h.setIdentity(account)
  if(kind==='stale')h.advance(60001)
  if(kind==='disabled')h.update({apiCodingModeEnabled:false})
  if(kind==='replaced-bridge')h.context.window.electronBridge={sendMessageFromView(){throw Error('Wrong bridge')}}
  if(kind==='disposed')h.runtime.dispose()
  h.sendQueued();assert.deepEqual(h.messages,[],kind)
 }
})
webpackTest('installed webpack graceful quit uses live API identity without restarting project polling',async t=>{
 const h=await gracefulExitHarness(t);h.advance(6000);const requests=h.requests.length
 assert.equal(h.runtime.requestGracefulExit(h.expected).requested,true);h.sendQueued()
 assert.deepEqual(h.messages,[{type:'quit-app'}]);assert.equal(h.requests.length,requests)
})
