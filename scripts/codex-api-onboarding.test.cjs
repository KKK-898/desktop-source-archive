const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const path=require('node:path')
const test=require('node:test')
const {installedAsar}=require('./verify-codex-ultra-installed.cjs')
const {nativeOnboardingFixture}=require('./codex-api-onboarding-native-fixture.cjs')
const {nativeWebpackApiFixture}=require('./codex-api-mode-webpack-native-fixture.cjs')
let packagePath=process.env.CODEX_API_MODE_ASAR||process.env.CODEX_NATIVE_APP_ASAR
let unavailable=''
if(!packagePath){try{packagePath=installedAsar()}catch(error){unavailable=error.message}}
// A discovered or explicit unsupported package must fail. Only an absent
// desktop installation may skip these portable developer checks.
const nativeOptions={skip:!packagePath&&('Installed Codex is required: '+unavailable)}
const nativeTest=(name,run)=>test(name,{...nativeOptions,timeout:20000},run)
const fixture=packagePath?nativeOnboardingFixture(packagePath):null
const bindingSource=fs.readFileSync(path.join(__dirname,'../src-tauri/src/codex_api_mode_bindings.js'),'utf8')
const runtimeSource=fs.readFileSync(path.join(__dirname,'../src-tauri/src/codex_api_mode_runtime.js'),'utf8')
const bind=vm.runInThisContext(bindingSource+'\ncodexApiModeLocalOnboardingBindings;')
const discover=vm.runInThisContext(bindingSource+'\ncodexApiModeWebpackBindings;')
const guardFactory=vm.runInThisContext(runtimeSource+'\ncreateCodexApiModeGuard;')
const {completionKey,timeKey,atomsKey,ownerKey}=fixture||{}
let cachedModeFixture
const modes=()=>cachedModeFixture||(cachedModeFixture=nativeWebpackApiFixture(packagePath))
const receipt={projectlessCompleted:true,completedAt:1794134871}
const completedAtoms={[completionKey]:true,[timeKey]:receipt.completedAt,'electron:onboarding-welcome-pending':true}
const restore=h=>bind([h.record],{window:h.window})

// This regression starts at real main-process sync, not a hand-written route
// simulation. Old builds reproduce the reported loss; 26.1103.60933 keeps
// shared completion natively and must not be forced to reproduce an old bug.
nativeTest('native scoped API hydration preserves only its reviewed shared completion whitelist',async()=>{
 const h=fixture.create({atoms:completedAtoms});h.selectOwner(null)
 assert.ok(fixture.sharedKeys.includes(completionKey));assert.ok(fixture.sharedKeys.includes(timeKey))
 assert.equal(h.globalState.get(atomsKey)[completionKey],true)
 const hydrated=JSON.parse(JSON.stringify(await h.hydrate()))
 if(fixture.preservesSharedApiAtoms){
  assert.deepEqual(hydrated,Object.fromEntries(Object.entries(completedAtoms).filter(([key])=>fixture.sharedKeys.includes(key))))
  assert.equal(h.evaluate(),'app');assert.equal(h.render('/welcome').type,'Navigate')
 }else{assert.deepEqual(hydrated,{});assert.equal(h.evaluate(),'welcome');assert.equal(h.render('/welcome').type,'Outlet')}
})

nativeTest('native API hydration filters private atoms without relying on owner-state cleanup',async()=>{
 const privateValue={owner:'synthetic-private-owner'}
 const h=fixture.create({atoms:{...completedAtoms,'private-account-atom':privateValue}})
 // Do not call selectOwner: the host must filter an existing owner snapshot.
 const hydrated=JSON.parse(JSON.stringify(await h.hydrate()))
 assert.equal(hydrated['private-account-atom'],undefined)
 assert.deepEqual(h.globalState.get(atomsKey)['private-account-atom'],privateValue)
 if(fixture.preservesSharedApiAtoms){
  assert.equal(hydrated[completionKey],true)
  const principal={accountId:'synthetic-account',userId:'synthetic-user'}
  h.setPrincipal(principal);h.setPendingAccountChange(Promise.resolve())
  const pending=JSON.parse(JSON.stringify(await h.hydrate()))
  assert.equal(pending['private-account-atom'],undefined)
  assert.equal(pending[completionKey],true)
  assert.equal(h.globalState.get(ownerKey).owner,'synthetic-owner','Pending account changes must not select the cached owner')
 }
})

