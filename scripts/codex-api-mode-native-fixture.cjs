const assert = require('node:assert/strict')
const ts = require('typescript')

function one(items, label) {
  assert.equal(items.length, 1, `Expected one native ${label}`)
  return items[0]
}

function capture(source, pattern, label) {
  const match = pattern.exec(source)
  assert.ok(match, `Unsupported native ${label}`)
  return match[1]
}

// Extract only selected functions and methods. The Electron main module is
// never evaluated or required; all surrounding services are synthetic below.
function nativeApiModeFixture(mainSource) {
  const tree = ts.createSourceFile('native-main.js', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const functions = tree.statements.filter(ts.isFunctionDeclaration)
  const browserNode = one(functions.filter(node => {
    const source = node.getText(tree)
    return source.includes('requireWorkBrowserIdentity') && source.includes('Work browser access requires an authenticated account')
  }), 'Work browser identity guard')
  const browserSource = browserNode.getText(tree)
  const browserName = browserNode.name.text
  const principalName = capture(browserSource, /\?([\w$]+)\([\w$]+\.getCachedAuthenticatedPrincipal\?\.\(\)\)/, 'principal serializer call')
  const principalSource = one(functions.filter(node => node.name?.text === principalName), 'principal serializer').getText(tree)
  assert.match(principalSource, /return [\w$]+==null\?null:JSON\.stringify\(\[[\w$]+\.o,[\w$]+\.accountId,[\w$]+\.userId\]\)/)
  const principalModule = capture(principalSource, /JSON\.stringify\(\[([\w$]+)\.o,/, 'principal namespace')
  const classes = []
  const visit = node => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (node.members.some(member => member.name?.getText(tree) === 'getEffective'
          && member.getText(tree).includes('workModeAccessByAccount'))) classes.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const settingsClass = one(classes, 'Settings class')
  const methods = Object.fromEntries(['getEffective', 'read', 'write', 'publish'].map(name => [name,
    one(settingsClass.members.filter(member => member.name?.getText(tree) === name), `Settings.${name}`).getText(tree)]))
  const sameIdentityName = capture(methods.getEffective, /\.find\([\w$]+=>([\w$]+)\([\w$]+\.identity,[\w$]+\)\)/, 'Settings identity comparison')
  const sameIdentitySource = one(functions.filter(node => node.name?.text === sameIdentityName), 'Settings identity comparator').getText(tree)
  assert.match(sameIdentitySource, /\.authMethod/)
  assert.match(sameIdentitySource, /\.stableId/)
  const settingModule = capture(methods.getEffective, /===([\w$]+)\.R\.conversationDetailMode\.key/, 'Settings metadata import')
  const linkPreferenceName = capture(methods.getEffective, /\.F\([\w$]+,([\w$]+)\(this\.store\)\)/, 'Settings link preference')
  const accessSchemaName = capture(methods.publish, /let [\w$]+=([\w$]+)\.parse\(/, 'Settings access schema')
  assert.match(methods.getEffective, /policy===`preference`\?this\.store\.getEffective\([\w$]+\):[\w$]+\.F\([\w$]+,[\w$]+\.policy===`everyday`\?`STEPS_PROSE`:`STEPS_COMMANDS`\)/)
  const names = {
    browser: browserName, principal: principalName, sameIdentity: sameIdentityName,
    cache: capture(browserSource, /\?await ([\w$]+)\([\w$]+\):null/, 'browser selection cache'),
    features: capture(browserSource, /=[\w$]+\?([\w$]+)\(\):[\w$]+\.desktopFeatureAvailability/, 'browser feature lookup'),
    selection: capture(browserSource, /selection\?\?await ([\w$]+)\(/, 'browser selection'),
    nodeRepl: capture(browserSource, /let [\w$]+=await ([\w$]+)\(\{\.\.\.[\w$]+,selection:/, 'browser Node REPL configuration'),
    process: capture(browserSource, /([\w$]+)\.default\.env\.CODEX_APP_TOOLS_PIPE_PATH/, 'browser process environment'),
    // The reviewed 26.1013 and 26.1016 modules export the same cua_repl key
    // under as and os respectively. Keep the export-name allowlist explicit.
    tools: capture(browserSource, /mcp_servers\.\$\{([\w$]+)\.(?:as|os)\}/, 'browser tools metadata'),
    toolsExport: capture(browserSource, /mcp_servers\.\$\{[\w$]+\.(as|os)\}/, 'browser tools metadata export'),
    disabled: capture(browserSource, /\{\.\.\.[\w$]+,\.\.\.([\w$]+)\}/, 'disabled browser configuration'),
    unified: capture(browserSource, /\]=([\w$]+)\(\{browserBackends:/, 'unified browser configuration'),
    surfaces: capture(browserSource, /\)\),([\w$]+)\([\w$]+\[`mcp_servers\.node_repl`\]/, 'browser surface configuration'),
    executorKey: capture(browserSource, /Object\.assign\([\w$]+\.env,\{\[([\w$]+)\]:/, 'browser executor environment key'),
    pipeKey: capture(browserSource, /Object\.assign\([\w$]+\.env,\{\[[\w$]+\]:[\w$]+,\[([\w$]+)\]:/, 'browser pipe environment key'),
    verifyingKey: capture(browserSource, /\[([\w$]+)\]:[\w$]+\.default\.env\.BROWSER_USE_ACCESS_VERIFYING_IDENTITY/, 'browser verification environment key'),
  }
  assert.equal(names.tools, settingModule, 'Expected shared Settings and browser metadata import')
  const constants = Object.fromEntries([names.executorKey, names.pipeKey, names.verifyingKey].map(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const value = capture(mainSource, new RegExp('(?:^|[^\\w$])' + escaped + '=`([^`]+)`'), 'browser environment key constant')
    assert.match(value, /^BROWSER_USE_ACCESS_[A-Z_]+$/)
    return [name, value]
  }))
  const factorySource = [
    'const modeKey = "conversationDetailMode";',
    `const ${settingModule} = {${names.toolsExport}:"cua_repl",R:{conversationDetailMode:{key:modeKey}},H:{autoArchiveAfterDays:{key:"autoArchiveAfterDays",schema:{safeParse:value=>({success:true,data:value})}}},U:{openLinkInTargetPreference:{key:"openLinkInTargetPreference"}},F:(key,value)=>{if(key===modeKey&&!['STEPS_PROSE','STEPS_COMMANDS'].includes(value))throw Error('Invalid synthetic mode');return value}};`,
    `const ${principalModule} = {o:dependencies.identityNamespace || 'synthetic-client'};`,
    `const ${accessSchemaName} = {parse:dependencies.parseAccess || (value=>{for(const field of ['accountId','userId','authMethod','stableId'])if(value[field]!==null&&typeof value[field]!=='string')throw Error('Invalid synthetic identity');if(!['preference','coding','everyday'].includes(value.policy))throw Error('Invalid synthetic access policy');return {...value}})};`,
    `const ${linkPreferenceName} = store => store.getEffective('openLinkInTargetPreference');`,
    `const ${names.cache} = dependencies.cachedSelection || (async()=>null);`,
    `const ${names.features} = dependencies.features || (()=>({browserUseTinysky:false}));`,
    `const ${names.selection} = dependencies.selectBrowser || (async()=>({browserServicePluginVersion:null,desktopFeatureAvailability:{},browserBackends:['iab'],cuaReplSurfaces:['browser']}));`,
    `const ${names.nodeRepl} = dependencies.nodeRepl || (async()=>({'mcp_servers.node_repl':{command:'synthetic-node',env:{}}}));`,
    `const ${names.process} = {default:{env:dependencies.environment || {}}};`,
    `const ${names.disabled} = {'mcp_servers.cua_repl':{enabled:false}};`,
    `const ${names.unified} = dependencies.unifiedBrowser || (()=>({enabled:true,command:'synthetic-cua'}));`,
    `const ${names.surfaces} = dependencies.configureSurfaces || (()=>{});`,
    ...Object.entries(constants).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`),
    sameIdentitySource, principalSource, browserSource,
    `const settingsMethods = {${Object.values(methods).join(',')}};`,
    'function createSettings({identity=null,configuredMode="STEPS_PROSE",access=[],onWrite=()=>{}}={}){const values=new Map([[modeKey,configuredMode]]);return Object.assign({store:{get:key=>values.get(key),getEffective:key=>values.get(key),set:(key,value)=>values.set(key,value)},statsig:{readExecutionAssignments:async()=>identity==null?null:{identity}},workModeAccessByAccount:access.map(value=>({...value})),workModeAccessListeners:new Set(),afterWrite:onWrite},settingsMethods)}',
    `return {modeKey,settingsMethods,createSettings,browserConfig:${browserName},serializePrincipal:${principalName},sameIdentity:${sameIdentityName}};`,
  ].join('\n')
  return { factorySource, sources: { browser: browserSource, principal: principalSource, sameIdentity: sameIdentitySource, ...methods }, names }
}

function readNativeApiModeFixture(packagePath) {
  const asar = require('@electron/asar')
  const mainAsset = one(asar.listPackage(packagePath).map(name => name.replace(/^[\\/]/, ''))
    .filter(name => /(?:^|[\\/])\.vite[\\/]build[\\/]main-[^\\/]+\.js$/.test(name)), 'installed main bundle')
  const mainSource = asar.extractFile(packagePath, mainAsset).toString()
  return { mainAsset, ...nativeApiModeFixture(mainSource) }
}

module.exports = { nativeApiModeFixture, readNativeApiModeFixture }
