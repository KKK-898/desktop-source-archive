const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')
const { nativeSharedProjectStateFixture } = require('./codex-api-project-shared-native-fixture.cjs')
const packagePath = process.env.CODEX_API_MODE_ASAR || process.env.CODEX_NATIVE_APP_ASAR || installedAsar()
const fixture = nativeSharedProjectStateFixture(packagePath)
const load = (file, name) => vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../src-tauri/src', file), 'utf8') + '\n' + name)
const makeGuard = load('codex_api_mode_runtime.js', 'createCodexApiLocalProjectsGuard')
const bind = load('codex_api_mode_bindings.js', 'codexApiModeLocalOnboardingBindings')
const plain = value => JSON.parse(JSON.stringify(value))
const project = (id, name) => ({id, name, rootPaths:['C:/synthetic/' + name], createdAt:1, updatedAt:2})
const initial = () => ({'local-projects':{alpha:project('alpha','Alpha'),beta:project('beta','Beta')},
  'thread-project-assignments':{a:{projectKind:'local',projectId:'alpha'},b:{projectKind:'local',projectId:'beta'}},'projectless-thread-ids':['free']})
const grant = () => ({version:1,storage:'native-shared',scope:'synthetic-home',runtimeRevision:4})
const never = () => { throw Error('native-shared must not write state, publish checkpoint or CAS') }
async function harness(options={}) {
 const h=fixture.create({globals:initial(),...options}); h.selectOwner(null); await h.initialize()
 const state={apiCodingModeEnabled:true,apiLocalProjects:grant()}; let current=true
 const adapter=bind([h.record],{window:h.window}); adapter.publishProjectCheckpoint=never
 const services=h.services
 const guard=makeGuard({appServices:services,localOnboarding:adapter},{getState:()=>state,bridge:never})
 return {h,state,guard,adapter,services,sync:()=>guard.synchronize(state.apiLocalProjects,()=>current),cancel:()=>{current=false}}
}
const run=(name,fn)=>test(name,{timeout:20000},fn)
run('native shared projects survive same-home account API account API transitions',async()=>{
 const h=fixture.create({globals:initial()})
 for(const principal of [{userId:'a',accountId:'a'},null,{userId:'b',accountId:'b'},null]){
  h.setPrincipal(principal);h.selectOwner(principal);await h.hydrate()
  const value=await h.readShared();assert.deepEqual(plain(value.catalog),initial()['local-projects'])
  assert.deepEqual(plain(value.memberships),{assignments:initial()['thread-project-assignments'],projectlessThreadIds:['free']})
 }
})
run('native shared API project guard verifies current catalog and memberships without writes',async()=>{
 const t=await harness();await t.sync();assert.equal(t.guard.status().ready,true,JSON.stringify(t.guard.status()))
 assert.equal(t.guard.status().reason,'native-shared-local-projects-verified');assert.equal(t.guard.status().revision,null)
 assert.equal(t.h.writes.length,0);assert.equal(t.h.publishes.length,0)
})
run('native shared API project guard never replays a stale legacy cache or checkpoint',async()=>{
 const t=await harness({atoms:{'gaoge:api-local-projects-hydrated-v1':{version:1,scope:'obsolete',revision:1,nonce:'old'}}})
 Object.assign(t.state.apiLocalProjects,{globals:{'local-projects':{deleted:project('deleted','Deleted')}},memberships:{assignments:{},projectlessThreadIds:[]}})
 await t.sync();assert.equal(t.guard.status().ready,true);assert.deepEqual(plain((await t.h.readShared()).catalog),initial()['local-projects'])
 assert.equal(t.h.writes.length,0);assert.equal(t.h.publishes.length,0)
})
run('native shared project rename deletion and explicit removal survive account transitions',async()=>{
 const t=await harness();await t.sync();t.h.editShared('local-projects',{alpha:project('alpha','Renamed')})
 t.h.editShared('thread-project-assignments',{});t.h.editShared('projectless-thread-ids',['free','a','b']);await t.sync()
 t.h.setPrincipal({userId:'a',accountId:'a'});t.h.selectOwner({userId:'a',accountId:'a'});await t.h.hydrate()
 t.h.setPrincipal(null);t.h.selectOwner(null);await t.h.hydrate();await t.sync()
 assert.equal(t.guard.status().ready,true);assert.deepEqual(plain((await t.h.readShared()).catalog),{alpha:project('alpha','Renamed')})
 assert.deepEqual(plain((await t.h.readShared()).memberships),{assignments:{},projectlessThreadIds:['free','a','b']})
})
run('native shared empty catalog stays empty across new guards and repeated verification',async()=>{
 const t=await harness();await t.sync();t.h.editShared('local-projects',{});t.h.editShared('thread-project-assignments',{});
 for(let i=0;i<3;i++)await t.sync();t.guard.dispose()
 const next=makeGuard({appServices:t.services,localOnboarding:t.adapter},{getState:()=>t.state,bridge:never});await next.synchronize(t.state.apiLocalProjects,()=>true)
 assert.equal(next.status().ready,true);assert.deepEqual(plain((await t.h.readShared()).catalog),{});assert.equal(t.h.writes.length,0)
})
run('native shared current manual membership wins over stale snapshot membership',async()=>{
 const t=await harness();t.h.editShared('thread-project-assignments',{a:{projectKind:'local',projectId:'beta'}})
 t.state.apiLocalProjects.memberships={assignments:{a:{projectKind:'local',projectId:'alpha'}},projectlessThreadIds:[]}
 await t.sync();assert.equal(t.guard.status().ready,true);assert.equal((await t.h.readShared()).memberships.assignments.a.projectId,'beta')
})
run('native shared same-home generation renewal does not restore deleted projects',async()=>{
 const t=await harness();await t.sync();t.h.editShared('local-projects',{});t.state.apiLocalProjects={...grant(),runtimeRevision:5};await t.sync()
 assert.equal(t.guard.status().ready,true);assert.deepEqual(plain((await t.h.readShared()).catalog),{})
})
run('native shared guard rejects another home before project reads',async()=>{
 const t=await harness();await t.sync();const n=t.h.reads.length;t.state.apiLocalProjects={...grant(),scope:'another-home'};await t.sync()
 assert.equal(t.guard.status().ready,false);assert.equal(t.guard.status().reason,'local-project-scope-changed');assert.equal(t.h.reads.length,n)
})
run('native shared guard rejects official disabled disposed and stale identities',async()=>{
 for(const mode of ['official','disabled','disposed','stale']){
  const t=await harness();if(mode==='official'){t.h.setPrincipal({userId:'a',accountId:'a'});t.h.selectOwner({userId:'a',accountId:'a'});await t.h.hydrate()}
  if(mode==='disabled')t.state.apiCodingModeEnabled=false;if(mode==='disposed')t.guard.dispose();if(mode==='stale')t.cancel()
  await t.sync();assert.equal(t.guard.status().ready,false,mode);assert.equal(t.h.writes.length,0)
 }
})
run('native shared generation change during project read invalidates verification',async()=>{
 const t=await harness();const original=t.services.projectCatalog
 t.services.projectCatalog={readLocalProjects:async()=>{const value=await original.readLocalProjects();t.state.apiLocalProjects={...grant(),runtimeRevision:9};return value}}
 await t.sync();assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/identity changed/)
})
run('native shared owner change during project read invalidates verification',async()=>{
 const t=await harness();const original=t.services.projectCatalog
 t.services.projectCatalog={readLocalProjects:async()=>{const value=await original.readLocalProjects();t.h.selectOwner({userId:'b',accountId:'b'});return value}}
 await t.sync();assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/owner changed/)
})
run('native shared malformed grant or native readback never reports ready',async()=>{
 for(const replacement of [{...grant(),scope:''},{...grant(),runtimeRevision:-1},{...grant(),version:2}]){
  const t=await harness();t.state.apiLocalProjects=replacement;await assert.rejects(t.sync(),/Invalid API local project snapshot/)
 }
 const t=await harness();t.services.threadProjectAssignments={readMemberships:async()=>({assignments:[],projectlessThreadIds:[]})};await t.sync()
 assert.equal(t.guard.status().ready,false);assert.match(t.guard.status().error,/malformed/)
})
run('native shared projects need hydrated reviewed host and a native shared grant',async()=>{
 const t=await harness();t.adapter.hostReady=()=>false;await t.sync();assert.equal(t.guard.status().ready,false);assert.equal(t.guard.status().reason,'awaiting-host-hydration')
})