nativeTest('native direct welcome redirects home when shared completion is restored despite pending=true',async()=>{
 const h=fixture.create({atoms:completedAtoms});await h.hydrate();await h.login()
 assert.equal(h.navigation.at(-1),'/welcome');assert.equal(h.persisted.TB('electron:onboarding-welcome-pending'),true)
 const writes=h.publishes.length,result=restore(h).synchronize(receipt,()=>true)
 assert.equal(result.ready,true);assert.equal(h.evaluate(),'app')
 assert.deepEqual(JSON.parse(JSON.stringify(h.render('/welcome'))),{type:'Navigate',props:{to:'/',replace:true}})
 assert.equal(h.persisted.TB('electron:onboarding-welcome-pending'),true,'Do not clear welcome state to conceal the native cause')
 assert.equal(h.publishes.length,writes,'Projection must not republish or overwrite disk state')
})

nativeTest('native first API onboarding is preserved and genuine completion still persists without a principal',async()=>{
 const h=fixture.create();await h.hydrate();await h.login()
 assert.equal(restore(h).synchronize(undefined,()=>true).reason,'not-recorded')
 assert.equal(h.evaluate(),'welcome');assert.equal(h.render('/welcome').type,'Outlet')
 await h.complete(receipt.completedAt)
 assert.equal(h.globalState.get(atomsKey)[completionKey],true)
 assert.equal(h.globalState.get(atomsKey)[timeKey],receipt.completedAt)
 assert.equal(h.evaluate(),'app');assert.equal(h.navigation.at(-1),'/')
 await h.hydrate();assert.equal(h.evaluate(),fixture.preservesSharedApiAtoms?'app':'welcome')
 assert.equal(restore(h).synchronize(receipt,()=>true).ready,true);assert.equal(h.evaluate(),'app')
})

nativeTest('native global sharing never imports a role, permission or account-owned atom',async()=>{
 const roleKey='electron:onboarding-welcome-v2-role-state'
 const h=fixture.create({atoms:{...completedAtoms,[roleKey]:{roles:['finance'],workMode:'non_coding'},'permission-synthetic':true,'private-account-atom':{userId:'synthetic-owner'}}})
 h.selectOwner(null);await h.hydrate()
 h.persisted.JQ('native-live-unrelated',{preserve:true});const globalBefore=JSON.stringify(h.globalState.get(atomsKey))
 restore(h).synchronize(receipt,()=>true)
 assert.equal(h.persisted.TB(roleKey),undefined);assert.equal(h.persisted.TB('permission-synthetic'),undefined);assert.equal(h.persisted.TB('private-account-atom'),undefined)
 assert.deepEqual(h.persisted.TB('native-live-unrelated'),{preserve:true})
 assert.equal(JSON.stringify(h.globalState.get(atomsKey)),globalBefore)
 assert.equal(h.globalState.get(ownerKey).owner,null)
})

nativeTest('native explicit onboarding replay remains authoritative',async()=>{
 const h=fixture.create();await h.hydrate();h.persisted.JQ('electron:onboarding-override','welcome')
 assert.equal(restore(h).synchronize(receipt,()=>true).reason,'explicit-native-override')
 assert.equal(h.persisted.TB(completionKey),undefined);assert.equal(h.evaluate(),'welcome')
})

nativeTest('native loading and permission gates still win over existing completion',async()=>{
 const h=fixture.create();await h.hydrate();restore(h).synchronize(receipt,()=>true)
 assert.equal(h.evaluate({auth:{authMethod:'apikey',isLoading:true}}),null)
 assert.equal(h.evaluate({gatewayOAuthReadiness:'required'}),'login')
 assert.equal(h.evaluate({bedrockLoginPending:true}),'login')
 assert.equal(h.render('/welcome',{auth:{isLoading:true}}).type,'Loading')
})

nativeTest('projection waits for host hydration and never uses timeout or account transition state',async()=>{
 const h=fixture.create(),adapter=restore(h)
 assert.equal(adapter.synchronize(receipt,()=>true).reason,'awaiting-host-hydration')
 h.persisted.Ki('timeout');assert.equal(adapter.synchronize(receipt,()=>true).ready,false)
 await h.hydrate();assert.equal(adapter.synchronize(receipt,()=>false).reason,'identity-changed')
 assert.equal(h.persisted.TB(completionKey),undefined)
})

nativeTest('invalid and absent completion evidence cannot initialize first-use flags',async()=>{
 for(const evidence of [{projectlessCompleted:false,completedAt:1},{projectlessCompleted:true,completedAt:0},{projectlessCompleted:true,completedAt:-1},{projectlessCompleted:true,completedAt:1.2},{projectlessCompleted:true,completedAt:'123'},{projectlessCompleted:true,completedAt:Infinity},{projectlessCompleted:true,completedAt:253402300800}]){
 const h=fixture.create();await h.hydrate();assert.equal(restore(h).synchronize(evidence,()=>true).ready,false);assert.equal(h.persisted.TB(completionKey),undefined);assert.equal(h.publishes.length,0)
 }
})

