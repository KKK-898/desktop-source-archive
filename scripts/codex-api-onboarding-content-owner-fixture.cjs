const assert = require('node:assert/strict')
const vm = require('node:vm')
const asar = require('@electron/asar')
const ts = require('typescript')
const crypto = require('node:crypto')

// Execute reviewed leaves of the installed package, not a reconstructed route
// or a made-up accountScopedPersistence flag. All host inputs are synthetic.
function contentOwnerOnboardingFixture(packagePath) {
  const version = JSON.parse(asar.extractFile(packagePath, 'package.json')).version
  assert.equal(version, '26.1111.21308', 'unreviewed native onboarding package')
  const files = asar.listPackage(packagePath).map(name => name.replace(/^[\\/]/, ''))
  const renderer = files.filter(f => /^webview[\\/]assets[\\/].*\.js$/.test(f))
  const main = files.filter(f => /\.vite[\\/]build[\\/].*\.js$/.test(f))
  const one = (items, name) => { assert.equal(items.length, 1, name); return items[0] }
  const sources = new Map(), trees = new Map()
  const read = file => {
    if (!sources.has(file)) sources.set(file, asar.extractFile(packagePath, file).toString())
    return sources.get(file)
  }
  const parse = (pool, marker) => {
    const file = one(pool.filter(file => read(file).includes(marker)), 'unique native source: ' + marker)
    if (!trees.has(file)) trees.set(file, ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS))
    return trees.get(file)
  }
  const find = (tree, predicate, label) => {
    const result = []
    const visit = node => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit) }
    visit(tree)
    return one(result, label)
  }
  const method = (tree, name) => find(tree, n => ts.isMethodDeclaration(n) && n.name.getText() === name, name).getText()
  const enumValues = (tree, member) => {
    const obj = find(tree, n => ts.isObjectLiteralExpression(n) && n.properties.some(p => p.name?.getText() === member), 'native enum ' + member)
    return Object.fromEntries(obj.properties.map(p => {
      assert.ok(ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isStringLiteral(p.initializer), 'only literal native keys')
      return [p.name.text, p.initializer.text]
    }))
  }
  const bundle = (source, id, deps, globals = {}, inHostRealm = false) => {
    const target = {}, req = key => {
      assert.ok(Object.hasOwn(deps, key), 'unreviewed native dependency: ' + key)
      return deps[key]
    }
    req.d = (target, getters, values) => {
      for (const [key, get] of Object.entries(getters || {})) Object.defineProperty(target, key, {get})
      Object.assign(target, values)
    }
    const factory = '({' + source + '})[' + JSON.stringify(id) + ']'
    const implementation = inHostRealm ? vm.runInThisContext(factory) : vm.runInNewContext(factory, globals)
    implementation({}, target, req)
    return target
  }
  const nativeMain = parse(main, 'async sendPersistedAtomState(')
  const bootstrapSource = method(nativeMain, 'getInitialSidebarBootstrap')
  const workspaceSource = method(nativeMain, 'getInitialSidebarWorkspaceState')
  const syncSource = method(nativeMain, 'sendPersistedAtomState')
  const updateSource = method(nativeMain, 'updatePersistedAtomState')
  assert.match(syncSource, /needsRendererContentOwner/)
  assert.match(syncSource, /confirmRendererContentOwner/)
  assert.match(syncSource, /renderersWithoutAccountState/)
  const routeTree = parse(renderer, 'backendOnboardingCompleted:')
  const gateNode = find(routeTree, n => ts.isFunctionExpression(n) && n.parameters.length === 1
    && ts.isObjectBindingPattern(n.parameters[0].name)
    && n.parameters[0].name.elements.some(p => p.propertyName?.getText(routeTree) === 'projectlessOnboardingCompleted')
    && n.parameters[0].name.elements.some(p => p.propertyName?.getText(routeTree) === 'gatewayOAuthReadiness'), 'native auth/onboarding route')
  const gate = vm.runInNewContext('(' + gateNode.getText(routeTree) + ')')
  const renderSource = find(routeTree, n => ts.isFunctionExpression(n) && n.parameters.length === 0 && n.body.statements.some(s => ts.isVariableStatement(s) && s.getText().includes('backendOnboardingCompleted:')), 'native onboarding renderer').getText()
  const redirectSource = method(routeTree, 'eX9b')
  const storeTree = parse(renderer, 'Persisted atom store accessed before initialization')
  const storeSource = method(storeTree, 'kpIY')
  const keysTree = parse(main, 'OPEN_IN_TARGET_PREFERENCES:"open-in-target-preferences"')
  const nativeKeys = {Q2Y: enumValues(keysTree, 'OPEN_IN_TARGET_PREFERENCES'), aiU: enumValues(keysTree, 'LAST_COMPLETED_ONBOARDING')}
  // Only these two tab prefixes from the native constants module are needed.
  for (const key of ['aU6', 'i0d']) {
    const decl = find(keysTree, n => ts.isPropertyAssignment(n) && n.name.getText() === key, key).initializer
    assert.ok(ts.isArrowFunction(decl) && ts.isIdentifier(decl.body), 'native tab prefix export')
    const literal = find(keysTree, n => ts.isVariableDeclaration(n) && n.name.getText() === decl.body.text && ts.isStringLiteral(n.initializer), 'tab prefix ' + key)
    nativeKeys[key] = literal.initializer.text
  }
  const bootKeys = find(nativeMain, n => ts.isVariableDeclaration(n) && n.name.getText() === 'ew9' && ts.isArrayLiteralExpression(n.initializer), 'API bootstrap keys').initializer.elements.map(item => {
    assert.ok(ts.isPropertyAccessExpression(item) && item.expression.getText() === 'e1.Q2Y' && Object.hasOwn(nativeKeys.Q2Y, item.name.text))
    return nativeKeys.Q2Y[item.name.text]
  })
  const ownerTree = parse(main, 'get needsRendererContentOwner()')
  const ownerClass = find(ownerTree, n => ts.isClassDeclaration(n) && n.members.some(m => m.name?.getText() === 'confirmContentOwner'), 'native owner class')
  const ownerNames = ['prepareForRenderer', 'needsRendererContentOwner', 'confirmRendererContentOwner', 'confirmContentOwner', 'storageKey', 'getStored', 'get', 'setPersistedAtom', 'set', 'writeValue', 'update', 'persistForKey']
  const ownerSource = ownerNames.map(name => one(ownerClass.members.filter(m => m.name?.getText() === name), name).getText()).join(',')
  const ownerModule = method(ownerTree, '60656')
  const dbModule = find(ownerTree, n => ts.isMethodDeclaration(n) && n.name.getText() === '6599', 'native storage module')
  const dbPrefix = find(dbModule, n => ts.isVariableDeclaration(n) && n.initializer && ts.isStringLiteral(n.initializer) && n.initializer.text === 'electron-owner-atoms:', 'owner atom prefix')
  assert.match(dbModule.getText(), new RegExp('ze:' + dbPrefix.name.getText() + '[},]'))
  const owner = bundle(ownerModule, '60656', {78335: crypto, 64109: nativeKeys, 6599: {ze: dbPrefix.initializer.text}}, {}, true)
  const archiveModule = find(ownerTree, n => ts.isMethodDeclaration(n) && n.name.getText() === '31447', 'native archives keys')
  const archiveKey = find(archiveModule, n => ts.isPropertyAssignment(n) && n.name.getText() === 'o' && ts.isStringLiteral(n.initializer), 'native archive key').initializer.text
  const rpcSource = method(ownerTree, '67221')
  const rpcExports = bundle(rpcSource, '67221', {}, {}, true)
  const rpcFacade = methods => {
    class LocalTarget extends rpcExports.TF {}
    for (const [key, method] of Object.entries(methods)) LocalTarget.prototype[key] = method
    return new rpcExports.AX(new LocalTarget())
  }
  const tabFn = find(nativeMain, n => ts.isFunctionDeclaration(n) && n.name?.text === 'es8', 'primary window tab keys')
  const isPrimaryKey = vm.runInNewContext('(' + tabFn.getText() + ')', {e1: nativeKeys})
  const unreadModule = find(ownerTree, n => ts.isMethodDeclaration(n) && n.name.getText() === '70909', 'unread state module')
  const unreadKey = find(unreadModule, n => ts.isPropertyAssignment(n) && n.name.getText() === 'yz' && ts.isStringLiteral(n.initializer), 'native reserved unread key').initializer.text
  const atomsKey = owner.Oq, ownerKey = owner.Ww, completionKey = nativeKeys.aiU.PROJECTLESS_ONBOARDING_COMPLETED, timeKey = nativeKeys.aiU.LAST_COMPLETED_ONBOARDING

  const loginTree = parse(renderer, 'electron.onboarding.login.gateway.finishError')
  const loginModule = find(loginTree, n => ts.isMethodDeclaration(n) && n.name.getText() === 'Xhdp', 'native login renderer')
  const loginSource = find(loginModule, n => ts.isArrowFunction(n) && ts.isBlock(n.body) && n.body.statements.some(s => ts.isVariableStatement(s) && s.getText().includes('new AbortController'))
    && n.getText().includes('.loginWithApiKey(') && n.getText().includes('"/welcome"'), 'native API login callback').getText()
  const finishGatewaySource = find(loginModule, n => ts.isArrowFunction(n) && ts.isBlock(n.body) && n.body.statements[0]?.getText() === 'if(null==tl)return!0;'
    && n.getText().includes('electron.onboarding.login.gateway.finishError'), 'native optional gateway completion').getText()
  const completeTree = parse(renderer, 'n.set(f.IF,!0)')
  const completeModule = find(completeTree, n => ts.isMethodDeclaration(n) && n.name.getText() === 'SNrc', 'native onboarding renderer')
  const completeSource = find(completeModule, n => ts.isArrowFunction(n) && ts.isBlock(n.body) && n.body.statements.some(s => ts.isIfStatement(s) && s.expression.getText().includes('n.set(f.IF,!0)')), 'native completion continuation').getText()
  const atomDefs = method(storeTree, 'bdDz')
  const preload = parse(main.filter(f => f.endsWith('preload.js')), 'getDesktopUserAgent:')
  const userAgentFn = find(preload, n => ts.isPropertyAssignment(n) && n.name.getText() === 'getDesktopUserAgent' && ts.isArrowFunction(n.initializer), 'native version bridge').initializer
  assert.match(userAgentFn.getText(), /appVersion:p\.appVersion/)
  const getDesktopUserAgent = vm.runInNewContext('(' + userAgentFn.getText() + ')', {p: {appVersion: version}, process: {platform: 'win32', arch: 'x64'}, s: {win32: 'Windows NT 10.0'}})

  // Private inputs are never imported. A null catalog and principal exercise
  // the host's actual API bootstrap and hydration branches. The workspace
  // provider's result is also obtained from the native method, since it is
  // spread into bootstrap and could otherwise hide an isolation field.
  const create = ({atoms = {}, previousOwner = null, syntheticOwner, principal = null, pendingAccountChange = null, globals = {}, deferPublishes = false} = {}) => {
    const noEffect = () => {}, messages = [], publishes = [], pendingPublishes = [], navigation = [], loginRequests = []
    const hostScope = {a$: {n: 'local'}, ew9: bootKeys, e1: {...nativeKeys, mdc: o => o.configuredWorkspaceRoot,
      Szl: {projectlessWorkspaceRoot: {key: 'synthetic-workspace-root'}}}, ts: p => p, eJ: {}, e9: {homedir: () => '/synthetic-home'},
      es8: isPrimaryKey, esI: {yz: unreadKey}, G9: owner}
    const native = vm.runInNewContext('({' + [bootstrapSource, workspaceSource, syncSource, updateSource].join(',') + '})', hostScope)
    const workspaces = {getInitialSidebarWorkspaceState: native.getInitialSidebarWorkspaceState, shouldUseWslPaths: () => false,
      projectsManager: {getInitialLocalWorkspaceRootOptions: () => []}, settingsStore: {getEffective: () => '/synthetic-root'}}
    const connection = {getRequestAuthenticatedPrincipal: async () => principal, getCachedAuthenticatedPrincipal: () => principal,
      getPendingAccountChange: () => pendingAccountChange, getAccount: async () => ({account: {type: principal ? 'chatgpt' : 'apiKey'}})}
    const data = new Map(Object.entries(globals))
    if (Object.keys(atoms).length) data.set(atomsKey, {...atoms})
    if (previousOwner) data.set(ownerKey, owner.s6(previousOwner))
    else if (syntheticOwner != null) data.set(ownerKey, syntheticOwner)
    const globalState = {state: data, changeListeners: new Map(), storedOwnerGeneration: 0,
      markChanged: noEffect, persistDebounced: noEffect, queueGlobalStatePersistence: noEffect}
    const methods = vm.runInThisContext('(function(_,u,j){return {' + ownerSource + '}})')(owner, {...nativeKeys, yDt: () => null}, {o: archiveKey})
    Object.defineProperties(globalState, Object.getOwnPropertyDescriptors(methods))
    globalState.prepareForRenderer()
    const host = {threadCatalogSyncManager: null, appServerConnectionRegistry: {getMaybeConnection: () => connection},
      desktopServices: {workspaces, applicationState: {getGlobalStateValue: key => globalState.get(key)}}}
    const win = {electronBridge: {getInitialSidebarBootstrap: native.getInitialSidebarBootstrap.bind(host), getDesktopUserAgent},
      localStorage: {length: 0, getItem: () => null, removeItem: noEffect}}
    const persisted = bundle(storeSource, 'kpIY', {waIq: {m: () => { throw Error('unexpected record update') }},
      owEK: {Uy: 'synthetic-custom-sections'}}, {window: win, setTimeout, clearTimeout})
    const view = {isDestroyed: () => false}
    const flushPublishes = () => {for (const {key, value} of pendingPublishes.splice(0)) native.updatePersistedAtomState.call(mainHandler, view, key, value)}
    const publish = (key, value) => {
      publishes.push({key, value})
      if (deferPublishes) pendingPublishes.push({key, value})
      else native.updatePersistedAtomState.call(mainHandler, view, key, value)
    }
    persisted.A2({}, publish)

    const mainHandler = {globalState,
      getAppServerConnection: () => connection, sendMessageToView: (_, message) => messages.push(message),
      broadcastPersistedAtomUpdate: (_, key, value) => persisted.JQ(key, value),
      windowManager: {accountWindows: {generation: 0, isCovered: () => false, renderersWithoutAccountState: new Set()}, shouldSyncPersistedAtom: () => true},
      browserHostManager: {isPrimaryWindowPersistenceOwner: () => true}}
    const hydrate = async () => {
      await native.sendPersistedAtomState.call(mainHandler, view)
      assert.equal(messages.at(-1)?.type, 'persisted-atom-sync')
      persisted.A2(messages.at(-1).state, publish); persisted.Ki('host')
      return messages.at(-1).state
    }
    const evaluate = (patch = {}) => gate({auth: {authMethod: 'apikey', hasChatGptToken: false, isLoading: false, requiresAuth: true},
      codexFeatureAccess: {status: 'allowed'}, isOnboardingContextFetched: true, projectlessOnboardingCompleted: persisted.TB(completionKey, false),
      forcedOverride: persisted.TB('electron:onboarding-override', 'auto') === 'auto' ? null : persisted.TB('electron:onboarding-override'), workspaceRootsData: {roots: []}, ...patch})
    const redirect = bundle(redirectSource, 'eX9b', {DBCl: {$kD: '/synthetic-exempt'}, e3vf: {E: dest => dest}}, {URLSearchParams})
    const render = (path = '/welcome', patch = {}) => {
      const values = new Map([['override', persisted.TB('electron:onboarding-override', 'auto')], ['completed', persisted.TB(completionKey, false)], ['previous', persisted.TB(completionKey, false)],
        ['roots', {isLoading: false, isPending: false, data: {roots: []}}], ['readiness', 'ready'], ['fetching', {isFetching: false}], ['logReady', true]])
      const location = {pathname: path, search: '', hash: ''}, read = key => values.get(key)
      const inputs = {c: {c: size => Array(size).fill(Symbol.for('react.memo_cache_sentinel'))}, u: {useContext: () => false, useEffect: noEffect, useLayoutEffect: noEffect,
        useRef: () => ({current: false}), useState: () => [undefined, noEffect]}, E: {gh: () => ({get: read, set: noEffect, watch: () => noEffect}), Ul: read}, j: {u: 'scope'},
        C: {zy: () => location, $P: noEffect, C5: 'Navigate', sv: 'Outlet'}, tz: {As: () => ({authMethod: 'apikey', hasChatGptToken: false, requiresAuth: true, isLoading: false, ...patch.auth})},
        tU: {A: () => ({formatMessage: noEffect})}, tZ: {wA: 'context'}, tq: {f2: 'gateway'}, t6: {sW: 'bedrock'}, nn: 'verification', nt: 'fetching', tV: {mN: 'gatewayPending', Zg: 'readiness'},
        eK: {dE: () => patch.featureAccess || {status: 'allowed'}}, tJ: {Pk: 'workspace', c0: 'switch'}, tW: {wD: () => ({data: null, isFetched: true, isLoading: false})},
        ni: {_m: 'override', IF: 'completed', $f: 'previous'}, nr: {U: 'timedOut'}, tF: {cU: 'logReady'}, t2: 'cloudEnvironment', tY: {zk: 'roots'}, t5: redirect,
        i: {jsx: (type, props) => ({type, props})}, tX: {c: 'Loading'}, t8: {o: 'Verification'}, na: {m: 'LoginRecovery'}}
      return vm.runInNewContext('(' + renderSource + ')', inputs)()
    }
    const scope = {get: key => persisted.TB(key), set: (key, value) => persisted.jx(key, value)}
    const descriptors = bundle(atomDefs, 'bdDz', {zTeN: {un: noEffect}, gbrq: {IT: noEffect}, OWtl: {u: 'scope'}, ndjw: {},
      Nwp9: {m3: key => key}, jNDj: {F6: completionKey, ZJ: timeKey}, Zbs9: {}})
    const login = async () => {
      const finishGateway = vm.runInNewContext('(' + finishGatewaySource + ')', {tl: null})
      const globals = {e5: 'synthetic-api-key', e9: false, eD: {}, ez: {status: 'ready', api: true}, AbortController, e8: noEffect,
        c: {ls: () => ({loginWithApiKey: async key => {assert.equal(key, 'synthetic-api-key'); loginRequests.push('apiKey')}})}, eN: scope, x: {fI: 'local'},
        tM: finishGateway, R: {yy: noEffect}, k: {CodexLoginSuccess: 'success', CodexLoginFailure: 'failure'}, eM: false, eL: noEffect,
        th: noEffect, E: descriptors, L: {Z: 'synthetic-entry'}, eE: dest => navigation.push(dest), eB: path => path,
        eK: String, eF: message => {throw Error(message)}, a: {Rt_: String}}
      await vm.runInNewContext('(' + loginSource + ')', globals)()
    }
    const complete = (seconds = 1794134871) => {
      const globals = {P: 'auto', n: scope, f: descriptors, i: {accountId: null}, y: {roles: ['engineering'], workMode: 'coding'}, Date: {now: () => seconds * 1000},
        _: {x2: 'synthetic-location'}, e: undefined, t: '/', d: path => navigation.push(path), M: null, a: null, B: noEffect}
      return vm.runInNewContext('(' + completeSource + ')', globals)()
    }
    return {hydrate, evaluate, render, login, complete, navigation, loginRequests, publishes, flushPublishes, messages, persisted, scope, globalState, window: win, record: {source: storeSource, exports: persisted},
      setPrincipal: value => {principal = value}, setPendingAccountChange: value => {pendingAccountChange = value}, selectOwner: value => globalState.confirmRendererContentOwner(value)}
  }
  return {create, completionKey, timeKey, atomsKey, ownerKey, ownerContract: owner, globalKeys: nativeKeys.Q2Y, sharedKeys: Object.values(nativeKeys.aiU), rpcExports, rpcFacade, preservesSharedApiAtoms: true}
}

module.exports = {contentOwnerOnboardingFixture}
