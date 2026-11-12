const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const test = require('node:test')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')
const { nativeProjectsFixture } = require('./codex-projects-native-fixture.cjs')

const beforePath = path.join(__dirname, 'fixtures/codex-project-migration-26.1103-dual-store.json')
const beforeBytes = fs.readFileSync(beforePath)
const before = JSON.parse(beforeBytes)
// The checked-in after snapshot comes from SELECTs after the actual Rust repair
// transaction, not a JavaScript reimplementation of the migration. An integrated
// run can point this at GAOGE_PROJECT_FIXTURE_PROJECTION_OUT from the Rust test.
const after = JSON.parse(fs.readFileSync(process.env.CODEX_PROJECT_PROJECTION_JSON || path.join(__dirname, 'fixtures/codex-projects-native-after-26.1103.json')))
const explicitPackage = process.env.CODEX_API_MODE_ASAR?.trim() || process.env.CODEX_NATIVE_APP_ASAR?.trim()
let packagePath
if (explicitPackage) {
  // Explicit inputs are release evidence: unreadable/malformed paths must fail.
  packagePath = installedAsar({ env: { ...process.env, CODEX_NATIVE_APP_ASAR: explicitPackage } })
} else if (process.platform === 'win32') {
  try { packagePath = installedAsar() } catch (error) {
    if (!error.message.startsWith('No registered Codex installation found.')) throw error
  }
}
const native = packagePath ? nativeProjectsFixture(packagePath) : null
const nativeTest = native ? test : (name, run) => test(name, { skip: 'Installed Codex ASAR unavailable; set CODEX_NATIVE_APP_ASAR for source integration tests' }, run)
const bindingSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_api_mode_bindings.js'), 'utf8')
const runtimeSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_api_mode_runtime.js'), 'utf8')
const bindings = vm.runInThisContext(bindingSource + '\ncodexApiModeWebpackBindings;')
const createGuard = vm.runInThisContext(runtimeSource + '\ncreateCodexApiModeGuard;')
const api = { accountId: null, userId: null, authMethod: 'apikey', stableId: 'synthetic-device' }
const official = { accountId: 'synthetic-account', userId: 'synthetic-user', authMethod: 'chatgpt', stableId: 'synthetic-device' }

function catalog(projects) {
  return Object.fromEntries(projects.map((project, index) => [project.id, {
    id: project.id, name: 'Synthetic project ' + (index + 1),
    rootPaths: project.roots.map(root => root.path), createdAt: 0, updatedAt: 0,
  }]))
}
const beforeCatalog = catalog(before.nativeDatabase.projects.map(project => ({
  ...project, roots: before.nativeDatabase.projectRoots.filter(root => root.projectId === project.id),
})))
const afterCatalog = catalog(after.projects)
const visibleThreads = before.nativeDatabase.threads.filter(thread => !thread.archived)
const state = { 'pinned-project-ids': [], 'project-order': [] }
const repairedIds = Object.keys(after.memberships.assignments).sort()
const inGroups = groups => groups.flatMap(group => group.threadKeys.map(key => key.replace(/^local:/, ''))).sort()

function harness(t, repaired = true) {
  const h = native.createHarness({
    catalog: repaired ? afterCatalog : beforeCatalog,
    memberships: repaired ? after.memberships : { assignments: {}, projectlessThreadIds: before.state['projectless-thread-ids'] },
    threads: visibleThreads, state,
  })
  let enabled = true
  const bridge = bindings(h.base)
  assert.equal(bridge.error, null)
  const guard = createGuard(bridge, { getState: () => ({ apiCodingModeEnabled: enabled }), eventTarget: null })
  t.after(() => guard.dispose())
  return Object.assign(h, { guard, enable: value => { enabled = value } })
}

async function assertRepairedSidebar(h) {
  const groups = await h.readGroups()
  assert.equal(groups.hasLoadedProjectSources, true)
  assert.equal(groups.isWorkspaceRootOptionsLoading, false)
  assert.equal(groups.projectGroups.length, 4)
  assert.deepEqual(inGroups(groups.projectGroups), repairedIds)
  const sidebar = await h.readSidebar()
  assert.equal(sidebar.layout.projectKeys.length, 4)
  assert.deepEqual(inGroups(sidebar.codexProjectGroups), repairedIds)
  const assignedKeys = new Set(repairedIds.map(id => 'codex:thread:local:' + id))
  assert.ok(sidebar.layout.chatKeys.every(key => !assignedKeys.has(key)), 'Assigned threads must not fall back into the ungrouped chats section')
  assert.equal(sidebar.layout.chatKeys.length, visibleThreads.length - repairedIds.length)
  assert.deepEqual(h.observed.writes, [])
  assert.deepEqual(h.observed.remoteRequests, [])
  return sidebar
}