nativeTest('native reset wins within a hydration while a later host empty-sync can be repaired',async()=>{
 const h=fixture.create();await h.hydrate();const adapter=restore(h)
 adapter.synchronize(receipt,()=>true);h.persisted.JQ(completionKey,false)
 assert.equal(adapter.synchronize(receipt,()=>true).reason,'native-reset-preserved');assert.equal(h.persisted.TB(completionKey),false)
 await h.hydrate();assert.equal(adapter.synchronize(receipt,()=>true).ready,true);assert.equal(h.persisted.TB(completionKey),true)
})

nativeTest('newer native completion is never replaced with an older receipt',async()=>{
 const h=fixture.create();await h.hydrate();h.persisted.JQ(timeKey,receipt.completedAt+100);h.persisted.JQ(completionKey,true)
 assert.equal(restore(h).synchronize(receipt,()=>true).reason,'native-completion-verified');assert.equal(h.persisted.TB(timeKey),receipt.completedAt+100);assert.equal(h.publishes.length,0)
})

nativeTest('unscoped native persistence needs no projection',async()=>{
 const h=fixture.create({accountScoped:false,atoms:completedAtoms});await h.hydrate()
 assert.equal(h.evaluate(),'app');assert.equal(restore(h).synchronize(receipt,()=>true).reason,'native-unscoped-persistence');assert.equal(h.publishes.length,0)
})

nativeTest('mode guard restores completion only under confirmed API identity through API/account/API cycle',async t=>{
 const mode=modes().createHarness(),native=fixture.create({atoms:completedAtoms})
 await native.hydrate();const bindings=discover(mode);bindings.localOnboarding=restore(native)
 let state={apiCodingModeEnabled:true,apiLocalOnboarding:receipt}
 const guard=guardFactory(bindings,{getState:()=>state,eventTarget:null});t.after(()=>guard.dispose())
 await guard.refresh();assert.equal(guard.status().ready,true);assert.equal(guard.status().localOnboarding.ready,true);assert.equal(native.evaluate(),'app')
 mode.setIdentity({accountId:'synthetic-account',userId:'synthetic-user',authMethod:'chatgpt',stableId:'synthetic-device'})
 await native.hydrate();native.persisted.JQ(completionKey,undefined);await guard.refresh();assert.equal(native.persisted.TB(completionKey),undefined,'Stale backend API state must not restore under native ChatGPT auth')
 mode.setIdentity({accountId:null,userId:null,authMethod:'apikey',stableId:'synthetic-device'});await guard.refresh();assert.equal(native.evaluate(),'app')
 state={apiCodingModeEnabled:false,apiLocalOnboarding:receipt};await native.hydrate();native.persisted.JQ(completionKey,undefined);await guard.refresh();assert.equal(native.persisted.TB(completionKey),undefined)
})


nativeTest('immutable native service facades still restore completed API onboarding and verify Coding',async t=>{
 for(const frozen of ['both','publisher','settings']) {
 const mode=modes().createHarness(),native=fixture.create({atoms:completedAtoms});await native.hydrate()
 const services=mode.module.__webpack_require__.c.GaA7.exports.appServices
 const settings={read:mode.settings.read.bind(mode.settings),write:mode.settings.write.bind(mode.settings)}
 const access={publish:mode.settings.publish.bind(mode.settings)}
 if(frozen!=='publisher')Object.freeze(settings)
 if(frozen!=='settings')Object.freeze(access)
 services.settings=settings;services.workModeAccess=access
 const originals={write:settings.write,publish:access.publish},bindings=discover(mode);bindings.localOnboarding=restore(native)
 const guard=guardFactory(bindings,{getState:()=>({apiCodingModeEnabled:true,apiLocalOnboarding:receipt}),eventTarget:null});t.after(()=>guard.dispose())
 await guard.refresh()
 assert.equal(guard.status().ready,true,guard.status().error);assert.equal(guard.status().serviceMode,'native-observer')
 assert.equal(native.evaluate(),'app');assert.equal(native.render('/welcome').type,'Navigate')
 assert.equal((await settings.read('conversationDetailMode')).configured,'STEPS_COMMANDS')
 assert.equal(settings.write,originals.write);assert.equal(access.publish,originals.publish)
 mode.scope.set(bindings.optimisticDescriptor,{detailLevel:'STEPS_PROSE'})
 assert.equal(guard.status().ready,false,'A live native PROSE selection invalidates ready immediately')
 await settings.write('conversationDetailMode','STEPS_PROSE');await guard.refresh()
 assert.equal((await settings.read('conversationDetailMode')).configured,'STEPS_COMMANDS')
 assert.equal(guard.status().ready,true)
 }
})

