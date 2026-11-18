const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const test = require('node:test')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')
const { nativeProjectStateFixture } = require('./codex-api-project-state-native-fixture.cjs')
let packagePath = process.env.CODEX_API_MODE_ASAR || process.env.CODEX_NATIVE_APP_ASAR
let unavailable = ''
if (!packagePath) { try { packagePath = installedAsar() } catch (error) { unavailable = error.message } }
const run = (name,fn) => test(name,{skip:!packagePath && ('Installed Codex is required: '+unavailable),timeout:20000},fn)
// Keep the 26 legacy restore/CAS assertions intact for their reviewed host.
// The modern host preserves shared state natively and must exercise its own
// positive persistence contract instead of pretending startup clears projects.
const nativeVersion = packagePath ? JSON.parse(require('@electron/asar').extractFile(packagePath, 'package.json')).version : null
if (nativeVersion === '26.1111.21308') {
  require('./codex-api-project-shared-state.test.cjs')
} else {
const fixture = packagePath ? nativeProjectStateFixture(packagePath) : null
const runtime = fs.readFileSync(path.join(__dirname,'../src-tauri/src/codex_api_mode_runtime.js'),'utf8')
const bindingsSource = fs.readFileSync(path.join(__dirname,'../src-tauri/src/codex_api_mode_bindings.js'),'utf8')
const createGuard = vm.runInThisContext(runtime+'\ncreateCodexApiLocalProjectsGuard;')
const createOnboarding = vm.runInThisContext(bindingsSource+'\ncodexApiModeLocalOnboardingBindings;')
const plain = value => JSON.parse(JSON.stringify(value))
const project = (id,name) => ({id,name,rootPaths:['C:/synthetic/'+name],createdAt:1,updatedAt:2})
const definition = {'server-alpha':project('server-alpha','Alpha'),'server-beta':project('server-beta','Beta')}
const assignments = {threadA:{projectKind:'local',projectId:'server-alpha'},threadB:{projectKind:'local',projectId:'server-beta'}}
const checkpointKey = 'gaoge:api-local-projects-hydrated-v1'
const apiState = snapshot => ({apiCodingModeEnabled:true,apiLocalProjects:snapshot})
const checkpointReceipt = revision => ({version:1,revision,nonce:'synthetic-checkpoint-'+revision})
const nativeCheckpoint = t => t.h.state.get('electron-persisted-atom-state')?.[checkpointKey]
const payload = () => ({version:1,revision:1,checkpoint:checkpointReceipt(1),runtimeRevision:7,scope:'synthetic-scope',globals:{
 'local-projects':structuredClone(definition),'electron-saved-workspace-roots':['C:/synthetic/Alpha','C:/synthetic/Beta'],
 'electron-workspace-root-labels':{'C:/synthetic/Alpha':'Alpha','C:/synthetic/Beta':'Beta'}},
 memberships:{assignments:structuredClone(assignments),projectlessThreadIds:[]}})
async function harness(options={}) {
 const h = fixture.create({catalog:{legacy:project('legacy','Official')},serverProjects:Object.values(definition).map(p=>({...p,roots:p.rootPaths.map(path=>({path})),metadata:{}})),...options})
 await h.initialize()
 let state=apiState(payload()),current=true,saved=structuredClone(state.apiLocalProjects),commits=[]
 const bindings={appServices:h.services,localOnboarding:createOnboarding([h.record],{window:h.window})}
 const bridge=async(route,input)=>{
  assert.equal(route,'/projects/local-state');commits.push(structuredClone(input))
  if(options.rejectCommit||input.expectedRevision!==saved.revision)return{ok:false}
  saved={...saved,revision:saved.revision+1,checkpoint:checkpointReceipt(saved.revision+1),runtimeRevision:input.runtimeRevision,globals:structuredClone(input.globals),memberships:structuredClone(input.memberships)}
  const result={ok:true,apiLocalProjects:saved};return options.onCommitted?options.onCommitted(result):result
 }
 const guard=createGuard(bindings,{getState:()=>state,bridge})
 return {h,guard,commits,bindings,bridge,get saved(){return saved},get state(){return state},setState:patch=>{state={...state,...patch}},setCurrent:value=>{current=value},sync:()=>guard.synchronize(state.apiLocalProjects,()=>current)}
}
run('real main owner selection clears desktop catalog while app-server projects survive',async()=>{
 const t=await harness();assert.equal(t.h.state.get('local-projects'),null)
 assert.deepEqual(plain(await t.h.services.projectCatalog.readLocalProjects()),{})
 assert.deepEqual([...t.h.backend.serverProjectsByLegacyId.keys()],['server-alpha','server-beta'])
 assert.equal((await t.h.services.applicationState.write('thread-project-assignments',assignments)).success,false)
 await assert.rejects(Promise.resolve(t.h.services.applicationState.write('project-order',[])),/Direct writes/)
 assert.equal(t.h.state.get('thread-project-assignments'),null)
})
run('real native main services restore canonical API projects and memberships then CAS persist',async()=>{
 const t=await harness();await t.sync();assert.equal(t.guard.status().ready,true,JSON.stringify(t.guard.status()))
 assert.deepEqual(plain(await t.h.services.projectCatalog.readLocalProjects()),definition)
 assert.deepEqual(plain(await t.h.services.threadProjectAssignments.readMemberships()),payload().memberships)
 assert.equal(t.commits.length,1);assert.equal(t.saved.revision,2)
 assert.equal(t.h.requests.some(item=>item.method==='thread/metadata/update'),false,'Disabled native membership sync remains unchanged')
 assert.ok(t.h.events.some(event=>event.type==='thread-project-memberships-updated'))
})
run('API rename removal and explicit projectless edits persist without replaying an older GET',async()=>{
 const t=await harness();await t.sync()
 await t.h.services.applicationState.write('local-projects',{'server-alpha':project('server-alpha','Renamed')})
 await t.h.services.threadProjectAssignments.setMembership({threadId:'threadB',assignment:null,projectless:true,hostId:'local'})
 await t.sync();assert.equal(t.guard.status().ready,true)
 assert.equal(t.saved.globals['local-projects']['server-alpha'].name,'Renamed');assert.equal(t.saved.globals['local-projects']['server-beta'],undefined)
 assert.deepEqual(plain(t.saved.memberships),{assignments:{threadA:assignments.threadA},projectlessThreadIds:['threadB']})
 const h=fixture.create();await h.initialize()
 const state=apiState(t.saved);const next=createGuard({appServices:h.services,localOnboarding:createOnboarding([h.record],{window:h.window})},{getState:()=>state,bridge:async(_,input)=>({ok:true,apiLocalProjects:{...t.saved,revision:t.saved.revision+1,checkpoint:checkpointReceipt(t.saved.revision+1),...input}})})
 await next.synchronize(t.saved,()=>true);assert.equal(next.status().ready,true,JSON.stringify(next.status()))
 assert.equal((await h.services.projectCatalog.readLocalProjects())['server-beta'],undefined)
 assert.deepEqual(plain(await h.services.threadProjectAssignments.readMemberships()),plain(t.saved.memberships))
})
run('deleting every local project remains a persisted empty catalog across repeated polling',async()=>{
 const t=await harness();await t.sync()
 await t.h.services.threadProjectAssignments.restoreMemberships(Object.keys(assignments).map(threadId=>({threadId,assignment:null,projectless:true,hostId:'local'})))
 await t.h.services.applicationState.write('local-projects',{})
 await t.sync();await t.sync();assert.deepEqual(plain(await t.h.services.projectCatalog.readLocalProjects()),{})
 assert.deepEqual(plain(t.saved.globals['local-projects']),{});assert.equal(t.commits.length,2)
})
run('native explicit assignment and projectless conflicts stay unverified and are not overwritten',async()=>{
 const t=await harness()
 await t.h.services.threadProjectAssignments.setMembership({threadId:'threadA',assignment:null,projectless:true,hostId:'local'})
 await t.sync();assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/membership conflict/)
 assert.ok((await t.h.services.threadProjectAssignments.readMemberships()).projectlessThreadIds.includes('threadA'))
 await t.sync();assert.equal(t.guard.status().ready,false);assert.equal(t.commits.length,0)
})
run('newer GET revisions cannot silently authorize overwriting a concurrent snapshot',async()=>{
 const t=await harness();await t.sync();const saved=t.saved
 t.setState({apiLocalProjects:{...saved,revision:9}})
 await t.h.services.applicationState.write('local-projects',{'server-alpha':project('server-alpha','Changed')})
 await t.sync();assert.equal(t.commits.at(-1).expectedRevision,2)
 assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/commit rejected/)
})
run('native owner change blocks hydration before any catalog write',async()=>{
 const t=await harness();t.h.selectOwner({userId:'official-user',accountId:'official-account'})
 await t.sync();assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/owner changed/)
 assert.deepEqual(plain(await t.h.services.projectCatalog.readLocalProjects()),{});assert.equal(t.commits.length,0)
})
run('real native account switch closes old RPC before selecting another owner',async()=>{
 const h=fixture.create();await h.initialize()
 const link=fixture.connect(h.targets,()=>h.selectOwner({userId:'user-next',accountId:'account-next'}))
 assert.deepEqual(plain(await link.remote.projectCatalog.readLocalProjects()),{})
 const queued=link.remote.applicationState.write('local-projects',definition)
 link.switchOwner();await assert.rejects(Promise.resolve(queued),/closed|disconnect|broken|disposed|error/i)
 assert.deepEqual(link.lifecycle.slice(0,3),['rpc-closed','forgot','owner-switch'])
 assert.deepEqual(plain(await h.services.projectCatalog.readLocalProjects()),{})
 link.close()
})
run('same API renderer stops on a different home',async()=>{
 const t=await harness();await t.sync();t.setState({apiLocalProjects:{...payload(),runtimeRevision:8,scope:'other-home'}})
 await t.sync();assert.equal(t.guard.status().ready,false);assert.equal(t.guard.status().reason,'local-project-scope-changed')
 assert.equal(t.commits.length,1)
})

