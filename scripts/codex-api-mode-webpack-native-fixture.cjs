const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const vm = require('node:vm')
const asar = require('@electron/asar')
const ts = require('typescript')

// The 26.1111 renderer imports browser auth only for side effects at these two
// desktop call sites. Do not load that implementation or simulate credentials.
function reviewBrowserAuthImports(records, factorySources) {
  const owners = []
  for (const {node, tree} of records) {
    const loader = node.parameters[2].name.getText(tree)
    function visit(child) {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === loader
          && child.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === 'Au4v')) {
        let expression = child
        while (ts.isBinaryExpression(expression.parent) && expression.parent.operatorToken.kind === ts.SyntaxKind.CommaToken) expression = expression.parent
        assert.ok(child.arguments.length === 1 && ts.isExpressionStatement(expression.parent)
          && expression.parent.parent === node.body, 'Browser auth import must be unused at module initialization')
        owners.push(node.name.getText(tree))
      }
      ts.forEachChild(child, visit)
    }
    visit(node.body)
  }
  if (!owners.length) return false
  assert.deepEqual(owners.sort(), ['CWeU', 'T8X0'], 'Unreviewed browser auth import sites')
  // An unused import can still execute initialization. Pin the actual factory,
  // not just its module ID, before substituting the desktop-only test boundary.
  const sources = factorySources()
  assert.equal(sources.length, 1, 'Expected one reviewed browser auth factory')
  assert.equal(createHash('sha256').update(sources[0]).digest('hex'),
    '2ef5557aa8e57ffc5792997871cfd601c91b8a2cd9957c86e6cb28a2cebffd19', 'Unreviewed browser auth initialization')
  return true
}

