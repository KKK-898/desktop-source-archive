const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const asar = require('@electron/asar')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')
const { nativeOnboardingFixture } = require('./codex-api-onboarding-native-fixture.cjs')

const nativeFunction = (file, name) => vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '../src-tauri/src', file), 'utf8') + '\n' + name + ';')

test('installed API project guard rejects legacy snapshots on the native shared store', async () => {
  const packagePath = process.env.CODEX_API_MODE_ASAR || process.env.CODEX_NATIVE_APP_ASAR || installedAsar()
  const version = JSON.parse(asar.extractFile(packagePath, 'package.json')).version
  const onboarding = nativeOnboardingFixture(packagePath)
  // A fresh store need not select any owner. An ordinary shared onboarding
  // preference makes the host reconcile its own content owner during hydrate.
  const h = onboarding.create({ atoms: { [onboarding.completionKey]: false } })
  await h.hydrate()
  const calls = []
  const forbidden = operation => () => { calls.push(operation); throw Error('Unexpected ' + operation) }
  const original = h.window.electronBridge
  const window = { electronBridge: { ...original, getInitialSidebarBootstrap: forbidden('sidebar bootstrap') } }
  const createOnboarding = nativeFunction('codex_api_mode_bindings.js', 'codexApiModeLocalOnboardingBindings')
  const guardFactory = nativeFunction('codex_api_mode_runtime.js', 'createCodexApiLocalProjectsGuard')

  // Legacy bootstrap is its reviewed source of the partition flag. Its positive
  // restore and shutdown behavior is covered by the separate 26-case suite.
  if (['26.1103.32239', '26.1103.60933'].includes(version)) {
    const legacy = createOnboarding([h.record], { window: h.window })
    assert.equal(legacy.projectOwnerContract(), 'renderer-owner')
    const unscopedHost = onboarding.create({ accountScoped: false })
    await unscopedHost.hydrate()
    const unknown = createOnboarding([unscopedHost.record], { window: unscopedHost.window })
    assert.equal(unknown.hostReady(), true)
    assert.equal(unknown.projectOwnerContract(), null)
    const snapshot = emptySnapshot()
    const guard = guardFactory({ get appServices() { return forbidden('project services')() }, localOnboarding: unknown },
      { getState: () => ({ apiCodingModeEnabled: true, apiLocalProjects: snapshot }), bridge: forbidden('CAS') })
    await guard.synchronize(snapshot, () => true)
    assert.equal(guard.status().ready, false)
    assert.deepEqual(calls, [])
    guard.dispose()
    return
  }

  assert.equal(version, '26.1111.21308', 'unreviewed content-owner package')
  const { contentOwnerProjectBoundary } = require('./codex-api-project-state-native-fixture.cjs')
  const boundary = contentOwnerProjectBoundary(packagePath, onboarding)
  assert.deepEqual(boundary.unscopedKeys, ['local-projects', 'thread-project-assignments', 'projectless-thread-ids'])
  // Verify the effective storage addresses as well as the registry. Project
  // values are unnecessary; workspace roots/labels are the isolated control.
  const ownerProbe = onboarding.create({ atoms: { [onboarding.completionKey]: false } })
  await ownerProbe.hydrate()
  const roots = ['WORKSPACE_ROOT_OPTIONS', 'WORKSPACE_ROOT_LABELS'].map(name => onboarding.globalKeys[name])
  const principals = [{ userId: 'synthetic-user-a', accountId: 'synthetic-account-a' }, null,
    { userId: 'synthetic-user-b', accountId: 'synthetic-account-b' }]
  const workspaceAddresses = principals.map(principal => {
    ownerProbe.setPrincipal(principal)
    ownerProbe.selectOwner(principal)
    assert.equal(ownerProbe.globalState.get(onboarding.ownerKey), onboarding.ownerContract.s6(principal))
    const address = key => ownerProbe.globalState.storageKey(key)
    assert.deepEqual(boundary.projectKeys.map(address), boundary.projectKeys, 'project keys stay global after an owner change')
    return roots.map(address)
  })
  for (const i of roots.keys()) {
    assert.equal(new Set(workspaceAddresses.map(addresses => addresses[i])).size, principals.length,
      'native workspace state uses a different address for each owner')
  }
  const adapter = createOnboarding([h.record], { window })
  assert.equal(adapter.hostReady(), true)
  assert.equal(adapter.projectOwnerContract(), 'content-owner')
  const key = onboarding.ownerKey
  assert.equal(h.globalState.get(key), 'signed-out')
  const applicationState = boundary.nativeApplicationState(requested => {
    calls.push('read ' + requested)
    assert.equal(requested, key, 'only the active owner may be observed')
    return h.globalState.get(key)
  }, forbidden('state write'))
  const services = { applicationState: { read: key => applicationState.read(key), write: forbidden('state write RPC') },
    get projectCatalog() { return forbidden('project catalog')() },
    get threadProjectAssignments() { return forbidden('project memberships')() } }
  const snapshot = emptySnapshot()
  const guard = guardFactory({ appServices: services, localOnboarding: adapter }, {
    getState: () => ({ apiCodingModeEnabled: true, apiLocalProjects: snapshot }), bridge: forbidden('CAS'),
  })
  for (let i = 0; i < 2; i++) {
    await guard.synchronize(snapshot, () => true)
    const status = guard.status()
    assert.equal(status.reason, 'awaiting-native-shared-project-grant')
    assert.equal(status.ready, false)
    assert.equal(status.hydrated, false)
    assert.equal(status.revision, null)
    assert.equal(h.publishes.length, 0)
  }
  assert.deepEqual(calls, ['read ' + key, 'read ' + key])
  guard.dispose()
})

function emptySnapshot() {
  return { version: 1, scope: 'synthetic', revision: 1, runtimeRevision: 1,
    checkpoint: { version: 1, revision: 1, nonce: 'synthetic-receipt' },
    globals: { 'local-projects': {} }, memberships: { assignments: {}, projectlessThreadIds: [] } }
}
