const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const vm = require('node:vm')
const path = require('node:path')
const asar = require('@electron/asar')
const ts = require('typescript')
const { contentOwnerOnboardingFixture } = require('./codex-api-onboarding-content-owner-fixture.cjs')

const reviewed = {
  KD: ['early-bootstrap-331-29198f5b57adf59a.js', 'd4fc10e2dbfc4b86a2ddc0e69b97ef25370b81dfac8e9dc400cc1165e7254e2b'],
  UM: ['early-bootstrap-331-29198f5b57adf59a.js', '717b47160adf117ca21ec33efdf515cb47c4d4a5d3b3979e2b34c1e34442fc38'],
  ekz: ['early-bootstrap-331-29198f5b57adf59a.js', '1ecdd7389c4b5ed42accc5c98c7751ab1ba13488a8c4c443a77ecb1507e3338b'],
  uG: ['early-bootstrap-631-cdfc1944212b0139.js', '8efe2d72f65bd5c17a0ec2a0dcda5fdce23fac5f4ccaf4f7c528e01e1e1f5851'],
}
const sharedKeys = ['local-projects', 'thread-project-assignments', 'projectless-thread-ids']
const object = value => value != null && typeof value === 'object' && !Array.isArray(value)
const catalog = value => {
  if (value == null) return {}
  assert.ok(object(value), 'synthetic local catalog must be an object')
  for (const [id, project] of Object.entries(value)) {
    assert.ok(object(project) && project.id === id && typeof project.name === 'string'
      && Array.isArray(project.rootPaths) && project.rootPaths.every(root => typeof root === 'string'), 'synthetic local project')
    assert.ok(!Object.keys(project).some(key => /chatGpt|remote/i.test(key)), 'this fixture accepts only synthetic local projects')
  }
  return value
}
const assignments = value => {
  if (value == null) return {}
  assert.ok(object(value), 'synthetic memberships must be an object')
  for (const [threadId, membership] of Object.entries(value)) {
    assert.ok(threadId && object(membership) && membership.projectKind === 'local'
      && typeof membership.projectId === 'string' && membership.projectId.length > 0, 'synthetic local membership')
    assert.ok(membership.hostId == null || membership.hostId === 'local', 'no remote memberships in this fixture')
  }
  return value
}
const projectless = value => {
  assert.ok(value == null || Array.isArray(value) && value.every(id => typeof id === 'string'), 'synthetic projectless thread IDs')
  return value ?? []
}
function validateShared(key, value) {
  if (key === sharedKeys[0]) catalog(value)
  else if (key === sharedKeys[1]) assignments(value)
  else if (key === sharedKeys[2]) projectless(value)
  else assert.fail('not a shared local-project fixture key: ' + key)
}

// Executes the installed, hash-reviewed native owner/store and RPC service
// classes against synthetic in-memory state. The schema adapters below accept
// only local synthetic values; they are not substitutes for production schema
// validation. No Electron entry point, filesystem persistence, real account,
// app-server request, project migration or Gaoge cache restore is executed.
function nativeSharedProjectStateFixture(packagePath) {
  const version = JSON.parse(asar.extractFile(packagePath, 'package.json')).version
  assert.equal(version, '26.1111.21308', 'unreviewed shared native project host')
  const onboarding = contentOwnerOnboardingFixture(packagePath)
  const trees = new Map(), source = {}
  for (const [name, [file, hash]] of Object.entries(reviewed)) {
    const filename = path.join('.vite', 'build', file)
    if (!trees.has(file)) trees.set(file, ts.createSourceFile(filename, asar.extractFile(packagePath, filename).toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS))
    const tree = trees.get(file), matches = []
    const visit = node => {
      if (ts.isClassDeclaration(node) && node.name?.text === name) matches.push(node.getText(tree))
      ts.forEachChild(node, visit)
    }
    visit(tree)
    assert.equal(matches.length, 1, 'reviewed native class ' + name)
    assert.equal(createHash('sha256').update(matches[0]).digest('hex'), hash, 'native project contract changed: ' + name)
    source[name] = matches[0]
  }
  assert.deepEqual(['LOCAL_PROJECTS', 'THREAD_PROJECT_ASSIGNMENTS', 'PROJECTLESS_THREAD_IDS'].map(name => onboarding.globalKeys[name]), sharedKeys)
  for (const key of sharedKeys) assert.equal(onboarding.ownerContract.O.includes(key), false, 'shared local project key: ' + key)
  const rpc = onboarding.rpcExports
  const nativeKeys = { Q2Y: onboarding.globalKeys, b9: catalog, DZs: assignments }
  const ApplicationState = vm.runInThisContext('(function(e0,e1){return (' + source.KD + ')})')(rpc, nativeKeys)
  const ProjectCatalog = vm.runInThisContext('(function(e0,e1){return (' + source.UM + ')})')(rpc, nativeKeys)
  const MembershipService = vm.runInThisContext('(function(a){return (' + source.uG + ')})')(rpc)
  const ThreadProjectAssignments = vm.runInThisContext('(function(e8,e1){return (' + source.ekz + ')})')({ NcW: MembershipService }, nativeKeys)

  function create(options = {}) {
    for (const key of sharedKeys) if (Object.hasOwn(options.globals ?? {}, key)) validateShared(key, options.globals[key])
    const h = onboarding.create(options)
    const reads = [], writes = [], events = []
    const read = key => { reads.push(key); return h.globalState.get(key) }
    const write = (key, value) => { writes.push({ key, value }); assert.fail('shared project verification must not restore/write native state') }
    const targets = {
      applicationState: new ApplicationState(read, write),
      projectCatalog: new ProjectCatalog(read),
      threadProjectAssignments: new ThreadProjectAssignments(h.globalState, { sendMessageToAllWindows: event => events.push(event) }),
    }
    const services = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, new rpc.AX(target)]))
    const readShared = async () => ({
      catalog: await services.projectCatalog.readLocalProjects(),
      memberships: await services.threadProjectAssignments.readMemberships(),
    })
    const editShared = (key, value) => {
      validateShared(key, value)
      h.globalState.set(key, structuredClone(value))
    }
    return { ...h, state: h.globalState, services, targets, reads, writes, events, readShared, editShared,
      initialize: () => h.hydrate(), currentShared: () => Object.fromEntries(sharedKeys.map(key => [key, h.globalState.get(key)])) }
  }
  return { create, onboarding, sharedKeys, source, version }
}
module.exports = { nativeSharedProjectStateFixture }