// Read installed code, but execute only these reviewed leaf modules against
// in-memory services. No application entry, real IPC, credentials or files run.
function nativeWebpackApiFixture(packagePath) {
  const files = asar.listPackage(packagePath).map(name => name.replace(/^[\\/]/, ''))
  const sources = new Map(), modules = new Map()
  const read = file => { if (!sources.has(file)) sources.set(file, asar.extractFile(packagePath, file).toString()); return sources.get(file) }
  const renderer = files.filter(file => /^webview[\\/]assets[\\/]/.test(file) && file.endsWith('.js'))
  const modeFiles = renderer.filter(file => { const text=read(file); return text.includes('previousThreadDetailLevel:') && text.includes('authenticatedAccountId:') })
  assert.equal(modeFiles.length,1,'Expected installed native mode module chunk')
  function parseModules(file, collect = (id, record) => modules.set(id, record)) {
    const tree=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
    function visit(node) { if(ts.isMethodDeclaration(node)&&node.body&&node.parameters.length===3&&ts.isObjectLiteralExpression(node.parent)) {
      collect(node.name.getText(tree).replace(/^"|"$/g,''),{source:node.getText(tree),node,tree,file})
    } ts.forEachChild(node,visit) } visit(tree)
  }
  parseModules(modeFiles[0])
  const one=(items,label)=>{assert.equal(items.length,1,label);return items[0]}
  const bySource=(predicate,label)=>one([...modules.values()].filter(record=>predicate(record.source)),label)
  const setter=bySource(s=>s.includes('previousThreadDetailLevel:')&&s.includes('{optimistic:!1}'),'native setter module')
  const policy=bySource(s=>s.includes('workModeAccess!=null')&&s.includes('"preference":"everyday"'),'native policy module')
  const auth=bySource(s=>s.includes('accountLoading:!0,accountStructure:null,accountUserId:')&&s.includes('authenticatedAccountId:'),'native auth module')
  const access=bySource(s=>s.includes('accountInfoError:!1,accountInfoLoading:!0,authLoading:!0,authMethod:null,plan:null,supportedSurface:!0,workCloudSupportedSurface:!0'),'native access module')
  const statsig=bySource(s=>s.includes('getFeatureGate')&&s.includes('checkGate')&&s.includes('"values_updated"')&&/let [\w$]+=\(0,[\w$]+\.[\w$]+\)\([\w$]+\.[\w$]+,null\)/.test(s),'native identity module')
  const product=bySource(s=>s.includes('home-composer-mode-v1')&&s.includes('"codex"!==t'),'native product mode switch')
  const sidebar=bySource(s=>s.includes('sidebarProductModeAccountKey:')&&s.includes('"work":"codex"'),'native sidebar product selector')
  const records=[setter,policy,auth,access,statsig,product,sidebar]
  const ids=records.map(record=>record.node.name.getText(record.tree).replace(/^"|"$/g,''))
  assert.deepEqual(ids,['qixt','r8WG','CWeU','eFn4','OMIV','T8X0','pasN'],'Unreviewed installed mode module closure requires review')
  const browserAuthUnused = reviewBrowserAuthImports(records, () => {
    const sources = []
    for (const file of renderer) {
      if (/(?:^|[,{])\s*"?Au4v"?\s*\(/.test(read(file))) {
        parseModules(file, (id, record) => { if (id === 'Au4v') sources.push(record.source) })
      }
    }
    return sources
  })
  const controlFiles=renderer.filter(file=>read(file).includes('sidebarElectron.productMode.work.description.recommended'))
  const controlSources=[]
  for(const file of controlFiles){const tree=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);function visit(node){if(ts.isFunctionDeclaration(node)&&node.body){const source=node.getText(tree);if(source.includes('sidebarElectron.productMode.trigger')&&source.includes('sidebarElectron.productMode.work.description.recommended')&&source.includes('sidebarElectron.productMode.codex.description.developer'))controlSources.push(source)}ts.forEachChild(node,visit)}visit(tree)}
  const controlSource=one(controlSources,'native product mode UI component')
  const controlType=vm.runInThisContext('('+controlSource+')')
  const mainFile=one(files.filter(file=>/\.vite[\\/]build[\\/].*\.js$/.test(file)&&read(file).includes('workModeAccessByAccount=[]')),'native settings chunk')
  const mainTree=ts.createSourceFile(mainFile,read(mainFile),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  const classes=[],functions=[]
  function visitMain(node){if(ts.isFunctionDeclaration(node))functions.push(node);if((ts.isClassDeclaration(node)||ts.isClassExpression(node))&&node.members.some(member=>member.name?.getText(mainTree)==='getEffective'&&member.getText(mainTree).includes('workModeAccessByAccount')))classes.push(node);ts.forEachChild(node,visitMain)}visitMain(mainTree)
  const settingsClass=one(classes,'native settings class')
  const methods=Object.fromEntries(['getEffective','read','write','publish','applyWriteSideEffects'].map(name=>[name,one(settingsClass.members.filter(member=>member.name?.getText(mainTree)===name),'native '+name).getText(mainTree)]))
  const identityName=/\.find\([\w$]+=>([\w$]+)\([\w$]+\.identity,[\w$]+\)\)/.exec(methods.getEffective)?.[1]
  const identitySource=one(functions.filter(node=>node.name?.text===identityName),'native identity comparator').getText(mainTree)
  assert.match(identitySource,/authMethod/);assert.match(identitySource,/stableId/)
  const meta=/===([\w$]+)\.([\w$]+)\.conversationDetailMode\.key/.exec(methods.getEffective)
  const validate=/\(0,[\w$]+\.([\w$]+)\)\(e,/.exec(methods.getEffective)?.[1]
  const auto=/===([\w$]+)\.([\w$]+)\.autoArchiveAfterDays\.key/.exec(methods.getEffective)
  const link=/===([\w$]+)\.([\w$]+)\.openLinkInTargetPreference\.key/.exec(methods.getEffective)
  const linkFunction=/\(e,([\w$]+)\(this\.store\)\)/.exec(methods.getEffective)?.[1]
  const schema=/let [\w$]+=([\w$]+)\.parse\(/.exec(methods.publish)?.[1]
  assert.ok(meta&&auto&&link&&validate&&linkFunction&&schema,'Reviewed native settings imports')
  const createSettings=new Function('identity','initial',[
    'const modeKey="conversationDetailMode";',
    'const '+meta[1]+'='+JSON.stringify({[meta[2]]:{conversationDetailMode:{key:'conversationDetailMode'}},[auto[2]]:{autoArchiveAfterDays:{key:'autoArchiveAfterDays'}},[link[2]]:{openLinkInTargetPreference:{key:'openLinkInTargetPreference'}}})+';',
    meta[1]+'.'+validate+'=(key,value)=>value;',
    'const '+schema+'={parse:value=>{if(!["coding","everyday","preference"].includes(value.policy))throw Error("Invalid policy");return {...value}}};',
    'const '+linkFunction+'=()=>null;',identitySource,
    'const nativeMethods={'+Object.values(methods).join(',')+'};',
    'const values=new Map([[modeKey,initial]]),events=[];let owner=identity;',
    'const settings=Object.assign({store:{get:key=>values.get(key),getEffective:key=>values.get(key),setAndPersist:(key,value)=>{values.set(key,value);events.push({key,value});return Promise.resolve()}},statsig:{readExecutionAssignments:async()=>owner?{identity:owner}:null},afterWrite:()=>{},logger:()=>({warning(){}}),workModeAccessByAccount:[],workModeAccessListeners:new Set()},nativeMethods);return {settings,events,setIdentity:value=>{owner=value}};'
  ].join('\n'))

  function createHarness({authMethod='apikey',identity={accountId:null,userId:null,authMethod:'apikey',stableId:'synthetic-device'},configured='STEPS_PROSE'}={}) {
    const appScope={__scopeBrand:'AppScope',id:Symbol('AppScope')}, values=new Map(), allDescriptors=[]
    const descriptor=initializer=>{const value={scope:appScope,resolve(){},initializer};allDescriptors.push(value);return value}
    const native=createSettings(identity,configured), {settings}=native
    const homeDescriptor=descriptor('work')
    const scope={scope:appScope,node:{},chain:new Map(),query:{snapshot(){}},get(value,...args){if(values.has(value))return values.get(value);if(typeof value?.initializer==='function')return value.initializer({get:scope.get.bind(scope),set:scope.set.bind(scope),scope},...args);return value?.initializer},set(value,next){values.set(value,typeof next==='function'?next(scope.get(value)):next)}}
    scope.chain.set(appScope.id,scope.node)
    const primitive={vP:(owner,initial)=>descriptor(initial),un:(owner,initial)=>descriptor(initial),SZ:(owner,initial)=>descriptor(initial),bD:(owner,initial)=>descriptor(ctx=>initial('',ctx)),i1:(owner,initial)=>descriptor(ctx=>initial('',ctx)),vU:(owner,initial)=>descriptor(()=>({data:undefined,isPending:false,isError:false})),Y:(owner,run)=>run(),Ul(){throw Error('Native hook must not execute')},gh(){throw Error('Native hook must not execute')}}
    const methods=Object.fromEntries(records.map(record=>[record.node.name.getText(record.tree).replace(/^"|"$/g,''),vm.runInThisContext('({'+record.source+'})')[record.node.name.getText(record.tree).replace(/^"|"$/g,'')]]))
    const cache=Object.create(null), stubs={
      zTeN:primitive,Hl6a:primitive,OWtl:{u:appScope},GaA7:{appServices:{settings,workModeAccess:settings}},
      i4d2:{G(){}},kpIY:{TB:()=>undefined},Nwp9:{m3:key=>{assert.equal(key,'home-composer-mode-v1');return homeDescriptor}},
      Rz6g:{},RsWy:{},ASxG:{object(){},number:()=>({})},ZhRn:{},Gguf:{},
      XtQu:{d:descriptor({data:null})},pdFc:{MK:()=>{throw Error('Unreviewed role fallback')}},bdDz:{$T:descriptor(null)},khOd:{GB:descriptor(false)},
      QosV:{},iRMi:{CodexSettingsWorkModeSelected:'mode-selected'},zd8w:{},ChYf:{},yGJW:{YV:descriptor(()=>({logProductEvent(){}}))},
      DBCl:{ubS:{conversationDetailMode:{key:'conversationDetailMode'}}},
      RxZZ:{gc:async(owner,key,value)=>{await settings.write(key.key,value)},g4:(get,key)=>settings.store.get(key.key),CN:(get,key)=>settings.store.get(key.key),Oe:descriptor(false),dW:descriptor(true)},
      X1mr:{},qhRx:{},rvFo:{D:{ONE_MINUTE:60000}},LjYy:{x:{FREE:'free',GO:'go'}},eShZ:{},Ietk:{j8:descriptor('ready')},SPnB:{},
      gb5j:{on:()=>null,M9:descriptor(null),yt:descriptor(null),wx:descriptor(null)},Qg7S:{z:()=>false},cX6x:{wc:()=>null},
    }
    if (browserAuthUnused) stubs.Au4v = new Proxy(Object.freeze({}), {get(){throw Error('Browser auth is unavailable in the desktop fixture')}})
    function requireNative(id){if(cache[id])return cache[id].exports;if(Object.hasOwn(stubs,id)){cache[id]={exports:stubs[id]};return stubs[id]}if(!methods[id])throw Error('Unreviewed native dependency '+id);const entry={exports:{}};cache[id]=entry;methods[id](entry,entry.exports,requireNative);return entry.exports}
    requireNative.d=(target,getters,constants)=>{for(const[key,get]of Object.entries(getters))Object.defineProperty(target,key,{enumerable:true,get});for(const[key,value]of Object.entries(constants||{}))Object.defineProperty(target,key,{enumerable:true,value})}
    requireNative.m=methods;requireNative.c=cache
    for(const id of ids)requireNative(id)
    const realAuth=cache.CWeU.exports.PO,input=cache.eFn4.exports.$S,stats=cache.OMIV.exports.M9
    const setIdentity=(next,method=next?.authMethod)=>{native.setIdentity(next);scope.set(realAuth,{authMethod:method,authLoading:false,accountId:next?.accountId??null,authenticatedAccountId:next?.accountId??null,hasChatGptToken:method==='chatgpt'});scope.set(input,{accountId:next?.accountId??null,accountInfoError:false,accountInfoLoading:false,authLoading:false,authMethod:method,plan:method==='chatgpt'?'plus':null,supportedSurface:true,workCloudSupportedSurface:true});scope.set(stats,{getContext:()=>({user:{userID:next?.userId??null,customIDs:{account_id:next?.accountId??null,stableID:next?.stableId??null},custom:{auth_method:method}}}),getFeatureGate:()=>({value:false,details:{reason:'synthetic'}}),checkGate:()=>false})}
    setIdentity(identity,authMethod)
    const root={stateNode:{}},scopeFiber={memoizedState:{memoizedState:{current:scope}},return:root};root.child=scopeFiber;root.stateNode.current=root
    const element={__reactContainer$fixture:root},document={documentElement:null,body:null,getElementById:()=>element,querySelectorAll:()=>[]}
    return {module:{__webpack_require__:requireNative},scope,document,values,settings,events:native.events,setIdentity,descriptors:{realAuth,input,stats},productMode:{setProduct:cache.T8X0.exports.Ct,sidebarDescriptor:cache.pasN.exports.l,workEnabled:cache.qixt.exports.e2,homeDescriptor},controlType,sources:{product:product.source,sidebar:sidebar.source,setter:setter.source,policy:policy.source,auth:auth.source,access:access.source},root}
  }
  return {format:'webpack',packageVersion:JSON.parse(asar.extractFile(packagePath,'package.json').toString()).version,createHarness,settingsSources:methods,rendererSources:records.map(record=>record.source),mainFile}
}
module.exports={nativeWebpackApiFixture,reviewBrowserAuthImports}