run('full native message-port RPC restores catalog and membership without replacing service methods',async()=>{
 const t=await harness();const link=fixture.connect(t.h.targets)
 t.bindings.appServices={applicationState:link.remote.applicationState,projectCatalog:link.remote.projectCatalog,threadProjectAssignments:link.remote.threadProjectAssignments}
 await t.sync();assert.equal(t.guard.status().ready,true,JSON.stringify(t.guard.status()))
 assert.deepEqual(plain(await link.remote.projectCatalog.readLocalProjects()),definition)
 assert.deepEqual(plain(await link.remote.threadProjectAssignments.readMemberships()),payload().memberships)
 const atoms=await link.remote.applicationState.read('electron-persisted-atom-state')
 assert.deepEqual(plain(atoms.value[checkpointKey]),{version:1,scope:t.saved.scope,revision:t.saved.revision,nonce:t.saved.checkpoint.nonce})
 link.close()
})
run('confirmed API snapshot conflicts with startup database membership remain visible and unmodified',async()=>{
 const t=await harness()
 await t.h.services.threadProjectAssignments.setMembership({threadId:'threadA',assignment:assignments.threadA,projectless:false,hostId:'local'})
 const snapshot=payload();delete snapshot.memberships.assignments.threadA;snapshot.memberships.projectlessThreadIds=['threadA']
 t.setState({apiLocalProjects:snapshot});await t.sync()
 assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/membership conflict/)
 assert.deepEqual(plain((await t.h.services.threadProjectAssignments.readMemberships()).assignments.threadA),assignments.threadA)
 assert.equal(t.commits.length,0)
})