test('native project projection is tied to the observed fixture and real Rust transaction', () => {
  assert.equal(after.syntheticOnly, true)
  assert.equal(after.evidence.nativeCodexAppVersion,before.evidence.nativeCodexAppVersion)
  if(native) assert.ok([before.evidence.nativeCodexAppVersion,'26.1103.60933'].includes(native.packageVersion),'Unreviewed native selector package '+native.packageVersion)
  if (after.provenance) assert.equal(after.provenance.sourceFixtureSha256, crypto.createHash('sha256').update(beforeBytes).digest('hex'))
  assert.equal(after.projects.length, 4)
  assert.equal(repairedIds.length, after.expected.restored)
  assert.equal(repairedIds.length, before.expected.restored)
  const visible = new Set(visibleThreads.map(thread => thread.id))
  const explicitProjectless = new Set(before.state['projectless-thread-ids'])
  for (const id of repairedIds) {
    assert.ok(visible.has(id))
    assert.equal(explicitProjectless.has(id), false)
  }
})

nativeTest('installed native project selectors reproduce ungrouped chats with empty native memberships', async t => {
  const h = harness(t, false)
  await h.guard.refresh()
  assert.equal(h.guard.status().ready, true)
  assert.equal(h.readMode(), 'codex')
  const groups = await h.readGroups()
  assert.equal(groups.projectGroups.length, 4)
  assert.deepEqual(inGroups(groups.projectGroups), [])
  const sidebar = await h.readSidebar()
  assert.equal(sidebar.layout.chatKeys.length, visibleThreads.length)
  assert.ok(h.observed.reads.includes('projectCatalog.readLocalProjects'))
  assert.ok(h.observed.reads.includes('threadProjectAssignments.readMemberships'))
  assert.ok(h.observed.reads.includes('workspaceRoots.read'))
  h.setData({ catalog: afterCatalog, memberships: after.memberships })
  await assertRepairedSidebar(h)
})

nativeTest('installed native project chain and final sidebar preserve projects and complete legacy memberships in pure API mode', async t => {
  const h = harness(t)
  const originalIdentity = h.readIdentity()
  assert.deepEqual(h.readLocalAccess(), { status: 'allowed', accountId: null })
  assert.deepEqual(h.readCloudAccess(), { status: 'denied', reason: 'unsupported-auth' })
  await h.guard.refresh()
  assert.equal(h.guard.status().ready, true)
  assert.equal(h.readMode(), 'codex')
  await assertRepairedSidebar(h)
  assert.deepEqual(h.readIdentity(), originalIdentity)
  assert.equal(h.readIdentity().hasChatGptToken, false)
  assert.equal(h.readIdentity().accountId, null)
  assert.deepEqual(h.readCloudAccess(), { status: 'denied', reason: 'unsupported-auth' })
})

nativeTest('installed native project sidebar survives repeated API official API transitions without changing membership or account permissions', async t => {
  const h = harness(t)
  await h.guard.refresh()
  for (let cycle = 0; cycle < 3; cycle++) {
    h.setIdentity(official)
    h.enable(false)
    await h.guard.refresh()
    await h.base.settings.publish({ ...official, policy: 'preference' })
    await h.registry('qixt').aK(h.scope, 'STEPS_PROSE')
    assert.equal(h.readMode(), 'work')
    await assertRepairedSidebar(h)
    assert.equal(h.readIdentity().authenticatedAccountId, official.accountId)
    h.setIdentity(api)
    h.enable(true)
    await h.guard.refresh()
    assert.equal(h.guard.status().ready, true)
    assert.equal(h.readMode(), 'codex')
    await assertRepairedSidebar(h)
    assert.equal(h.readIdentity().authenticatedAccountId, null)
    assert.equal(h.readIdentity().hasChatGptToken, false)
    assert.deepEqual(h.readCloudAccess(), { status: 'denied', reason: 'unsupported-auth' })
  }
})

nativeTest('fresh native selector scopes rehydrate the same repaired project catalog without relying on an official identity', async t => {
  for (let launch = 0; launch < 3; launch++) {
    const h = harness(t)
    await h.guard.refresh()
    assert.equal(h.guard.status().ready, true)
    await assertRepairedSidebar(h)
    assert.equal(h.readIdentity().accountId, null)
    assert.ok(h.observed.reads.includes('projectCatalog.readLocalProjects'))
    assert.ok(h.observed.reads.includes('threadProjectAssignments.readMemberships'))
  }
})
