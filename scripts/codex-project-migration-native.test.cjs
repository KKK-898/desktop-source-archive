const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const test=require('node:test')
const {installedAsar}=require('./verify-codex-ultra-installed.cjs')
const {nativeProjectMigrationFixture}=require('./codex-project-migration-native-fixture.cjs')
const before=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/codex-project-migration-26.1103-dual-store.json'),'utf8'))
const after=JSON.parse(fs.readFileSync(process.env.CODEX_PROJECT_PROJECTION_JSON||path.join(__dirname,'fixtures/codex-projects-native-after-26.1103.json'),'utf8'))
const explicit=process.env.CODEX_API_MODE_ASAR?.trim()||process.env.CODEX_NATIVE_APP_ASAR?.trim()
let packagePath
if(explicit)packagePath=installedAsar({env:{...process.env,CODEX_NATIVE_APP_ASAR:explicit}})
else if(process.platform==='win32'){try{packagePath=installedAsar()}catch(error){if(!error.message.startsWith('No registered Codex installation found.'))throw error}}
const native=packagePath?nativeProjectMigrationFixture(packagePath):null
const nativeTest=native?test:(name,run)=>test(name,{skip:'Installed Codex ASAR unavailable; set CODEX_NATIVE_APP_ASAR for source integration tests'},run)
const identity=Object.keys(before.state['app-server-projects-migration-by-host'])[0]
const pending=new Set(before.state['app-server-projects-migration-by-host'][identity].pendingThreadAssignmentIds)
const assignmentMap=updates=>Object.fromEntries(updates.map(update=>[update.threadId,update.projectId]).sort(([a],[b])=>a.localeCompare(b)))
const expectedMap=Object.fromEntries(Object.entries(after.memberships.assignments).map(([id,value])=>[id,value.projectId]).sort(([a],[b])=>a.localeCompare(b)))

nativeTest('installed native first-pass migration matches all Rust-restored local memberships beyond the pending queue',async()=>{
 const original=JSON.stringify(before)
 for(const readFlag of [undefined,false]){
  const snapshot=structuredClone(before),marker=snapshot.state['app-server-projects-migration-by-host'][identity]
  if(readFlag===undefined)delete marker.threadAssignmentsReadMigrated;else marker.threadAssignmentsReadMigrated=readFlag
  const result=await native.plan(snapshot)
  assert.equal(result.metadataUpdates.length,before.expected.restored)
  assert.equal(result.metadataUpdates.filter(update=>!pending.has(update.threadId)).length,before.expected.restoredOutsidePending)
  assert.deepEqual(assignmentMap(result.metadataUpdates),expectedMap)
  assert.equal(result.observedIds.length,before.nativeDatabase.threads.filter(thread=>thread.archived===0).length)
  assert.ok(result.listQueries.length>1,'Native migration must paginate all active threads')
  assert.equal(result.migrationAfter.threadAssignmentsReadMigrated,true)
 }
 assert.equal(JSON.stringify(before),original,'The observed fixture must remain untouched')
})

nativeTest('installed native completed-read checkpoint restricts writes to pending memberships',async()=>{
 const snapshot=structuredClone(before)
 snapshot.state['app-server-projects-migration-by-host'][identity].threadAssignmentsReadMigrated=true
 const result=await native.plan(snapshot)
 assert.equal(result.metadataUpdates.length,before.expected.pendingOnlyRestored)
 assert.ok(result.metadataUpdates.every(update=>pending.has(update.threadId)))
 assert.deepEqual(assignmentMap(result.metadataUpdates),Object.fromEntries(Object.entries(expectedMap).filter(([id])=>pending.has(id))))
})

nativeTest('installed native completed migration never replays stale legacy assignments',async()=>{
 const snapshot=structuredClone(before),marker=snapshot.state['app-server-projects-migration-by-host'][identity]
 marker.threadAssignmentsMigrated=true;marker.threadAssignmentsReadMigrated=true
 const result=await native.plan(snapshot)
 assert.deepEqual(result.metadataUpdates,[]);assert.deepEqual(result.listQueries,[])
})