run('same-home settings revision renews authorization without replaying a deleted API project',async()=>{
 const t=await harness();await t.sync()
 await t.h.services.threadProjectAssignments.restoreMemberships(Object.keys(assignments).map(threadId=>({threadId,assignment:null,projectless:true,hostId:'local'})))
 await t.h.services.applicationState.write('local-projects',{});await t.sync()
 const saved=t.saved;t.setState({apiLocalProjects:{...payload(),runtimeRevision:8}})
 await t.sync();assert.equal(t.guard.status().ready,true,JSON.stringify(t.guard.status()))
 assert.deepEqual(plain(await t.h.services.projectCatalog.readLocalProjects()),{})
 assert.equal(t.commits.length,2);assert.equal(t.guard.status().revision,saved.revision)
})

run('verified native checkpoint publishes one non-shared key only after successful CAS',async()=>{
 const t=await harness(),atomsBefore=structuredClone(t.h.state.get('electron-persisted-atom-state')||{}),ownerBefore=structuredClone(t.h.state.get('electron-account-renderer-state-v1'))
 assert.equal(nativeCheckpoint(t),undefined);await t.sync()
 const marker={version:1,scope:t.saved.scope,revision:2,nonce:t.saved.checkpoint.nonce}
 assert.equal(t.guard.status().ready,true,JSON.stringify(t.guard.status()))
 assert.deepEqual(plain(nativeCheckpoint(t)),marker)
 assert.deepEqual(t.h.publishes.map(item=>item.key),[checkpointKey])
 assert.deepEqual(plain(t.h.state.get('electron-persisted-atom-state')),{...atomsBefore,[checkpointKey]:marker})
 assert.deepEqual(plain(t.h.state.get('electron-account-renderer-state-v1')),ownerBefore)
 assert.equal(fixture.onboarding.sharedKeys.includes(checkpointKey),false)
})
run('incomplete native hydration and rejected CAS never publish a checkpoint',async()=>{
 const incomplete=await harness()
 await incomplete.h.services.threadProjectAssignments.setMembership({threadId:'threadA',assignment:null,projectless:true,hostId:'local'})
 await incomplete.sync();assert.equal(incomplete.guard.status().ready,false)
 assert.match(incomplete.guard.status().error,/membership conflict/)
 assert.equal(incomplete.commits.length,0);assert.equal(nativeCheckpoint(incomplete),undefined);assert.equal(incomplete.h.publishes.length,0)
 const rejected=await harness({rejectCommit:true});await rejected.sync()
 assert.equal(rejected.guard.status().ready,false);assert.match(rejected.guard.status().error,/commit rejected/)
 assert.equal(nativeCheckpoint(rejected),undefined);assert.equal(rejected.h.publishes.length,0)
})
run('malformed CAS checkpoint receipts cannot authorize native exit capture',async()=>{
 for(const checkpoint of [undefined,{version:2,revision:2,nonce:'wrong-version'},{version:1,revision:1,nonce:'wrong-revision'},{version:1,revision:2,nonce:''}]){
  const t=await harness({onCommitted:result=>({...result,apiLocalProjects:{...result.apiLocalProjects,checkpoint}})})
  await t.sync();assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/commit rejected/)
  assert.equal(nativeCheckpoint(t),undefined);assert.equal(t.h.publishes.length,0)
 }
})
run('delayed native checkpoint IPC retries the receipt without another snapshot commit',async()=>{
 const t=await harness({deferPublishes:true});await t.sync()
 assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/checkpoint readback pending/)
 assert.equal(t.commits.length,1);assert.equal(t.guard.status().revision,2);assert.equal(nativeCheckpoint(t),undefined)
 await t.sync();assert.equal(t.guard.status().ready,false);assert.equal(t.commits.length,1)
 assert.equal(t.h.publishes.length,2);assert.deepEqual(plain(t.h.publishes[0]),plain(t.h.publishes[1]))
 t.h.flushPublishes();await t.sync()
 assert.equal(t.guard.status().ready,true,JSON.stringify(t.guard.status()));assert.equal(t.commits.length,1)
 assert.equal(nativeCheckpoint(t).nonce,t.saved.checkpoint.nonce)
})
run('subsequent CAS updates checkpoint revision and nonce without exposing the receipt in status',async()=>{
 const t=await harness();await t.sync();const first=plain(nativeCheckpoint(t))
 await t.h.services.applicationState.write('local-projects',{'server-alpha':project('server-alpha','Changed')})
 await t.sync();const second=plain(nativeCheckpoint(t))
 assert.equal(t.guard.status().ready,true,JSON.stringify(t.guard.status()));assert.equal(t.commits.length,2)
 assert.equal(second.revision,first.revision+1);assert.notEqual(second.nonce,first.nonce)
 assert.equal(second.nonce,t.saved.checkpoint.nonce);assert.equal(t.h.publishes.length,2)
 assert.equal(JSON.stringify(t.guard.status()).includes('nonce'),false)
 assert.equal(JSON.stringify(t.guard.status()).includes(second.nonce),false)
})
run('native null-owner reset removes checkpoint even when the previous owner was already null',async()=>{
 const t=await harness();await t.sync();assert.ok(nativeCheckpoint(t))
 assert.equal(t.h.state.get('electron-account-renderer-state-v1').owner,null)
 t.h.selectOwner(null)
 assert.equal(t.h.state.get('electron-account-renderer-state-v1').owner,null);assert.equal(nativeCheckpoint(t),undefined)
 assert.deepEqual(plain(await t.h.services.projectCatalog.readLocalProjects()),{})
})
run('disposing runtime preserves the verified native checkpoint for final exit capture',async()=>{
 const t=await harness();await t.sync();const marker=plain(nativeCheckpoint(t)),published=t.h.publishes.length
 t.guard.dispose();assert.equal(t.guard.status().ready,false);await t.sync()
 assert.deepEqual(plain(nativeCheckpoint(t)),marker);assert.equal(t.h.publishes.length,published)
})
run('home runtime grant and account changes during CAS prevent checkpoint publication',async()=>{
 for(const change of ['home','runtime','account','current']){
  let t;t=await harness({onCommitted:result=>{
   if(change==='home')t.setState({apiLocalProjects:{...t.state.apiLocalProjects,scope:'another-home'}})
   if(change==='runtime')t.setState({apiLocalProjects:{...t.state.apiLocalProjects,runtimeRevision:8}})
   if(change==='account')t.h.selectOwner({userId:'next-user',accountId:'next-account'})
   if(change==='current')t.setCurrent(false)
   return result
  }})
  await t.sync();assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/identity changed|owner changed/)
  assert.equal(nativeCheckpoint(t),undefined);assert.equal(t.h.publishes.length,0)
 }
})
run('checkpoint publication requires host hydration a valid receipt and current identity',async()=>{
 const h=fixture.create(),binding=createOnboarding([h.record],{window:h.window})
 const marker={version:1,scope:'synthetic-scope',revision:2,nonce:'synthetic-receipt'}
 assert.equal(binding.publishProjectCheckpoint(marker,()=>true).ready,false);assert.equal(h.publishes.length,0)
 await h.initialize()
 for(const invalid of [{...marker,nonce:''},{...marker,version:2},{...marker,scope:''},{...marker,revision:-1}])assert.equal(binding.publishProjectCheckpoint(invalid,()=>true).ready,false)
 assert.equal(binding.publishProjectCheckpoint(marker,()=>false).ready,false);assert.equal(h.publishes.length,0)
})

