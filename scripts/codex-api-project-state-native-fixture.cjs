const assert = require('node:assert/strict')
const vm = require('node:vm')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const asar = require('@electron/asar')
const ts = require('typescript')
const { nativeOnboardingFixture } = require('./codex-api-onboarding-native-fixture.cjs')

// Ask the host which global keys are actually partitioned, without querying
// a catalog, a conversation or a previous principal's storage.
function contentOwnerProjectBoundary(packagePath, onboarding = nativeOnboardingFixture(packagePath)) {
  const { globalKeys, ownerContract, rpcExports } = onboarding
  assert.ok(Array.isArray(ownerContract?.O), 'native content-owner scoped-key registry')
  const projectKeys = ['LOCAL_PROJECTS', 'THREAD_PROJECT_ASSIGNMENTS', 'PROJECTLESS_THREAD_IDS'].map(name => globalKeys[name])
  assert.ok(projectKeys.every(key => typeof key === 'string'), 'native project keys')
  const scoped = new Set(ownerContract.O)
  for (const name of ['WORKSPACE_ROOT_OPTIONS', 'WORKSPACE_ROOT_LABELS']) {
    assert.ok(scoped.has(globalKeys[name]), 'native scope registry covers ' + name)
  }
  const unscopedKeys = projectKeys.filter(key => !scoped.has(key))
  function nativeApplicationState(read, write) {
    const filename = path.join('.vite', 'build', 'early-bootstrap-331-29198f5b57adf59a.js')
    const source = asar.extractFile(packagePath, filename).toString()
    const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const found = []
    const visit = node => {
      if (ts.isClassDeclaration(node) && node.name?.text === 'KD') found.push(node.getText(tree))
      ts.forEachChild(node, visit)
    }
    visit(tree)
    assert.equal(found.length, 1, 'reviewed native application-state service')
    assert.equal(createHash('sha256').update(found[0]).digest('hex'),
      'd4fc10e2dbfc4b86a2ddc0e69b97ef25370b81dfac8e9dc400cc1165e7254e2b', 'unreviewed application-state service')
    const NativeService = vm.runInThisContext('(function(e0,e1){return (' + found[0] + ')})')(rpcExports, {Q2Y: globalKeys})
    return new rpcExports.AX(new NativeService(read, write))
  }
  return { onboarding, projectKeys, unscopedKeys, nativeApplicationState }
}

