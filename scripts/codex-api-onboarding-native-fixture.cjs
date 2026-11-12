const assert = require('node:assert/strict')
const vm = require('node:vm')
const asar = require('@electron/asar')
const ts = require('typescript')
const { createHash } = require('node:crypto')

// Only reviewed native leaf functions run, with in-memory storage/IPC and
// synthetic identities. No Electron entry, credential reader or real file write.
function nativeOnboardingFixture(packagePath) {
  const files = asar.listPackage(packagePath).map(name => name.replace(/^[\\/]/, ''))
  const sources = new Map()
  const read = file => { if (!sources.has(file)) sources.set(file, asar.extractFile(packagePath, file).toString()); return sources.get(file) }
  const one = (values, label) => { assert.equal(values.length, 1, label); return values[0] }
  const renderer = files.filter(file => /^webview[\\/]assets[\\/]/.test(file) && file.endsWith('.js'))
  const modules = new Map()
  const parse = file => {
    const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const visit = node => { if (ts.isMethodDeclaration(node) && node.parameters.length === 3 && ts.isObjectLiteralExpression(node.parent)) {
      modules.set(node.name.getText(tree).replace(/^"|"$/g, ''), {source:node.getText(tree), node, tree, file})
    } ts.forEachChild(node, visit) }; visit(tree); return tree
  }
  for (const file of renderer) { const text=read(file); if (text.includes('Persisted atom store accessed before initialization')
      || text.includes('backendOnboardingCompleted:') || text.includes('.loginWithApiKey(')
      || text.includes('postLoginWelcomePending:') || text.includes('RpcStub constructor expected')) parse(file) }
  const get = id => { assert.ok(modules.has(id), 'Reviewed native module '+id); return modules.get(id) }
  const selectNodes = (record, predicate) => { const values=[]; const visit=node=>{ if(predicate(node,node.getText(record.tree)))values.push(node.getText(record.tree)); ts.forEachChild(node,visit) };visit(record.node);return values }
  const gateCandidates=selectNodes(get('bREQ'),(n,s)=>ts.isFunctionExpression(n)&&s.includes('backendOnboardingCompleted:'))
  const gateSource=one(gateCandidates.filter(s=>s.length<1500),'native route gate')
  const renderSource=one(gateCandidates.filter(s=>s.length>1500),'native route rendering component')
  const loginSource=one(selectNodes(get('EwXL'),(n,s)=>ts.isArrowFunction(n)&&s.includes('.loginWithApiKey(')&&s.includes('new AbortController')),'native API login callback')
  const completeSource=one(selectNodes(get('WIYk'),(n,s)=>ts.isArrowFunction(n)&&s.startsWith('async()=>')&&s.includes('n.set(f.IF,!0)')&&s.length<3000),'native completion continuation')
  const main=files.filter(file=>/\.vite[\\/]build[\\/].*\.js$/.test(file))
  const mainMethods={}
  for(const marker of ['async sendPersistedAtomState(', 'get hasAccountScopedRendererState']) {
    const file=one(main.filter(file=>read(file).includes(marker)),'native main '+marker)
    const tree=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
    const names=new Set(['sendPersistedAtomState','updatePersistedAtomState','selectRendererOwner','hasAccountScopedRendererState'])
    const visit=node=>{if((ts.isMethodDeclaration(node)||ts.isGetAccessorDeclaration(node))&&names.has(node.name?.getText(tree)))mainMethods[node.name.getText(tree)]=node.getText(tree);ts.forEachChild(node,visit)};visit(tree)
  }
  for(const name of ['sendPersistedAtomState','updatePersistedAtomState','selectRendererOwner','hasAccountScopedRendererState'])assert.ok(mainMethods[name],name)
  const sharedFile=one(main.filter(file=>read(file).includes('LAST_COMPLETED_ONBOARDING:"last_completed_onboarding",PROJECTLESS_ONBOARDING_COMPLETED:')),'native shared persistence key declaration')
  const sharedSource=one([...read(sharedFile).matchAll(/\{LAST_COMPLETED_ONBOARDING:"last_completed_onboarding",PROJECTLESS_ONBOARDING_COMPLETED:[^}]+\}/g)].map(m=>m[0]),'native global shared whitelist')
  const sharedKeys=Object.values(vm.runInNewContext('('+sharedSource+')'))
  const globalKeySource=one([...new Set(main.flatMap(file=>[...read(file).matchAll(/\{OPEN_IN_TARGET_PREFERENCES:"open-in-target-preferences"[^{}]+\}/g)].map(match=>match[0])))], 'native account-scoped global keys')
  const globalKeys=vm.runInNewContext('('+globalKeySource+')')
  const completionKey='electron:onboarding-projectless-completed', timeKey='last_completed_onboarding', atomsKey='electron-persisted-atom-state', ownerKey='electron-account-renderer-state-v1'
  // 26.1103.60933 keeps shared onboarding atoms when no account principal is
  // available. Older reviewed builds sent an empty atom map in that branch.
  const preservesSharedApiAtoms = mainMethods.sendPersistedAtomState.includes('renderersWithoutAccountState.add')
  if (preservesSharedApiAtoms) {
    assert.ok(mainMethods.sendPersistedAtomState.includes('getPendingAccountChange()'))
    assert.ok(mainMethods.sendPersistedAtomState.includes('getCachedAuthenticatedPrincipal()'))
    assert.ok(mainMethods.sendPersistedAtomState.includes('Object.entries(n).filter(([e])=>Wk.kg.has(e))'))
  }
  const moduleRecords=[]
  function instantiateModule(id, dependencies, context={}) {
    const record=get(id), exports={}
    const req=name=>{ assert.ok(Object.hasOwn(dependencies,name),'Unreviewed native dependency '+name); return dependencies[name] }
    req.d=(target,getters,values)=>{for(const [key,get]of Object.entries(getters||{}))Object.defineProperty(target,key,{enumerable:true,get});Object.assign(target,values)}
    const factory=vm.runInNewContext('({'+record.source+'})['+JSON.stringify(id)+']',context)
    factory({},exports,req);moduleRecords.push({source:record.source,exports});return exports
  }
  function create({atoms={}, accountScoped=true, principal=null, syntheticOwner='synthetic-owner', globals={}, deferPublishes=false}={}) {
    const publishes=[], messages=[], navigation=[], pendingPublishes=[]
    const data=new Map([...Object.entries(globals),[atomsKey,{...atoms}],...(accountScoped?[[ownerKey,{owner:syntheticOwner,inactive:{}}]]:[])])
    const globalState={state:data,rendererAccountGeneration:0,storedOwnerGeneration:0,changeListeners:new Map(),get:key=>data.get(key)??null,set:(key,value)=>data.set(key,value)}
    const sharedAtoms=new Set(sharedKeys)
    const ownerDigest=value=>createHash('sha256').update(JSON.stringify([value.userId,value.accountId])).digest('hex')
    const stateDeps={m:ownerKey,R:atomsKey,b:sharedAtoms,u:{nh0:Object.values(globalKeys)},y:ownerDigest,
      g:{ac:ownerKey,kg:sharedAtoms,Iz:ownerDigest},k:atomsKey}
    // Native owner selection writes some maps directly through state.state.set.
    // Execute its reviewed source in the host realm so real RPC serialization
    // sees normal main-process objects even before any renderer has published.
    const stateMethods=vm.runInThisContext('(function('+Object.keys(stateDeps).join(',')+'){return {'+mainMethods.selectRendererOwner+','+mainMethods.hasAccountScopedRendererState+'}})')(...Object.values(stateDeps))
    Object.defineProperties(globalState,Object.getOwnPropertyDescriptors(stateMethods))
    const win={localStorage:{length:0,getItem:()=>null,removeItem:()=>{}},electronBridge:{getInitialSidebarBootstrap:()=>({accountScopedPersistence:accountScoped})}}
    const persisted=instantiateModule('kpIY',{'waIq':{m:()=>{throw Error('No record merge expected')}},'owEK':{Uy:'synthetic-custom-sections'}},{window:win,setTimeout,clearTimeout})
    let currentPrincipal=principal, pendingAccountChange=null
    const mainHandler={globalState,windowManager:{accountWindows:{generation:0,isCovered:()=>false,renderersWithoutAccountState:new Set()},shouldSyncPersistedAtom:()=>true},
      browserHostManager:{isPrimaryWindowPersistenceOwner:()=>true},getAppServerConnection:()=>({getRequestAuthenticatedPrincipal:async()=>currentPrincipal,getCachedAuthenticatedPrincipal:()=>currentPrincipal,getPendingAccountChange:()=>pendingAccountChange}),
      sendMessageToView:(_,message)=>messages.push(message),chunkedMessageSender:{sendCritical:(_,channel,message)=>messages.push(message)},
      broadcastPersistedAtomUpdate:(_,key,value)=>persisted.JQ(key,value)}
    Object.assign(mainHandler,vm.runInNewContext('({'+mainMethods.sendPersistedAtomState+','+mainMethods.updatePersistedAtomState+'})',{$U:()=>false,$u:{yz:'synthetic-reserved-key'},$$:()=>false,$w:{yz:'synthetic-reserved-key'},Wk:{kg:sharedAtoms},op:{eQ:'synthetic-channel'}}))
    const scope={get:key=>persisted.TB(key),set:(key,value)=>persisted.jx(key,value)}
    const publish=(key,value)=>{publishes.push({key,value});if(deferPublishes)pendingPublishes.push({key,value});else mainHandler.updatePersistedAtomState({},key,value)}
    const flushPublishes=()=>{for(const {key,value}of pendingPublishes.splice(0))mainHandler.updatePersistedAtomState({},key,value)}
    persisted.A2({},publish)
    const view={isDestroyed:()=>false}
    const hydrate=async()=>{await mainHandler.sendPersistedAtomState(view);const state=messages.at(-1)?.state;assert.ok(state);persisted.A2(state,publish);persisted.Ki('host');return state}
    const redirect=instantiateModule('eX9b',{'DBCl':{$kD:'/synthetic-exempt'},'e3vf':{E:dest=>dest}},{URLSearchParams})
    const gate=vm.runInNewContext('('+gateSource+')')
    const auth={authMethod:'apikey',hasChatGptToken:false,requiresAuth:true,isLoading:false,accountId:null,userId:null}
    const evaluate=(patch={})=>gate({auth,codexFeatureAccess:{status:'allowed'},backendOnboardingCompleted:false,isWorkspaceSwitchDestination:false,
      forcedOverride:persisted.TB('electron:onboarding-override','auto')==='auto'?null:persisted.TB('electron:onboarding-override',null),isOnboardingContextFetched:true,isOnboardingContextLoading:false,
      projectlessOnboardingCompleted:persisted.TB(completionKey,false),workspaceRootsData:{roots:[]},workspaceRootsIsLoading:false,workspaceRootsTimedOut:false,...patch})
    const render=(path='/welcome',patch={})=>{
      const atoms=new Map([['override',persisted.TB('electron:onboarding-override','auto')],['completed',persisted.TB(completionKey,false)],['previous',persisted.TB(completionKey,false)],
        ['roots',{isLoading:false,isPending:false,data:{roots:[]}}],['readiness','ready'],['featureAccess',{status:'allowed'}],['fetching',{isFetching:false}],['logReady',true]])
      const scopeHandle={get:key=>atoms.get(key),set:()=>{},watch:()=>()=>{}}
      const noop=()=>{},location={pathname:path,search:'',hash:''}
      const globals={c:{c:size=>Array(size).fill(Symbol.for('react.memo_cache_sentinel'))},u:{useContext:()=>false,useEffect:noop,useLayoutEffect:noop,useRef:()=>({current:false}),useState:()=>[undefined,noop]},
        E:{gh:()=>scopeHandle,Ul:key=>atoms.get(key)},j:{u:'scope'},A:{zy:()=>location,$P:noop,C5:'Navigate',sv:'Outlet'},tG:{As:()=>({...auth,...patch.auth})},tM:{A:()=>({formatMessage:noop})},tK:{wA:'context'},
        tL:{f2:'gateway',Kv:'gatewayState'},t1:{sW:'bedrock',sL:'continue'},t5:'verification',t7:'fetching',tD:{Zg:'readiness'},ez:{dE:()=>patch.featureAccess||{status:'allowed'}},
        tX:{Pk:'workspace',c0:'switch'},tq:{wD:()=>({data:null,isFetched:true,isLoading:false})},t8:{_m:'override',IF:'completed',$f:'previous'},ne:{U:'timedOut'},tN:{c:'logReady'},tJ:'cloudEnvironment',tW:{zk:'roots'},
        tH:{O1:{dispatchMessage:noop}},tz:{yy:noop},S:{CodexLoginPageViewed:'viewed'},t0:redirect,tZ:noop,i:{jsx:(type,props)=>({type,props})},tB:{c:'Loading'},t2:{o:'Verification'},t9:{m:'LoginRecovery'}}
      return vm.runInNewContext('('+renderSource+')',globals)()
    }
    const login=async()=>{
      const globals={e2:'synthetic-api-key',e6:false,eB:{},eL:{status:'ready',api:true},AbortController,e5:()=>{},c:{ls:()=>({loginWithApiKey:async()=>({type:'apiKey'})})},b:{fI:'local'},eS:scope,P:{yy:()=>{}},k:{CodexLoginSuccess:'success',CodexLoginFailure:'failure'},eA:false,e_:()=>{},eC:path=>navigation.push(path),eN:path=>path,ti:()=>{},L:{pi:'electron:onboarding-welcome-pending'},E:{Z:'synthetic-entrypoint'},eG:error=>{throw error},ev:String,a:{Rt_:String}}
      await vm.runInNewContext('('+loginSource+')',globals)()
    }
    const complete=async(seconds=1794134871)=>{
      const globals={N:'auto',n:scope,f:{_m:'electron:onboarding-override',pi:'electron:onboarding-welcome-pending',IF:completionKey,qk:'electron:onboarding-hide-first-new-thread-promos',Dh:(scope,time)=>scope.set(timeKey,time)},
        i:{accountId:null},y:{roles:['engineering'],workMode:'coding'},Date:{now:()=>seconds*1000},_:{x2:'synthetic-location'},e:undefined,t:'/',d:path=>navigation.push(path),M:null,a:null,W:()=>{}}
      await vm.runInNewContext('('+completeSource+')',globals)()
    }
    return {persisted,globalState,scope,publishes,messages,navigation,hydrate,login,complete,evaluate,render,flushPublishes,window:win,
      record:{source:get('kpIY').source,exports:persisted},setPrincipal:value=>{currentPrincipal=value},setPendingAccountChange:value=>{pendingAccountChange=value},selectOwner:principal=>globalState.selectRendererOwner(principal)}
  }
  const rpcRecord=get('Fkn8')
  assert.equal((rpcRecord.source.match(/\br\("/g)||[]).length,0,'Native RPC leaf must have no imported modules')
  const rpcExports={},rpcRequire=()=>{throw Error('Unreviewed RPC dependency')}
  rpcRequire.d=(target,getters,values)=>{for(const[key,get]of Object.entries(getters||{}))Object.defineProperty(target,key,{get,enumerable:true});Object.assign(target,values)}
  // Same-realm serialization is required by the real RpcStub's Object.prototype
  // checks; the target is local memory and no remote transport is constructed.
  vm.runInThisContext('({'+rpcRecord.source+'}).Fkn8')({},rpcExports,rpcRequire)
  const rpcFacade=methods=>{
    class LocalTarget extends rpcExports.TF {}
    for(const[key,method]of Object.entries(methods))LocalTarget.prototype[key]=method
    return new rpcExports.AX(new LocalTarget())
  }
  return {create,sharedKeys,completionKey,timeKey,atomsKey,ownerKey,gateSource,renderSource,rpcFacade,rpcExports,globalKeys,preservesSharedApiAtoms}
}
module.exports={nativeOnboardingFixture}
