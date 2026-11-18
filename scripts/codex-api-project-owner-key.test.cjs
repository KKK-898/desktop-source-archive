const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const asar = require('@electron/asar')
const ts = require('typescript')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')
const { nativeOnboardingFixture } = require('./codex-api-onboarding-native-fixture.cjs')
const { contentOwnerOnboardingFixture } = require('./codex-api-onboarding-content-owner-fixture.cjs')

const load = (file, name) => vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src-tauri/src/' + file), 'utf8') + '\n' + name)
const bind = load('codex_api_mode_bindings.js', 'codexApiModeLocalOnboardingBindings')
const create = load('codex_api_mode_runtime.js', 'createCodexApiLocalProjectsGuard')
const empty = () => ({version: 1, scope: 'synthetic', revision: 1, runtimeRevision: 1,
  globals: {'local-projects': {}}, memberships: {assignments: {}, projectlessThreadIds: []}})

function one(items, label) { assert.equal(items.length, 1, label); return items[0] }
function nodes(root, predicate) {
  const result = []
  function visit(n) { if (predicate(n)) result.push(n); ts.forEachChild(n, visit) }
  visit(root)
  return result
}

// Resolve the key from the installed owner manager, through its actual module
// import/export when necessary. Merely finding the old key in a migration
// would not establish that it still represents the current owner.
function nativeOwnerKey(packagePath) {
  const version = JSON.parse(asar.extractFile(packagePath, 'package.json')).version
  const legacy = ['26.1103.32239', '26.1103.60933'].includes(version)
  assert.ok(legacy || version === '26.1111.21308', 'Unreviewed native project owner contract: ' + version)
  const files = asar.listPackage(packagePath).map(name => name.replace(/^[\\/]/, ''))
    .filter(name => /^\.vite[\\/]build[\\/].*\.js$/.test(name))
    .map(name => ({name, text: asar.extractFile(packagePath, name).toString()}))
  const tree = f => f.tree ??= ts.createSourceFile(f.name, f.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const factory = n => ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent) && n.parameters.length === 3 && ts.isNumericLiteral(n.name)
  const methodName = legacy ? 'hasAccountScopedRendererState' : 'confirmContentOwner'
  const marker = legacy ? 'get ' + methodName + '(' : methodName + '('
  const method = one(files.filter(f => f.text.includes(marker)).flatMap(f => nodes(tree(f), n =>
    (legacy ? ts.isGetAccessorDeclaration(n) : ts.isMethodDeclaration(n)) && n.name.text === methodName)), 'native owner manager ' + methodName)
  let module = method.parent
  while (module && !factory(module)) module = module.parent
  assert.ok(module, 'native owner manager module')
  const stateCalls = (n, operations) => nodes(n, call => ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
    && operations.includes(call.expression.name.text) && ['this.state', 'this'].includes(call.expression.expression.getText()))
  const refs = legacy ? stateCalls(method, ['has', 'get']) : stateCalls(method, ['set']).filter(n =>
    n.arguments.length === 2 && ts.isIdentifier(n.arguments[1]) && n.arguments[1].text === method.parameters[0].name.text)
  const keyRef = one(refs, 'native active-owner state reference').arguments[0]
  if (legacy) {
    const select = one(method.parent.members.filter(n => ts.isMethodDeclaration(n) && n.name.text === 'selectRendererOwner'), 'legacy owner selector')
    assert.ok(stateCalls(select, ['get', 'set', 'has']).some(n => n.arguments[0]?.getText() === keyRef.getText()), 'legacy selector uses its own active-owner key')
  }

  const local = (m, id) => one(m.body.statements.filter(ts.isVariableStatement)
    .flatMap(s => [...s.declarationList.declarations]).filter(d => d.name.text === id), 'native owner key binding ' + id).initializer
  let value = keyRef
  if (ts.isPropertyAccessExpression(value)) {
    const imported = local(module, value.expression.text)
    assert.ok(ts.isCallExpression(imported) && imported.expression.getText() === module.parameters[2].name.text
      && imported.arguments.length === 1 && ts.isNumericLiteral(imported.arguments[0]), 'direct native owner-key import')
    const id = imported.arguments[0].text, exportedName = value.name.text
    module = one(files.filter(f => f.text.includes(id + '(')).flatMap(f => nodes(tree(f), n => factory(n) && n.name.text === id)), 'native owner-key helper ' + id)
    const exports = nodes(module.body, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === 'd' && n.expression.expression.getText() === module.parameters[2].name.text
      && n.arguments[0]?.getText() === module.parameters[1].name.text)
    const property = one(exports.flatMap(n => [...n.arguments].slice(1).filter(ts.isObjectLiteralExpression)
      .flatMap(map => [...map.properties])).filter(p => ts.isPropertyAssignment(p) && p.name.text === exportedName), 'exported native owner-key constant')
    value = property.initializer
    if (ts.isArrowFunction(value) && !value.parameters.length) value = value.body
  }
  if (ts.isIdentifier(value)) value = local(module, value.text)
  assert.ok(value && ts.isStringLiteral(value) && value.text.length > 0, 'literal native active-owner key')
  return {version, key: value.text}
}