// Reviewed native main-process classes execute against memory. Schema/path
// primitives accept only synthetic validated inputs; no Electron entry point,
// auth reader, database, filesystem mutation or real network is executed.
function nativeProjectStateFixture(packagePath) {
  const packageVersion=JSON.parse(asar.extractFile(packagePath,'package.json').toString()).version
  assert.ok(['26.1103.32239','26.1103.60933'].includes(packageVersion),
    'Main-process project state is unverified on Codex '+packageVersion+'; this fixture requires a reviewed renderer owner and project RPC contract')
  const onboarding = nativeOnboardingFixture(packagePath)
  const files = asar.listPackage(packagePath).map(file => file.replace(/^[\\/]/, ''))
  const sources = files.filter(file => /\.vite[\\/]build[\\/].*\.js$/.test(file))
    .map(file => [file, asar.extractFile(packagePath, file).toString()])
  const classes = {}, functions = {}, methods = {}, modules = {}
  const modern=packageVersion==='26.1103.60933'
  const classMap=modern?{GW:'GB',DA:'DV',N5:'N6',efm:'efC',dE:'dE',ed4:'eua',ed8:'euo',eui:'eum',eul:'euy',eRW:'eRM'}:{GW:'GW',DA:'DA',N5:'N5',efm:'efm',dE:'dE',ed4:'ed4',ed8:'ed8',eui:'eui',eul:'eul',eRW:'eRW'}
  const classNames=new Set(Object.keys(classMap))
  const functionMap=modern?{ede:'edd',eRF:'eR_',ed5:'eus',eua:'euf',euo:'eub'}:{ede:'ede',eRF:'eRF',ed5:'ed5',sA:'sA',sS:'sS',sO:'sO',sE:'sE',sP:'sP',eua:'eua',euo:'euo'}
  const functionNames=new Set(Object.keys(functionMap))
  for (const [file, source] of sources.filter(([,source]) => source.includes('class GW ') || source.includes('class GB ') || source.includes('readMemberships()')
      || source.includes('return{assignment:') || source.includes('7715(e,t,r)'))) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const visit = node => {
      if(ts.isClassDeclaration(node)){for(const [canonical,name]of Object.entries(classMap)){if(node.name?.text===name&&(canonical!=='dE'||node.getText(tree).includes('readMemberships()')))classes[canonical]=node.getText(tree)}}
      if(ts.isFunctionDeclaration(node)){for(const [canonical,name]of Object.entries(functionMap)){if(node.name?.text===name)functions[canonical]=node.getText(tree)}}
      if (ts.isMethodDeclaration(node) && node.parent?.name?.text === (modern?'euN':'euk')
          && ['getLocalProjects', 'getLocalProjectsForRenderer', 'getLocalProjectsForDesktopState'].includes(node.name.getText(tree))) {
        methods[node.name.getText(tree)] = node.getText(tree)
      }
      if (ts.isMethodDeclaration(node) && node.name.getText(tree) === 'refreshAccountWindows'
          && node.getText(tree).includes((modern?'edc':'ec7')+'.get(e)')) methods.refreshAccountWindows = node.getText(tree)
      if (ts.isMethodDeclaration(node) && node.parameters.length === 3 && ts.isObjectLiteralExpression(node.parent)
          && ['39229','7715','63068'].includes(node.name.getText(tree))) modules[node.name.getText(tree) === '39229' ? 'catalog' : node.name.getText(tree)==='63068'?'merge':'rpc'] = node.getText(tree)
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  for (const key of classNames) assert.ok(classes[key], 'reviewed native class ' + key)
  for (const key of functionNames) assert.ok(functions[key], 'reviewed native function ' + key)
  for (const key of ['getLocalProjects', 'getLocalProjectsForRenderer', 'getLocalProjectsForDesktopState', 'refreshAccountWindows']) assert.ok(methods[key], key)
  assert.ok(modules.catalog, 'native catalog leaf module')
  const schema = new Proxy({}, { get: (_, key) => key === 'parse' ? value => value : key === 'safeParse'
    ? value => ({ success: value != null, data: value }) : () => schema })
  const schemaApi = new Proxy({}, { get: () => () => schema })
  let merge
  if(modern){
    assert.ok(modules.merge,'native membership merger module')
    const exports={},req=id=>{assert.equal(id,35553,'reviewed schema import');return schemaApi}
    req.d=(target,getters,values)=>{for(const [key,get]of Object.entries(getters||{}))Object.defineProperty(target,key,{get});Object.assign(target,values)}
    vm.runInThisContext('({'+modules.merge+'})[63068]')({},exports,req)
    merge={Ax_:exports.Ax,Mxp:exports.Mx,RWz:exports.RW}
  }else merge=vm.runInThisContext('(()=>{' + ['sA','sS','sO','sE','sP'].map(key => functions[key]).join(';') + ';return {Ax_:sA,Mxp:sS,RWz:sO}})()')
  const es = { ...merge, Q2Y: onboarding.globalKeys, b9: value => value ?? {}, DZs: value => value ?? {}, JXB: value => value,
    aSH: schema, JFB: () => true, OS5: value => value ?? {}, Lnj:schema, AvD:schema }
  const catalogExports = {}
  const req = id => id === 86697 ? path : id === (modern?16954:85452) ? es : assert.fail('Unexpected catalog dependency ' + id)
  req.n = value => () => value
  req.d = (target,getters,values) => { for (const [key,get] of Object.entries(getters || {})) Object.defineProperty(target,key,{get});Object.assign(target,values) }
  vm.runInThisContext('({' + modules.catalog + '})[39229]')({},catalogExports,req)
  const logger = { info(){}, warning(){}, debug(){} }
  const ei = {}
  const rpcRequire = () => { throw Error('Unexpected main RPC import') }; rpcRequire.d = req.d
  vm.runInThisContext('({' + modules.rpc + '})[7715]')({},ei,rpcRequire)
  const sameRealm = (source, context) => Function(...Object.keys(context), 'return ' + source)(...Object.values(context))
  const base = { es, ei, a:ei, B:es, d:schemaApi, eM:schemaApi, eX:catalogExports,
    sy:{n:'local',a:{}}, eu:{$Cz:()=>logger,vB9:()=>()=>logger}, eE:value=>value, eC:value=>value,
    esChunk:(items,size)=>Array.from({length:Math.ceil(items.length/size)},(_,index)=>items.slice(index*size,(index+1)*size)),
    AbortController,AbortSignal,structuredClone,Date,setTimeout,clearTimeout,Promise,Error }
  // The chunk helper is an imported collection primitive, not persistence.
  const NcW = sameRealm('(' + classes.dE + ')', {...base, j:es, es:()=>base.esChunk, dg:schema,dy:schema,d_:schema})
  base.eu.NcW = NcW
  const declarations = ['ed5','eua','euo'].map(key=>functions[key]).join(';') + ';'
    + ['ed4','ed8','eui','eul','GW','DA','N5','efm'].map(key=>classes[key]).join(';')
    + ';class Manager{#i2(){return false}constructor(state){this.globalState=state}' + Object.values(methods).filter(text=>!text.startsWith('refreshAccountWindows')).join(';') + '}'
    + ';return {'+['GW','DA','N5','efm','eui','eul'].map(key=>key+':'+classMap[key]).join(',')+',Manager}'
  const metadata=modern?{efI:schema,eul:'codex.chatGptBacking',euc:'codex.chatGptBackingCreation',eud:'codex.retiredChatGptBacking',euu:'codex.localProjectId',euh:Symbol('order'),eup:Symbol('restore')}:
    {efp:schema,ed6:'codex.chatGptBacking',ed7:'codex.chatGptBackingCreation',eue:'codex.retiredChatGptBacking',eut:'codex.localProjectId',eur:Symbol('order'),eun:Symbol('restore')}
  const native = sameRealm('(()=>{' + declarations + '})()', {...base,...metadata})
  function create({catalog={},memberships={assignments:{},projectlessThreadIds:[]},serverProjects=[],owner='official-before',gate=false,deferPublishes=false}={}) {
    const fixture = onboarding.create({globals:{'local-projects':catalog,'thread-project-assignments':memberships.assignments,'projectless-thread-ids':memberships.projectlessThreadIds},syntheticOwner:owner,deferPublishes})
    const state = fixture.globalState, events=[], requests=[]
    state.set=(key,value)=>state.state.set(key,structuredClone(value))
    state.update=(key,fn)=>state.set(key,fn(state.get(key)))
    state.flushOrThrow=async()=>{}
    const windowManager={sendMessageToAllWindows:event=>events.push(event)}
    const manager=new native.Manager(state)
    const store=new native.DA(manager,state,windowManager)
    const backend=new native.eui(state,{codexHome:async()=>'/synthetic-home',appServerVersion:'0.118.0',
      sendAppServerRequest:async(method,args)=>{requests.push({method,args});if(method==='project/list')return{data:serverProjects,nextCursor:null};throw Error('Unexpected fixture app-server call '+method)}},new native.eul(state))
    backend.threadAssignmentsEnabled=gate
    const assignment=new native.efm(state,windowManager,(threadId,value,commit,options,hostId)=>backend.writeThreadAssignment(threadId,value,commit,options,hostId))
    const services={applicationState:new native.GW(key=>store.getGlobalStateValue(key),(key,value)=>store.setGlobalStateValue(key,value)),
      projectCatalog:new native.N5(key=>store.getGlobalStateValue(key)),threadProjectAssignments:assignment}
    const rpc=Object.fromEntries(Object.entries(services).map(([key,target])=>[key,new ei.AX(target)]))
    const initialize=async()=>{state.selectRendererOwner(null);await backend.ensureProjectsReady();await fixture.hydrate()}
    return {...fixture,services:rpc,targets:services,state,backend,events,requests,initialize}
  }
  function connect(services, onSwitch) {
    class Port extends EventEmitter {
      closed=false
      start(){}
      postMessage(value){if(this.closed)throw Error('closed');const target=this.peer;queueMicrotask(()=>{if(!target.closed)target.emit('message',{data:value})})}
      close(){if(this.closed)return;this.closed=true;this.emit('close');if(!this.peer.closed){this.peer.closed=true;this.peer.emit('close')}}
    }
    const client=new Port, server=new Port;client.peer=server;server.peer=client
    const disposers=new Map
    const rpcNative=sameRealm('(()=>{'+functions.ede+';'+classes.eRW+';'+functions.eRF+';return {ede:'+functionMap.ede+',eRF:'+functionMap.eRF+',refresh:({'+methods.refreshAccountWindows+'}).refreshAccountWindows}})()', {ei,ec7:disposers,edc:disposers,Error})
    const webContents=new EventEmitter;webContents.id=1;webContents.isDestroyed=()=>false
    rpcNative.ede(webContents,()=>server.close())
    class Host extends ei.TF {}
    for (const key of Object.keys(services)) Object.defineProperty(Host.prototype,key,{get:()=>services[key]})
    const remote=rpcNative.eRF(client,new ei.TF)
    rpcNative.eRF(server,new Host)
    const lifecycle=[]
    server.once('close',()=>lifecycle.push('rpc-closed'))
    const switchOwner=()=>rpcNative.refresh.call({accountWindows:{refresh:callback=>callback([webContents])},forgetWebContents:()=>lifecycle.push('forgot')},()=>{lifecycle.push('owner-switch');return onSwitch?.()})
    return {remote,client,server,switchOwner,lifecycle,close:()=>server.close()}
  }
  return {create,connect,onboarding,native,source:{classes,functions,methods}}
}
module.exports={nativeProjectStateFixture,contentOwnerProjectBoundary}