nativeTest('immutable observer does not report success when native mode writes fail',async t=>{
 const mode=modes().createHarness(),services=mode.module.__webpack_require__.c.GaA7.exports.appServices
 mode.settings.store.setAndPersist=()=>Promise.reject(Error('synthetic native write failure'))
 services.settings=Object.freeze({read:mode.settings.read.bind(mode.settings),write:mode.settings.write.bind(mode.settings)})
 services.workModeAccess=Object.freeze({publish:mode.settings.publish.bind(mode.settings)})
 const guard=guardFactory(discover(mode),{getState:()=>({apiCodingModeEnabled:true}),eventTarget:null});t.after(()=>guard.dispose())
 await guard.refresh();assert.equal(guard.status().ready,false);assert.match(guard.status().error,/synthetic native write failure/)
})


nativeTest('real native RPC proxies restore API completion and Coding without assigning methods',async t=>{
 const mode=modes().createHarness(),native=fixture.create({atoms:completedAtoms});await native.hydrate()
 const services=mode.module.__webpack_require__.c.GaA7.exports.appServices
 const calls=[]
 services.settings=fixture.rpcFacade({read:async key=>{calls.push('read');return mode.settings.read(key)},write:async(key,value)=>{calls.push('write');return mode.settings.write(key,value)}})
 services.workModeAccess=fixture.rpcFacade({publish:async payload=>{calls.push('publish');return mode.settings.publish(payload)}})
 assert.notEqual(services.settings.write,services.settings.write,'Native methods really are fresh RpcPromise proxies')
 assert.notEqual(services.workModeAccess.publish,services.workModeAccess.publish)
 assert.notEqual(services.workModeAccess.publish.call,Function.prototype.call,'RPC .call is another remote path, not the builtin Function.call')
 assert.throws(()=>{services.settings.write=()=>{}},/Can't assign properties/)
 const bindings=discover(mode);bindings.localOnboarding=restore(native)
 const guard=guardFactory(bindings,{getState:()=>({apiCodingModeEnabled:true,apiLocalOnboarding:receipt}),eventTarget:null});t.after(()=>guard.dispose())
 await guard.refresh()
 assert.equal(guard.status().ready,true,guard.status().error);assert.equal(guard.status().serviceMode,'native-observer')
 assert.equal(guard.status().localOnboarding.ready,true);assert.equal(native.render('/welcome').type,'Navigate')
 assert.equal((await services.settings.read('conversationDetailMode')).configured,'STEPS_COMMANDS')
 assert.ok(calls.includes('publish'));assert.ok(calls.filter(value=>value==='read').length>=2)
 await services.settings.write('conversationDetailMode','STEPS_PROSE')
 mode.scope.set(bindings.optimisticDescriptor,{detailLevel:'STEPS_PROSE'})
 assert.equal(guard.status().ready,false);await guard.refresh();assert.equal(guard.status().ready,true,guard.status().error)
 assert.deepEqual(await services.settings.read('conversationDetailMode'),{configured:'STEPS_COMMANDS',effective:'STEPS_COMMANDS'})
 await guard.dispose()
 assert.equal(mode.settings.workModeAccessByAccount[0].policy,'preference','Disposal restores the original real API policy through the RPC proxy')
})


nativeTest('real native RPC rejection keeps API mode unverified',async t=>{
 const mode=modes().createHarness(),services=mode.module.__webpack_require__.c.GaA7.exports.appServices
 services.settings=fixture.rpcFacade({read:async key=>mode.settings.read(key),write:async(key,value)=>mode.settings.write(key,value)})
 services.workModeAccess=fixture.rpcFacade({publish:async()=>{throw Error('synthetic native RPC rejection')}})
 const guard=guardFactory(discover(mode),{getState:()=>({apiCodingModeEnabled:true}),eventTarget:null});t.after(()=>guard.dispose())
 await guard.refresh();assert.equal(guard.status().ready,false);assert.match(guard.status().error,/synthetic native RPC rejection/)
 assert.equal(mode.events.length,0)
})


nativeTest('real native RPC delayed read cannot verify a retired API identity',async t=>{
 const mode=modes().createHarness(),services=mode.module.__webpack_require__.c.GaA7.exports.appServices
 let releaseRead,readStarted
 const waiting=new Promise(resolve=>{releaseRead=resolve}),started=new Promise(resolve=>{readStarted=resolve})
 services.settings=fixture.rpcFacade({read:async key=>{readStarted();await waiting;return mode.settings.read(key)},write:async(key,value)=>mode.settings.write(key,value)})
 services.workModeAccess=fixture.rpcFacade({publish:async payload=>mode.settings.publish(payload)})
 const guard=guardFactory(discover(mode),{getState:()=>({apiCodingModeEnabled:true}),eventTarget:null});t.after(()=>guard.dispose())
 const refreshing=guard.refresh();await started
 mode.setIdentity({accountId:'synthetic-account',userId:'synthetic-user',authMethod:'chatgpt',stableId:'synthetic-device'})
 releaseRead();await refreshing
 assert.equal(guard.status().ready,false);assert.equal(mode.events.length,0)
})