async function observe(onboarding, answer, enabled = true) {
  const snapshot = empty()
  const calls = []
  const call = (name, args) => { calls.push([name, ...args]); return answer(name, args) }
  const services = Object.fromEntries(['applicationState', 'projectCatalog', 'threadProjectAssignments'].map(service => [service, new Proxy({}, {
    get: (_, method) => (...args) => call(`${service}.${method}`, args),
  })]))
  const guard = create({appServices: services, localOnboarding: onboarding}, {
    getState: () => ({apiCodingModeEnabled: enabled, apiLocalProjects: snapshot}), bridge: (...args) => call('bridge', args),
  })
  await guard.synchronize(snapshot, () => true)
  assert.equal(guard.status().ready, false)
  return {calls, status: guard.status()}
}

test('installed native project guard checks the active owner before accessing project data', async () => {
  const packagePath = process.env.CODEX_API_MODE_ASAR || process.env.CODEX_NATIVE_APP_ASAR || installedAsar()
  const {version, key} = nativeOwnerKey(packagePath)
  const f = (version === '26.1111.21308' ? contentOwnerOnboardingFixture : nativeOnboardingFixture)(packagePath)
  const h = f.create()
  await h.hydrate()
  const adapter = bind([h.record], {window: h.window})
  const result = await observe(adapter, () => { throw Error('Owner observation complete') })
  assert.deepEqual(result.calls, [['applicationState.read', key]], `First request must identify the current owner on host ${version}; no project data was supplied`)
  assert.equal(h.publishes.length, 0)
})

test('unconfirmed scopes and malformed owner receipts never touch project data', async () => {
  const adapter = contract => ({hostReady: () => true, projectOwnerContract: () => contract})
  for (const contract of ['renderer-owner', 'content-owner']) {
    const key = contract === 'renderer-owner' ? 'electron-account-renderer-state-v1' : 'electron-renderer-content-owner'
    const invalid = [undefined, null, {}, [], {owner: 'fixture'}, Object.create({owner: null}),
      contract === 'renderer-owner' ? 'signed-out' : {owner: null}]
    for (const value of invalid) {
      const {calls} = await observe(adapter(contract), () => ({value}))
      assert.deepEqual(calls, [['applicationState.read', key]])
    }
    const {calls} = await observe(adapter(contract), () => { throw Error('Unexpected service call') }, false)
    assert.deepEqual(calls, [])
  }
  for (const contract of ['future-contract', undefined]) {
    const {calls, status} = await observe(adapter(contract), () => { throw Error('Unexpected service call') })
    assert.deepEqual(calls, [])
    assert.equal(status.reason, 'unknown-native-project-owner')
  }
})
