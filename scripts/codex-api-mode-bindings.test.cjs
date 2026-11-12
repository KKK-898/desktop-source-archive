const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')

const bindingsSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_api_mode_bindings.js'), 'utf8')
const runtimeSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_api_mode_runtime.js'), 'utf8')
let packagePath = process.env.CODEX_API_MODE_ASAR || process.env.CODEX_NATIVE_APP_ASAR
let unavailable
if (!packagePath) {
  try { packagePath = installedAsar() } catch (error) { unavailable = error.message }
}
const isWebpack = packagePath && !require('@electron/asar').listPackage(packagePath).some(name => /app-initial-[^\\/]+\.js$/.test(name))
const legacyTest = isWebpack ? () => {} : test
const nativeOptions = { skip: !packagePath && `Installed Codex required: ${unavailable}` }
const one = (values, label) => { assert.equal(values.length, 1, label); return values[0] }
const capture = (source, pattern, label) => {
  const match = pattern.exec(source)
  assert.ok(match, label)
  return match
}

// Only these reviewed native functions execute. Application/account initializers
// are inert dependencies; real native scope/signal/derived/React code is retained.
function rendererFixture(source) {
  const tree = ts.createSourceFile('initial.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const functions = tree.statements.filter(ts.isFunctionDeclaration)
  const find = predicate => one(functions.filter(node => predicate(node.getText(tree))), 'native renderer function')
  const named = name => one(functions.filter(node => node.name?.text === name), `native ${name}`)
  const text = node => node.getText(tree)
  const setter = find(value => value.includes('previousThreadDetailLevel:') && value.includes('{optimistic:!1}'))
  const setterText = text(setter)
  const setterVars = capture(setterText, /let [\w$]+=[\w$]+\.get\(([\w$]+)\),[\w$]+=[\w$]+\.get\(([\w$]+)\)/, 'setter reads')
  const modeName = setterVars[1], optimisticName = setterVars[2]
  const modeHook = find(value => new RegExp(`^function [\\w$]+\\(\\)\\{return [\\w$]+\\(${modeName}\\)\\}$`).test(value))
  const signalHook = capture(text(modeHook), /return ([\w$]+)\(/, 'native mode hook')[1]
  const init = find(value => new RegExp(modeName + '=([\\w$]+)\\(([\\w$]+),\\(\\{get:').test(value))
  const modeParts = capture(text(init), new RegExp(modeName + '=([\\w$]+)\\(([\\w$]+),\\(\\{get:[\\w$]+\\}\\)=>[\\w$]+\\(([\\w$]+)\\)'), 'mode derived')
  const policyInit = find(value => value.includes('reason===`unsupported-auth`)return`coding`') && value.includes('workModeAccess==null'))
  const policyText = text(policyInit)
  const policy = capture(policyText, /let [\w$]+=[\w$]+\(([\w$]+)\);if\([\w$]+\.status===`denied`&&[\w$]+\.reason===`unsupported-auth`\)return`coding`;let [\w$]+=[\w$]+\(([\w$]+)\)/, 'policy inputs')
  const signalFactory = capture(policyText, new RegExp(optimisticName + '=([\\w$]+)\\('), 'signal factory')[1]
  const normalize = find(value => value.startsWith('function ') && value.includes('return e===`STEPS_EXECUTION`?') && value.length < 160)
  const syncName = capture(setterText, /\.set\([\w$]+,[\w$]+\),([\w$]+)\([\w$]+\)\)/, 'rollback initializer')[1]
  const sync = named(syncName)
  const metadata = capture(setterText, /let [\w$]+=([\w$]+)\([\w$]+,([\w$]+)\.conversationDetailMode,/, 'setting writer')
  const loggerName = capture(setterText, /\.get\(([\w$]+)\)\.logProductEvent\(/, 'logger descriptor')[1]
  const authName = capture(source, /([\w$]+)=[\w$]+\([\w$]+,\(\{scope:[\w$]+\}\)=>\{let [\w$]+=[\w$]+\.get\([\w$]+\);return\{accountId:null,accountLoading:!0,accountStructure:null,accountUserId:/, 'auth descriptor')[1]
  const authInputName = capture(source, /([\w$]+)=[\w$]+\([\w$]+,\(\)=>\(\{accountId:null,accountInfoError:!1,accountInfoLoading:!0,authLoading:!0,authMethod:null,plan:null,supportedSurface:!0,workCloudSupportedSurface:!0/, 'access input')[1]
  const statsigName = capture(source, /\([\w$]+,\{get:([\w$]+)\}\)=>\1\(([\w$]+)\)\?\.getFeatureGate\(/, 'Statsig descriptor')[2]
  const bridgeName = capture(policyText, /([\w$]+)\?\.workModeAccess==null/, 'services')[1]
  const settingsReaders = [...policyText.matchAll(/([\w$]+)\([\w$]+,[\w$]+\.conversationDetailMode\)/g)].map(match => match[1])
  const access = find(value => value.includes('workCloud:') && value.includes('workLocal:') && value.includes('reason:`unsupported-auth`'))
  const accessText = text(access)
  const leafName = capture(accessText, /let [\w$]+=([\w$]+)\(\{\.\.\./, 'access leaf')[1]
  const voiceName = capture(accessText, /voice:([\w$]+)\(/, 'voice access')[1]
  const leaf = named(leafName)
  const plansName = capture(text(leaf), /:([\w$]+)\([\w$]+\)\?\{status:`allowed`/, 'plan check')[1]
  const plans = named(plansName)
  const planArray = capture(text(plans), /return ([\w$]+)\.includes/, 'plan array')[1]
  const planInit = find(value => value.includes(`${planArray}=[\`free\`,\`go\``))
  const combine = find(value => value.includes('return e.status===`allowed`?e:t.status===`allowed`?t:'))
  const selection = find(value => value.includes('codexLocalAccessStatus:') && value.includes('nextMode:') && value.includes(`${setter.name.text}(`))
  const heading = find(value => value.includes('codexAvailable:') && value.includes('onModeSelect:') && value.includes('workModeAccess:') && value.includes('useRef'))
  const headingText = text(heading)
  const controlDependencies = {
    compiler: capture(headingText, /let [\w$]+=\(0,([\w$]+)\.c\)/, 'mode compiler')[1],
    react: capture(headingText, /\(0,([\w$]+)\.useRef\)/, 'mode React')[1],
    jsx: capture(headingText, /\(0,([\w$]+)\.jsx\)/, 'mode JSX')[1],
    intl: capture(headingText, /,[\w$]+=([\w$]+)\(\),[\w$]+=\(0,[\w$]+\.useRef\)/, 'mode messages')[1],
    labels: capture(headingText, /,[\w$]+=([\w$]+)\.chatGptWork,/, 'mode labels')[1],
    access: capture(headingText, /===([\w$]+)\.ChatGpt/, 'mode access enum')[1],
    menu: capture(headingText, /[\w$]+=([\w$]+),[\w$]+=`start`/, 'mode menu')[1],
    button: capture(headingText, /[\w$]+=4,[\w$]+=([\w$]+),[\w$]+=`min-w-max/, 'mode button')[1],
    items: capture(headingText, /\)\(([\w$]+)\.Item,/, 'mode menu items')[1],
  }
  const headingParent = find(value => value.includes(`)(${heading.name.text},`) && value.includes(`${selection.name.text}(`))
  const publish = find(value => value.includes('Failed to publish work-mode access'))
  const publishText = text(publish)
  assert.match(publishText, /[\w$]+=typeof ([\w$]+)\.custom\?\.auth_method==`string`\?\1\.custom\.auth_method:null/, 'publish uses user.custom.auth_method')
  assert.match(publishText, /\.workModeAccess\.publish\(\{userId:([\w$]+)\.userID\?\?null,accountId:\1\.customIDs\?\.account_id\?\?null,authMethod:[\w$]+,stableId:\1\.customIDs\?\.stableID\?\?null,policy:/)
  assert.match(text(selection), new RegExp(`${setter.name.text}\\([\\w$]+,[\\w$]+===\x60work\x60\\?`), 'UI selector reaches the same native setter')
  assert.match(text(headingParent), /onModeSelect:/)
  const selected = [setter, init, policyInit, normalize, sync, access, leaf, named(voiceName), plans, planInit, combine, selection, heading]
  const functionNames = new Set(selected.map(node => node.name.text))
  const assigned = new Set(), free = new Set()
  for (const node of selected) {
    const declared = new Set(), used = new Set(), localAssigned = new Set()
    const visit = value => {
      if (ts.isIdentifier(value)) {
        const parent = value.parent
        if ((ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === value) declared.add(value.text)
        else if (!(ts.isPropertyAccessExpression(parent) && parent.name === value)
            && !(ts.isPropertyAssignment(parent) && parent.name === value)
            && !(ts.isBindingElement(parent) && parent.propertyName === value)) used.add(value.text)
      }
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(value.left)) localAssigned.add(value.left.text)
      ts.forEachChild(value, visit)
    }
    visit(node)
    // A compiler temporary inside the control may share a minified name with
    // another function's imported initializer. Only module assignments belong
    // in the fixture closure; local assignments retain their native scope.
    for (const name of localAssigned) if (!declared.has(name)) assigned.add(name)
    for (const name of used) if (!declared.has(name) && !functionNames.has(name)) free.add(name)
  }
  for (const name of functionNames) assigned.delete(name)
  for (const name of assigned) free.delete(name)
  for (const name of [authName, authInputName, statsigName]) free.add(name)
  free.delete('undefined')
  free.delete('Symbol')
  const exportFor = local => capture(source.slice(source.lastIndexOf('export{')),
    new RegExp(`(?:[,{])${local.replace(/[$]/g, '\\$&')} as ([\\w$]+)(?=[,}])`), `export ${local}`)[1]
  const importFor = local => capture(source.slice(0, source.indexOf('from"./app-shared-') + 1),
    new RegExp(`(?:[,{])([\\w$]+) as ${local.replace(/[$]/g, '\\$&')}(?=[,}])`), `import ${local}`)[1]
  const exported = [init.name.text, setter.name.text, policy[1], policy[2], authName, authInputName, statsigName]
  const lazy = capture(text(init), /return\([\w$]+=([\w$]+)\(/, 'lazy initializer')[1]
  const factorySource = [
    `const deps=Object.fromEntries(${JSON.stringify([...free])}.map(name=>[name,()=>undefined]));`,
    `deps[${JSON.stringify(lazy)}]=fn=>{let ready=false;return()=>{if(!ready){ready=true;fn()}}};`,
    `deps[${JSON.stringify(modeParts[2])}]=env.appScope;`,
    `deps[${JSON.stringify(signalFactory)}]=env.signal;deps[${JSON.stringify(modeParts[1])}]=env.derived;`,
    `deps[${JSON.stringify(bridgeName)}]=env.services;deps[${JSON.stringify(metadata[2])}]={conversationDetailMode:{key:'conversationDetailMode'}};`,
    `deps[${JSON.stringify(metadata[1])}]=async(scope,key,value)=>{await env.services.settings.write(key.key,value);scope.set(env.settingsDescriptor,value)};`,
    ...settingsReaders.map(name => `deps[${JSON.stringify(name)}]=(get)=>get(env.settingsDescriptor);`),
    `deps[${JSON.stringify(loggerName)}]=env.signal(env.appScope,{logProductEvent:()=>env.analytics.push('mode-selected')});`,
    `deps[${JSON.stringify(authName)}]=env.auth;deps[${JSON.stringify(authInputName)}]=env.authInput;deps[${JSON.stringify(statsigName)}]=env.statsig;`,
    // Scope access follows the actual installed Sjt/ljt/wjt implementations.
    `deps[${JSON.stringify(policy[1])}]=env.derived(env.appScope,({get})=>{const access=${access.name.text}(get(env.authInput),null);return ${combine.name.text}(access.workCloud,access.workLocal)});`,
    `deps[${JSON.stringify(policy[2])}]=env.derived(env.appScope,({get})=>${access.name.text}(get(env.authInput),null).local);`,
    'Object.assign(deps,env.controlDependencies);',
    `let ${[...assigned].join(',')};`,
    // Auth descriptors are native framework signals, synthetic account values.
    `const {${[...free].join(',')}}=deps;`,
    ...selected.map(text),
    `${planInit.name.text}();`,
    `const module={};`,
    ...exported.map(name => `Object.defineProperty(module,${JSON.stringify(exportFor(name))},{get:()=>${name}});`),
    `return {module,mode:()=>${modeName},optimistic:()=>${optimisticName},select:${selection.name.text},init:${init.name.text},modeControlType:${heading.name.text}};`,
  ].join('\n')
  return { factorySource, controlDependencies, scopeImport: importFor(modeParts[2]), bridgeImport: importFor(bridgeName),
    signalHook: importFor(signalHook), sources: { setter: setterText, policy: policyText, selection: text(selection), heading: text(heading), headingParent: text(headingParent), publish: publishText } }
}

legacyTest('installed renderer bindings use native state, committed React scopes and the UI mode setter', nativeOptions, async t => {
  const http = require('node:http')
  const { chromium } = require('playwright')
  const asar = require('@electron/asar')
  const packaged = require('./codex-fuel-native-fixture.cjs').nativeFuelFixture(packagePath)
  const initialName = asar.listPackage(packagePath).map(file => file.split(/[\\/]/).at(-1)).find(name => /^app-initial-.*\.js$/.test(name))
  const initialSource = packaged.read(initialName).toString()
  const exposed = packaged.read(packaged.appName).toString()
  const sharedSource = exposed.slice(0, exposed.lastIndexOf('\nexport{'))
  const fixture = rendererFixture(initialSource)
  const mainFactory = require('./codex-api-mode-native-fixture.cjs').readNativeApiModeFixture(packagePath).factorySource
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1)
    if (!name) { response.end('<!doctype html><div id="root"></div>'); return }
    const file = name.includes('/') || name.includes('..') ? null : packaged.read(name)
    response.writeHead(file ? 200 : 404, { 'content-type': 'text/javascript' }); response.end(file || '')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)) })
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage()
  const origin = `http://127.0.0.1:${server.address().port}`
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(origin)
  await page.addScriptTag({ content: bindingsSource + '\n' + runtimeSource })
  await page.evaluate(async ({ appName, initialSource, sharedSource, fixture, mainFactory }) => {
    const native = await import('/' + appName)
    native.__fuel_uln(); native.__fuel_queryInit()
    const React = native.__fuel_react(), dom = native.__fuel_client()
    const appScope = native.__fuel_lun('AppScope')
    const signal = native.__fuel_Bln, derived = native.__fuel_Pln
    const writes = [], analytics = []
    const identity = { userId: 'statsig-user', accountId: null, authMethod: 'apikey', stableId: 'statsig-device' }
    const main = new Function('dependencies', mainFactory)({})
    const settings = main.createSettings({ identity, configuredMode: 'STEPS_PROSE', access: [{ ...identity, policy: 'everyday' }] })
    const originalWrite = settings.write
    settings.write = function (key, value) { writes.push({ key, value }); return originalWrite.call(this, key, value) }
    const services = { settings, workModeAccess: settings }
    const settingsDescriptor = signal(appScope, 'STEPS_PROSE')
    const auth = signal(appScope, { authMethod: null, authLoading: true })
    const authInput = signal(appScope, { accountId: null, accountInfoError: false, accountInfoLoading: false, authLoading: false, authMethod: 'chatgpt', plan: null, supportedSurface: true, workCloudSupportedSurface: true, untouched: 'preserved' })
    const statsig = signal(appScope, { getContext: () => ({ user: { userID: 'statsig-user', customIDs: { account_id: null, stableID: 'statsig-device', auth_method: 'WRONG-PATH' }, custom: { auth_method: 'apikey' } } }) })
    const menuClose = React.createContext(() => {})
    function Menu({ triggerButton, children, onCloseAutoFocus }) {
      const portal = { $$typeof: Symbol.for('react.portal'), key: null, containerInfo: document.body, implementation: null,
        children: React.createElement(menuClose.Provider, { value: () => onCloseAutoFocus({ preventDefault() {} }) }, React.createElement('div', { role: 'menu' }, children)) }
      return React.createElement(React.Fragment, null, triggerButton, portal)
    }
    function Item({ SubText, onSelect, onPointerDown }) {
      const close = React.useContext(menuClose)
      const kind = SubText?.props?.children?.props?.id?.includes('.work.') ? 'work' : 'codex'
      return React.createElement('button', { id: `native-mode-${kind}`, role: 'menuitem', onPointerDown,
        onClick: () => { onSelect(); close() } }, kind)
    }
    const values = {
      compiler: { c: size => Array(size).fill(Symbol.for('react.memo_cache_sentinel')) }, react: React,
      jsx: { jsx: (type, props) => React.createElement(type, props), jsxs: (type, props) => React.createElement(type, props) },
      intl: () => ({ formatMessage: message => message.defaultMessage }),
      labels: { chatGpt: { defaultMessage: 'ChatGPT' }, chatGptWork: { defaultMessage: 'Work' }, codex: { defaultMessage: 'Codex' } },
      access: { ChatGpt: 'chatgpt', ChatGptWork: 'chatgpt_work', Work: 'work' }, menu: Menu,
      button: ({ children }) => React.createElement('button', { id: 'native-mode-trigger' }, children), items: { Item },
    }
    const controlDependencies = Object.fromEntries(Object.entries(fixture.controlDependencies).map(([name, local]) => [local, values[name]]))
    const fixtureNative = new Function('env', fixture.factorySource)({ appScope, signal, derived, services, settingsDescriptor, auth, authInput, statsig, analytics, controlDependencies })
    const sharedModule = { ...native, [fixture.scopeImport]: appScope, [fixture.bridgeImport]: services }
    const options = { initialSource, initialModule: fixtureNative.module, sharedSource, sharedModule }
    const bindings = codexApiModeBindings(options)
    if (bindings.error) throw Error(bindings.error)
    window.fixture = { bindings, options, fixtureNative, appScope, auth, authInput, statsig, writes, analytics, services, modeSelections: [] }
    const before = fixtureNative.mode()
    const again = codexApiModeBindings(options)
    if (again.error || fixtureNative.mode() !== before || writes.length || analytics.length) throw Error('Discovery initializer/probe changed native state')
    function Lookalike() { return React.createElement('button', { id: 'lookalike-mode' }, 'ordinary menu') }
    function View() {
      window.nativeScope = native.__fuel_fln(appScope)
      const mode = native[fixture.signalHook](fixtureNative.mode())
      return React.createElement(React.Fragment, null, React.createElement('button', { id: 'mode' }, mode),
        React.createElement(fixtureNative.modeControlType, { mode: mode === 'STEPS_PROSE' ? 'work' : 'codex', codexAvailable: true,
          workModeAccess: 'work', navigationHeading: true, onModeSelect: value => window.fixture.modeSelections.push(value) }),
        React.createElement(Lookalike, { mode: 'codex', codexAvailable: true, workModeAccess: 'work', onModeSelect() {} }))
    }
    const client = new native.__fuel_queryClient()
    window.reactRoot = dom.createRoot(document.getElementById('root'))
    window.renderNative = () => reactRoot.render(React.createElement(native.__fuel_queryProvider, { queryClient: client }, React.createElement(native.__fuel_vln, { scope: appScope }, React.createElement(View))))
    renderNative()
  }, { appName: packaged.appName, initialSource, sharedSource, fixture, mainFactory })
  await page.waitForFunction(() => document.getElementById('mode')?.textContent === 'STEPS_PROSE').catch(async error => {
    assert.fail(`${error.message}; native errors: ${JSON.stringify(errors)}; DOM: ${await page.locator('#root').innerText()}`)
  })
  assert.equal(await page.evaluate(() => {
    const original = document.querySelectorAll
    let fullDocumentScans = 0
    document.querySelectorAll = function (selector) { if (selector === '*') fullDocumentScans++; return original.call(this, selector) }
    try { fixture.bindings.scopes(); fixture.bindings.scopes(); return fullDocumentScans }
    finally { document.querySelectorAll = original }
  }), 0, 'known root avoids full-document scans during repeated owner checks')
  assert.deepEqual(await page.evaluate(() => ['native-mode-trigger', 'native-mode-work', 'native-mode-codex', 'mode', 'lookalike-mode']
    .map(id => fixture.bindings.isModeControlEvent(document.getElementById(id)))), [true, true, true, false, false],
  'only the original native component qualifies, including its portal; same props on an unrelated type do not')
  assert.equal(await page.evaluate(() => {
    const target = document.getElementById('lookalike-mode')
    const key = Object.keys(target).find(name => name.startsWith('__reactFiber$'))
    const original = target[key]
    let root = original
    while (root.return) root = root.return
    const fakeRoot = { stateNode: root.stateNode }
    const fakeOwner = { type: fixture.fixtureNative.modeControlType,
      memoizedProps: { mode: 'codex', codexAvailable: true, workModeAccess: 'work', onModeSelect() {} }, return: fakeRoot }
    target[key] = { stateNode: target, return: fakeOwner }
    try { return fixture.bindings.isModeControlEvent(target) }
    finally { target[key] = original }
  }), false, 'an old alternate claiming the native mode component does not qualify')
  assert.deepEqual(await page.evaluate(() => ({ found: fixture.bindings.scopes().includes(nativeScope), state: fixture.bindings.read(nativeScope), writes: fixture.writes.length, analytics: fixture.analytics.length })), {
    found: true, state: { authMethod: null, authLoading: true, identity: { userId: 'statsig-user', accountId: null, authMethod: 'apikey', stableId: 'statsig-device' }, detailLevel: 'STEPS_PROSE', policy: 'everyday', access: { status: 'denied', reason: 'missing-account' }, localAccess: { status: 'denied', reason: 'missing-account' }, authInput: { accountId: null, accountInfoError: false, accountInfoLoading: false, authLoading: false, authMethod: 'chatgpt', plan: null, supportedSurface: true, workCloudSupportedSurface: true, untouched: 'preserved' } }, writes: 0, analytics: 0,
  })
  for (const auth of [{ authMethod: null, authLoading: true }, { authMethod: 'chatgpt', authLoading: false }, { authMethod: 'apikey', authLoading: true }]) {
    assert.match(await page.evaluate(async auth => { nativeScope.set(fixture.auth, auth); try { await fixture.bindings.setCoding(nativeScope); return 'unexpected success' } catch (error) { return error.message } }, auth), /Native API authentication is not ready/)
  }
  assert.equal(await page.evaluate(() => fixture.writes.length), 0)
  assert.equal(await page.evaluate(() => nativeScope.get(fixture.authInput).authMethod), 'chatgpt', 'rejected auth never changes access inputs')
  const changed = await page.evaluate(async () => {
    nativeScope.set(fixture.auth, { authMethod: 'apikey', authLoading: false })
    return fixture.bindings.setCoding(nativeScope)
  })
  assert.equal(changed.policy, 'preference', 'native API local access permits preference; it is not an invented unsupported-auth override')
  assert.equal(changed.detailLevel, 'STEPS_COMMANDS')
  assert.equal(changed.authInput.untouched, 'preserved')
  await page.waitForFunction(() => document.getElementById('mode')?.textContent === 'STEPS_COMMANDS')
  assert.deepEqual(await page.evaluate(() => fixture.writes), [{ key: 'conversationDetailMode', value: 'STEPS_COMMANDS' }])
  assert.equal(await page.evaluate(() => fixture.analytics.length), 1)
  // Exercise the real sidebar handler with only navigation dependencies inert.
  await page.evaluate(() => {
    const known = new Set([fixture.fixtureNative.mode(), fixture.fixtureNative.optimistic(), fixture.auth, fixture.authInput, fixture.statsig])
    const forwarding = { ...nativeScope, get: (descriptor, ...args) => {
      if (known.has(descriptor) || descriptor?.scope === fixture.appScope) return nativeScope.get(descriptor, ...args)
      return null
    } }
    window.selectWork = () => fixture.fixtureNative.select(forwarding, { codexLocalAccessStatus: 'allowed', currentMode: 'codex', nextMode: 'work', restoreNavigation: false })
    selectWork()
  })
  await page.waitForFunction(() => document.getElementById('mode')?.textContent === 'STEPS_PROSE')
  assert.equal(await page.evaluate(() => fixture.writes.at(-1).value), 'STEPS_PROSE')
  await page.evaluate(() => fixture.bindings.setCoding(nativeScope))
  await page.waitForFunction(() => document.getElementById('mode')?.textContent === 'STEPS_COMMANDS')
  await page.evaluate(async () => {
    window.guard = createCodexApiModeGuard(fixture.bindings, { getState: () => ({ apiCodingModeEnabled: true }) })
    await guard.refresh()
  })
  assert.deepEqual(await page.evaluate(() => guard.status()), { ready: true, reason: 'coding', error: '' })
  const selectionsBeforeGuardEvents = await page.evaluate(() => fixture.modeSelections.length)
  await page.locator('#native-mode-trigger').click()
  await page.locator('#native-mode-work').click()
  await page.locator('#native-mode-trigger').focus()
  for (const key of ['Enter', 'Space', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(key)
  assert.equal(await page.evaluate(() => fixture.modeSelections.length), selectionsBeforeGuardEvents,
    'API guard stops pointer/click and keyboard mode callbacks before native navigation can start')
  assert.deepEqual(await page.evaluate(() => {
    const target = document.getElementById('native-mode-trigger')
    return ['Enter', ' ', 'ArrowDown', 'ArrowUp'].map(key => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    })
  }), [true, true, true, true])
  assert.deepEqual(await page.evaluate(() => {
    const input = document.createElement('input')
    const ordinary = document.createElement('button')
    ordinary.setAttribute('role', 'menuitem')
    document.body.append(input, ordinary)
    const result = [input, ordinary, document.getElementById('lookalike-mode')].map(target => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      target.dispatchEvent(click)
      return [event.defaultPrevented, click.defaultPrevented]
    })
    input.remove(); ordinary.remove()
    return result
  }), [[false, false], [false, false], [false, false]], 'ordinary inputs and menus retain native events')
  await page.evaluate(() => nativeScope.set(fixture.auth, { authMethod: 'chatgpt', authLoading: false }))
  await page.locator('#native-mode-work').click()
  assert.equal(await page.evaluate(() => fixture.modeSelections.length), selectionsBeforeGuardEvents + 1,
    'a real ChatGPT session retains the native Work selection callback')
  await page.evaluate(() => nativeScope.set(fixture.auth, { authMethod: 'apikey', authLoading: false }))
  for (let count = 0; count < 3; count++) {
    const before = await page.evaluate(() => fixture.writes.length)
    await page.evaluate(() => selectWork())
    await page.waitForFunction(() => document.getElementById('mode')?.textContent === 'STEPS_COMMANDS')
    await page.evaluate(() => guard.refresh())
    assert.deepEqual(await page.evaluate(start => fixture.writes.slice(start).map(value => value.value), before), ['STEPS_COMMANDS'])
    assert.deepEqual(await page.evaluate(() => fixture.services.settings.read('conversationDetailMode')), { configured: 'STEPS_COMMANDS', effective: 'STEPS_COMMANDS' })
    assert.equal(await page.evaluate(() => guard.status().ready), true)
  }
  const writesBeforeRefresh = await page.evaluate(() => fixture.writes.length)
  await page.evaluate(async () => { await guard.refresh(); await guard.refresh() })
  assert.equal(await page.evaluate(() => fixture.writes.length), writesBeforeRefresh, 'preference policy does not cause repeated repairs')
  assert.match(await page.evaluate(() => codexApiModeBindings({ ...fixture.options, initialSource: fixture.options.initialSource.replace('selectedThreadDetailLevel:', 'changedThreadDetailLevel:') }).error), /detail mode setter body/)
  assert.equal(await page.evaluate(() => {
    const old = nativeScope
    renderNative()
    const stale = { ...old, node: {} }
    const button = document.getElementById('mode')
    let attached = button[Object.keys(button).find(key => key.startsWith('__reactFiber$'))]
    while (attached.return) attached = attached.return
    const fakeOldRoot = { stateNode: attached.stateNode }
    document.getElementById('root').__reactFiber$stale = { return: fakeOldRoot, memoizedState: { memoizedState: { current: stale } } }
    return fixture.bindings.scopes().includes(stale)
  }), false)
  await page.evaluate(() => guard.dispose())
  const selectionsBeforeDisposeEvent = await page.evaluate(() => fixture.modeSelections.length)
  await page.locator('#native-mode-work').click()
  assert.equal(await page.evaluate(() => fixture.modeSelections.length), selectionsBeforeDisposeEvent + 1,
    'disposing the guard removes event interception')
  await page.evaluate(() => reactRoot.unmount())
  assert.equal(await page.evaluate(() => fixture.bindings.scopes().length), 0, 'unmounted hooks are not live scopes')
  assert.deepEqual(errors, [])
})
