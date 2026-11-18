const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const vm = require('node:vm')
const asar = require('@electron/asar')
const { setTimeout } = require('node:timers/promises')

// Execute only the reviewed installed migration planner and its serialization queue.
// The app entry, real IPC, filesystem and user account are never executed.
function nativeProjectMigrationFixture(packagePath) {
  const files = asar.listPackage(packagePath).map(file => file.replace(/^[\\/]/, ''))
  const ts = require('typescript')
  const sources = files.filter(file => /^\.vite[\\/]build[\\/].*\.js$/.test(file)).map(file => ({file,source:asar.extractFile(packagePath,file).toString()}))
  const matches = sources.filter(({source}) => ['async syncAssignment(', 'async migrate(', 'threadAssignmentsReadMigrated', '"thread/metadata/update"'].every(marker => source.includes(marker)))
  assert.equal(matches.length, 1, 'Expected reviewed native project migration chunk')
  const {source,file} = matches[0]
  const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  const records=[]
  const visit=node=>{if(ts.isClassDeclaration(node)||ts.isFunctionDeclaration(node))records.push({name:node.name?.text,source:node.getText(tree)});ts.forEachChild(node,visit)};visit(tree)
  const one=(values,label)=>{assert.equal(values.length,1,label);return values[0]}
  const planner=one(records.filter(record=>record.source.includes('async migrate(')&&record.source.includes('async syncAssignment(')&&record.source.includes('threadAssignmentsReadMigrated')),'native assignment planner')
  // Bind the isolated dependencies for the reviewed layouts; never load the app entry.
  const layout = new Map([
    ['ed4', {state: 'es', timer: 'kL', kinds: 'v6'}],
    ['eua', {state: 'es', timer: 'kH', kinds: 'v6'}],
    ['ewE', {state: 'e1', timer: 'ES', kinds: 'Tf',
      plannerHash: 'e8fd1b2a206cbddf3dc37ba688786e29baecfd6eda2c6c422bbb5ce695f8f723',
      queueHash: '0d7f54116d91ea89c901e2e1ab8c3034d7537cb9c3e6dd3670130efeec7dc363'}],
  ]).get(planner.name)
  assert.ok(layout, 'Unreviewed installed project migration planner: '+planner.name)
  const queue=one(records.filter(record=>record.source.includes('(e.get(t)??Promise.resolve()).catch(()=>{}).then(r)')&&planner.source.includes(record.name+'(this.pendingWrites,')),'native serialization queue')
  const classSource=planner.source,helperSource=queue.source
  if (layout.plannerHash) {
    const digest = text => createHash('sha256').update(text).digest('hex')
    assert.equal(digest(classSource), layout.plannerHash, 'Installed migration planner differs from the reviewed source')
    assert.equal(digest(helperSource), layout.queueHash, 'Installed migration queue differs from the reviewed source')
  }
  assert.ok(classSource.includes('threadAssignmentsReadMigrated===!0?n.pendingThreadAssignmentIds:[...Object.keys(this.globalState.get('+layout.state+'.Q2Y.THREAD_PROJECT_ASSIGNMENTS)'))
  assert.ok(classSource.includes('n?.threadAssignmentsMigrated!==!0&&(n?.threadAssignmentsReadMigrated!==!0||n.pendingThreadAssignmentIds?.includes(e.id))'))
  assert.ok(classSource.includes('(0,'+layout.timer+'.setTimeout)(0,void 0,{signal:t})'))
  assert.ok(classSource.includes('sourceKinds:'+layout.kinds))
  const kinds=one([...new Set(sources.flatMap(record=>[...record.source.matchAll(/Object\.values\((\{cli:"cli",vscode:"vscode",exec:"exec",appServer:"appServer"[^}]+\})\)/g)].map(match=>match[1])))],'native source-kind list')
  const sourceKinds=Object.values(vm.runInNewContext('('+kinds+')'))
  const keys = {APP_SERVER_PROJECTS_MIGRATION_BY_HOST:'app-server-projects-migration-by-host',THREAD_PROJECT_ASSIGNMENTS:'thread-project-assignments',PROJECTLESS_THREAD_IDS:'projectless-thread-ids',LOCAL_PROJECTS:'local-projects'}
  const NativeAssignments = vm.runInNewContext(helperSource+classSource+';'+planner.name+';', {
    [layout.state]:{Q2Y:keys},[layout.timer]:{setTimeout},[layout.kinds]:sourceKinds,
  }, {filename:file,timeout:1000})
  async function plan(fixture) {
    const state = structuredClone(fixture.state)
    const identities = Object.keys(state[keys.APP_SERVER_PROJECTS_MIGRATION_BY_HOST])
    assert.equal(identities.length,1)
    const identity=identities[0], mappings=state['app-server-project-id-by-legacy-project-id-by-host'][identity]
    const threads=new Map(fixture.nativeDatabase.threads.map(thread=>[thread.id,structuredClone(thread)]))
    const active=[...threads.values()].filter(thread=>thread.archived===0)
    const metadataUpdates=[],listQueries=[],observedIds=[]
    const globalState={get:key=>state[key],set(){throw Error('Planner must not adopt native observations')},update(key,update){state[key]=update(state[key])}}
    const connection={async sendAppServerRequest(method,params){
      if(method==='thread/list'){
        assert.equal(params.archived,false);assert.equal(params.useStateDbOnly,true)
        assert.equal(params.modelProviders.length,0);assert.deepEqual([...params.sourceKinds],sourceKinds)
        listQueries.push({archived:params.archived,useStateDbOnly:params.useStateDbOnly,modelProviders:[...params.modelProviders],sourceKinds:[...params.sourceKinds]})
        const offset=params.cursor===null?0:Number(params.cursor),rows=active.slice(offset,offset+params.limit)
        return {data:rows.map(thread=>({id:thread.id,projectId:thread.projectId})),nextCursor:offset+rows.length<active.length?String(offset+rows.length):null}
      }
      assert.equal(method,'thread/metadata/update','Unexpected RPC is forbidden in the isolated planner')
      assert.ok(threads.has(params.threadId));assert.equal(threads.get(params.threadId).archived,0)
      const row={threadId:params.threadId,projectId:params.projectId}
      metadataUpdates.push(row);threads.get(params.threadId).projectId=params.projectId||null
      return {}
    }}
    const native=new NativeAssignments(globalState,connection,legacy=>mappings[legacy],()=>true)
    // Observation adopts server state back into legacy records. That is outside
    // the repair's ownership: retain the actual native candidate/write planner,
    // but replace only this readback callback with a side-effect-free collector.
    native.observe=async(threadId)=>{observedIds.push(threadId)}
    await native.migrate(identity,new AbortController().signal)
    return {metadataUpdates,listQueries,observedIds,migrationAfter:state[keys.APP_SERVER_PROJECTS_MIGRATION_BY_HOST][identity]}
  }
  return {plan,sourceKinds,sourceFile:file}
}
module.exports={nativeProjectMigrationFixture}
