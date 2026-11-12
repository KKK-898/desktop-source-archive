const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const asar = require('@electron/asar')

// Serve installed assets in an isolated browser without extracting or changing
// the installation. Only framework exports are initialized; no user data loads.
function nativeFuelFixture(packagePath) {
  const files = asar.listPackage(packagePath).map(file => file.replace(/^[\\/]/, ''))
  const byName = new Map(files.map(file => [file.split(/[\\/]/).at(-1), file]))
  const read = name => {
    const file = byName.get(name)
    return file ? asar.extractFile(packagePath, file) : null
  }
  const nameFor = prefix => {
    const names = [...byName.keys()].filter(name => name.startsWith(prefix) && name.endsWith('.js'))
    assert.equal(names.length, 1, `Expected one ${prefix} module`)
    return names[0]
  }
  const initialName = nameFor('app-initial-'), sharedName = nameFor('app-shared-')
  const initial = read(initialName).toString(), shared = read(sharedName).toString()
  const runtime = {}
  vm.createContext(runtime)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_fuel_runtime.js'), 'utf8'), runtime)
  const moduleFor = source => Object.fromEntries([...source.slice(source.lastIndexOf('export{'))
    .matchAll(/(?:[,{])([\w$]+) as ([\w$]+)(?=[,}])/g)]
    .map(match => [match[2], Object.assign(() => {}, { localName: match[1] })]))
  const dependencies = { 'app-shared-': moduleFor(shared), __sources: { 'app-shared-': shared } }
  const bindings = runtime.discoverCodexFuelQuotaBindings(initial, moduleFor(initial), dependencies)
  const one = (source, expression, label) => {
    const matches = [...source.matchAll(expression)]
    assert.equal(matches.length, 1, `Expected one native ${label}`)
    return matches[0]
  }
  const scope = one(shared, /function ([\w$]+)\(e,t\)\{return [^{};]{0,180}\{__scopeBrand:e,/g, 'scope factory')[1]
  const provider = one(shared, /function ([\w$]+)\(\{children:e,scope:t,value:n\}\)/g, 'scope provider')[1]
  const scopeValue = shared.indexOf('scope:e,value:r};function o(e,t,n)')
  assert.ok(scopeValue > 0, 'native scope reader found')
  const scopeStart = shared.lastIndexOf('function ', scopeValue)
  const scopeEnd = shared.indexOf('return i.current}', scopeValue) + 'return i.current}'.length
  const useScope = /^function ([\w$]+)\(/.exec(shared.slice(scopeStart))[1]
  const initializerBlock = shared.slice(scopeEnd, shared.indexOf('function ', shared.indexOf('function ', scopeEnd) + 9) + 600)
  // The provider/readers share a lazy initializer directly following useScope.
  const initializers = [...initializerBlock.matchAll(/function ([\w$]+)\(\)\{return\(\1=[\w$]+\(\(\(\)=>\{[^{}]+\}\)\)\)\(\)\}/g)]
  assert.ok(initializers.length >= 3, 'native framework initializer chain found')
  const initialize = initializers[2][1]
  const familyHook = one(shared, /function ([\w$]+)\(e,t,n\)\{"use no memo";(?:(?!function )[\s\S]){0,1900}?\.retain\(\)\},\[[^\]]+\]\),([\w$]+)\([\w$]+\(l,n\)\)\}/g, 'family hook')
  const hard = /([\w$]+)=([\w$]+)\(([\w$]+),\(([\w$]+),\{get:([\w$]+)\}\)=>\5\(([\w$]+),\4\)\.hardBlocked\)/.exec(initial)
  const family = runtime.codexFuelExportOrImport(initial, moduleFor(initial), dependencies, hard[2]).localName
  const aliases = {
    uln: initialize, lun: scope, vln: provider, fln: useScope,
    hln: familyHook[1], _ln: familyHook[2],
    Bln: bindings.createSignal.localName, Pln: bindings.createDerived.localName, Aln: family,
  }
  const providerBody = shared.slice(shared.indexOf(`function ${provider}(`))
  const reactLocal = /^function [\w$]+\([^)]*\)\{let r=\(0,([\w$]+)\.useContext\)/.exec(providerBody)?.[1]
  assert.ok(reactLocal, 'native provider React binding found')
  aliases.react = one(shared, new RegExp(`${reactLocal}=([\\w$]+)\\(\\)`, 'g'), 'React factory')[1]
  const domPosition = shared.indexOf('.createRoot=function')
  const ts = require('typescript')
  const syntax = ts.createSourceFile(sharedName, shared, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  const domStatement = syntax.statements.find(statement => statement.pos <= domPosition && statement.end > domPosition)
  const domFactory = ts.isVariableStatement(domStatement)
    ? domStatement.declarationList.declarations.find(declaration => declaration.pos <= domPosition && declaration.end > domPosition)?.name.getText(syntax)
    : null
  assert.ok(domPosition > 0 && domFactory, 'native React DOM factory found')
  aliases.client = domFactory
  const queryClassPosition = shared.lastIndexOf('=class', shared.indexOf('getQueryCache(){'))
  aliases.queryClient = /([\w$]+)$/.exec(shared.slice(0, queryClassPosition))[1]
  aliases.queryInit = /^function ([\w$]+)\(/.exec(shared.slice(shared.lastIndexOf('function ', queryClassPosition)))[1]
  const queryProviderPosition = shared.indexOf('{children:n,queryClient:r}=e')
  assert.ok(queryProviderPosition > 0, 'native QueryClient provider found')
  aliases.queryProvider = /^function ([\w$]+)\(/.exec(shared.slice(shared.lastIndexOf('function ', queryProviderPosition)))[1]
  const config = /[\w$]+=([\w$]+)\([\w$]+,\(\{cwd:[\w$]+=null,hostId:[\w$]+\}/.exec(initial)
  assert.ok(config, 'native config query family found')
  aliases.queryFamily = runtime.codexFuelExportOrImport(initial, moduleFor(initial), dependencies, config[1]).localName
  // Read the ordinary account quota gate from the installed composer, not a
  // rewritten test approximation of !allowed. Bind only its external inputs.
  const primaryName = nameFor('app-primary-'); const primary = read(primaryName).toString();
  const primaryTree = ts.createSourceFile(primaryName, primary, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  let ordinaryGate = null;
  const visit = node => {
    if (ts.isArrowFunction(node) && node.parameters.length === 1
        && node.getText(primaryTree).includes('.rate_limit?.allowed!==!1')
        && node.getText(primaryTree).includes('authMethod!==')) {
      const body = node.getText(primaryTree);
      if (!ordinaryGate || body.length < ordinaryGate.length) ordinaryGate = body;
    }
    ts.forEachChild(node, visit);
  };
  visit(primaryTree);
  assert.ok(ordinaryGate, 'ordinary account quota gate from installed composer found');
  const reads = one(ordinaryGate, /let ([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=\2\(([\w$]+)\)\.data/g, 'account gate inputs');
  const keys = { auth: reads[3], usage: reads[5] };
  // All remaining local identifiers are external helpers or signal tokens.
  const declared = new Set(); const referenced = new Set(); const called = new Set();
  const collect = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) called.add(node.expression.text);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node) declared.add(node.text);
      else if (!(ts.isPropertyAccessExpression(parent) && parent.name === node)
          && !(ts.isBindingElement(parent) && parent.propertyName === node)
          && !(ts.isPropertyAssignment(parent) && parent.name === node)) referenced.add(node.text);
    }
    ts.forEachChild(node, collect);
  };
  // parent links are required for distinguishing object/property names.
  const linkedGate = ts.createSourceFile('gate.js', '(' + ordinaryGate + ')', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  collect(linkedGate);
  const external = [...referenced].filter(name => !declared.has(name));
  const nativeUsageGate = { source: ordinaryGate, keys, external, helpers: external.filter(name => called.has(name)) };

  // Test-only export aliases leave every native implementation untouched.
  const exposed = `${shared}\nexport{${Object.entries(aliases).map(([alias, local]) => `${local} as __fuel_${alias}`).join(',')}};`
  return {
    appName: sharedName, aliases, nativeUsageGate,
    read(name) { return name === sharedName ? Buffer.from(exposed) : read(name) },
  }
}

module.exports = { nativeFuelFixture }