run('first native hydration merges projects created before the bridge without dropping saved projects',async()=>{
 const created=project('server-new','Created Before Bridge')
 const t=await harness({serverProjects:[...Object.values(definition),created].map(p=>({...p,roots:p.rootPaths.map(path=>({path})),metadata:{}}))})
 assert.equal(nativeCheckpoint(t),undefined)
 await t.h.services.applicationState.write('local-projects',{'server-new':created})
 await t.h.services.applicationState.write('electron-saved-workspace-roots',created.rootPaths)
 await t.h.services.applicationState.write('electron-workspace-root-labels',{[created.rootPaths[0]]:'New native label'})
 await t.h.services.threadProjectAssignments.setMembership({threadId:'thread-new',assignment:{projectKind:'local',projectId:'server-new'},projectless:false,hostId:'local'})
 await t.sync();assert.equal(t.guard.status().ready,true,JSON.stringify(t.guard.status()))
 const expected={...definition,'server-new':created}
 assert.deepEqual(plain(await t.h.services.projectCatalog.readLocalProjects()),expected)
 assert.deepEqual(plain(t.saved.globals['local-projects']),expected)
 assert.ok(t.commits.every(commit=>Object.keys(definition).every(id=>Object.hasOwn(commit.globals['local-projects'],id))),'No saved project is emitted as deleted')
 assert.deepEqual(plain(t.saved.memberships.assignments),{...assignments,'thread-new':{projectKind:'local',projectId:'server-new'}})
 assert.deepEqual(plain(t.saved.globals['electron-saved-workspace-roots']),[...created.rootPaths,'C:/synthetic/Alpha','C:/synthetic/Beta'])
 assert.equal(t.saved.globals['electron-workspace-root-labels'][created.rootPaths[0]],'New native label')
})
run('first native hydration keeps live same-ID edits and unions only valid catalog roots and labels',async()=>{
 const t=await harness(),edited={...project('server-alpha','Live Alpha'),rootPaths:['C:/synthetic/UpdatedAlpha']},created=project('server-new','Fresh')
 await t.h.services.applicationState.write('local-projects',{'server-alpha':edited,'server-new':created})
 await t.h.services.applicationState.write('electron-saved-workspace-roots',['C:/synthetic/UpdatedAlpha','c:/SYNTHETIC/UpdatedAlpha','//remote/share','relative','C:/unrelated'])
 await t.h.services.applicationState.write('electron-workspace-root-labels',{'c:/SYNTHETIC/UpdatedAlpha':'Live alias label','C:/synthetic/Beta':'Live beta label','C:/unrelated':'Not a project','//remote/share':'Remote','relative':'Relative'})
 await t.sync();assert.equal(t.guard.status().ready,true,JSON.stringify(t.guard.status()))
 assert.deepEqual(plain(t.saved.globals['local-projects']),{...definition,'server-alpha':edited,'server-new':created})
 assert.deepEqual(plain(t.saved.globals['electron-saved-workspace-roots']),['C:/synthetic/UpdatedAlpha','C:/synthetic/Beta','C:/synthetic/Fresh'])
 assert.deepEqual(plain(t.saved.globals['electron-workspace-root-labels']),{'C:/synthetic/Beta':'Live beta label','C:/synthetic/UpdatedAlpha':'Live alias label'})
})
run('a fresh guard honors matched native checkpoint deletions and membership changes',async()=>{
 for(const removeAll of [false,true]){
  const t=await harness();await t.sync();const snapshot=structuredClone(t.saved);t.guard.dispose()
  await t.h.services.applicationState.write('local-projects',removeAll?{}:{'server-beta':definition['server-beta']})
  await t.h.services.applicationState.write('electron-saved-workspace-roots',removeAll?[]:['C:/synthetic/Beta'])
  await t.h.services.applicationState.write('electron-workspace-root-labels',removeAll?{}:{'C:/synthetic/Beta':'Beta'})
  await t.h.services.threadProjectAssignments.restoreMemberships(Object.keys(assignments).map(threadId=>({threadId,assignment:removeAll?null:{projectKind:'local',projectId:'server-beta'},projectless:removeAll,hostId:'local'})))
  const state=apiState(snapshot),next=createGuard(t.bindings,{getState:()=>state,bridge:t.bridge})
  await next.synchronize(snapshot,()=>true);assert.equal(next.status().ready,true,JSON.stringify(next.status()))
  assert.equal(t.saved.globals['local-projects']['server-alpha'],undefined)
  assert.deepEqual(plain(t.saved.globals['local-projects']),removeAll?{}:{'server-beta':definition['server-beta']})
  assert.deepEqual(plain(t.saved.memberships),removeAll?{assignments:{},projectlessThreadIds:['threadA','threadB']}:{assignments:{threadA:{projectKind:'local',projectId:'server-beta'},threadB:{projectKind:'local',projectId:'server-beta'}},projectlessThreadIds:[]})
  next.dispose()
 }
})
run('a mismatched native checkpoint waits for a fresh snapshot before treating live deletions as authoritative',async()=>{
 const t=await harness();await t.sync();const currentSnapshot=structuredClone(t.saved);t.guard.dispose()
 await t.h.services.threadProjectAssignments.restoreMemberships(Object.keys(assignments).map(threadId=>({threadId,assignment:null,projectless:true,hostId:'local'})))
 await t.h.services.applicationState.write('local-projects',{})
 let state=apiState(payload());const next=createGuard(t.bindings,{getState:()=>state,bridge:t.bridge}),beforeCommits=t.commits.length,beforePublishes=t.h.publishes.length
 await next.synchronize(state.apiLocalProjects,()=>true)
 assert.equal(next.status().ready,false);assert.equal(next.status().reason,'awaiting-current-local-project-snapshot');assert.equal(next.status().hydrated,false)
 assert.equal(t.commits.length,beforeCommits);assert.equal(t.h.publishes.length,beforePublishes)
 assert.deepEqual(plain(await t.h.services.projectCatalog.readLocalProjects()),{})
 state=apiState(currentSnapshot);await next.synchronize(state.apiLocalProjects,()=>true)
 assert.equal(next.status().ready,true,JSON.stringify(next.status()));assert.equal(t.commits.at(-1).expectedRevision,currentSnapshot.revision)
 assert.deepEqual(plain(t.saved.globals['local-projects']),{});next.dispose()
})
run('foreign or malformed native checkpoints never authorize initial snapshot replay',async()=>{
 for(const marker of [{version:1,scope:'foreign-home',revision:1,nonce:checkpointReceipt(1).nonce},{version:1,scope:'synthetic-scope',revision:1,nonce:'foreign-receipt'},{version:2,scope:'synthetic-scope',revision:1,nonce:checkpointReceipt(1).nonce},{}]){
  const t=await harness();t.h.persisted.jx(checkpointKey,marker);const count=t.h.publishes.length
  await t.sync();assert.equal(t.guard.status().ready,false);assert.equal(t.guard.status().reason,'awaiting-current-local-project-snapshot')
  assert.equal(t.commits.length,0);assert.equal(t.h.publishes.length,count)
  assert.deepEqual(plain(await t.h.services.projectCatalog.readLocalProjects()),{})
 }
})

}
