const assert = require('node:assert/strict')
const asar = require('@electron/asar')
const ts = require('typescript')

// Reviewed framework/library closures in Codex 26.1029 and 26.1103. This is a
// fail-closed test fixture, not a general application loader. App services,
// account/configuration modules and entry-point initialization never execute.
const REVIEWED_FRAMEWORK_MODULES = new Set(`
zd8w Vlts i5yi VI8C dQL9 v7qY Ji1y suje D7Ms pEZk OtRH MtYY rbzn NxBK wYVE H4sS
HY2m uyLo wo6g OLOS slNz UKIm tyzk KoFQ ouEa HkKI hffr AvFJ GNwQ WWxl CmCo m5TT
PKjX wFEO eWn8 PXpJ fkEy xN7e m4Vs J6iR mDo6 PSDF UQAX jwtq Nmf8 U1Tb mCuz
hAFu suf3 CdjL LSsK LzIw fFdy kLiV BpNn ABep eKDk QosV F0CT zkmK bwyg SZCv
Ve3J L4cL abry cau8 uzPr JE8D sxKQ ve0d CXex CGTi w98s NAev hCNp cS8C hYZP
jWAU JLNC v6oU E6vh wtZd V9Lw P7Ri Iacu J8sO bvKR Pv3y mYlt P7Gl twa1 SOJZ
CdkZ jWwv fg36 DIYO sf24 tmmH V0J1 qAzV SYbL nipp ERw3 bXyS KznM XybT ox4N
qhfT WSER wJFE dkBO a4K9 NAcE zfmw wJbZ ULic bXyr KHZ6 JiDQ DGeF PbN4 xU3W
bGpk HORo DiaP tOqE qlZC E3aD Plwd hqyJ jato Ziic X1EY BqFM j39m FoIM S24d
SbMF j6bk axJ9 hKWB iQiC FcqJ wNyR k7fB Gk2I LTmb OjgC ulIE wkhw Sv71 SOuP
w0ay mmUB y5DF iwK1 vMlG zTeN
`.trim().split(/\s+/))
const FRAMEWORK_ROOTS = ['zd8w', 'i5yi', 'suje', 'tyzk', 'hffr', 'UQAX', 'jwtq']
// The 26.1103 Maitai bundle consolidates query construction, React hooks and
// providers into zTeN. iwK1 tracks query snapshots; vMlG only exports Symbols.
// Each profile keeps a reviewed, finite framework closure and an application
// factory used as provenance only. No application factory is initialized.
const FRAMEWORK_PROFILES = [
  { id: '26.1029', initial: 'WL4f', roots: ['U1Tb', 'fFdy', 'kLiV', 'bwyg', 'BpNn', 'y5DF'],
    queryFamily: ['U1Tb', 'v'], querySignal: ['fFdy', 'R'], hooks: 'kLiV',
    scopeProvider: ['bwyg', 'U'], queryProvider: ['BpNn', 'F'], preload: ['y5DF'] },
  { id: '26.1103', initial: 'j44z', roots: ['zTeN'],
    queryFamily: ['zTeN', 'vU'], querySignal: ['zTeN', 'RD'], hooks: 'zTeN',
    scopeProvider: ['zTeN', 'Ui'], queryProvider: ['zTeN', 'FU'], preload: [], config: 'OeLR' },
]
const forbiddenGlobals = new Set(['localStorage', 'sessionStorage', 'indexedDB', 'WebSocket', 'XMLHttpRequest'])

// Keep the returned reader outside the extraction scope: an in-scope closure
// also retains moduleSource/include and their complete native TypeScript ASTs.
// The isolated browser needs only this one reviewed payload, not those trees.
function payloadReader(appName, payload) {
  return name => name === appName ? payload : null
}

function nativeWebpackFixture(packagePath) {
  const files = asar.listPackage(packagePath).map(file => file.replace(/^[\\/]/, ''))
    .filter(file => /webview[\\/]assets[\\/].*\.js$/.test(file))
  const sourceFiles = files.map(file => ({ file, source: asar.extractFile(packagePath, file).toString() }))
  const modules = new Map(), parsed = new Set()
  function moduleSource(id, optional = false) {
    if (modules.has(id)) return modules.get(id)
    for (const { file, source } of sourceFiles) {
      if (parsed.has(file) || (!source.includes(id + '(') && !source.includes('"' + id + '"('))) continue
      parsed.add(file)
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      // Read module dictionaries only. Never eval a full chunk/entry and never
      // traverse unrelated nested object methods as candidate module factories.
      for (const statement of tree.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue
          for (const node of declaration.initializer.properties) {
            if (!ts.isMethodDeclaration(node) || !node.body || node.parameters.length > 3) continue
            const name = node.name.getText(tree).replace(/^['"]|['"]$/g, '')
            if (!modules.has(name)) modules.set(name, { source: node.getText(tree), node, tree, file })
          }
        }
      }
      if (modules.has(id)) return modules.get(id)
    }
    if (optional) return null
    throw new Error(`Installed webpack module ${id} was not found; this package requires fixture review`)
  }
  const profiles = FRAMEWORK_PROFILES.map(profile => ({ profile, initial: moduleSource(profile.initial, true) }))
    .filter(candidate => candidate.initial)
  assert.equal(profiles.length, 1, 'Installed webpack query ownership requires one reviewed framework profile')
  const { profile, initial } = profiles[0]
  const closure = new Map(), loaderProperties = new Set()
  function include(id) {
    if (closure.has(id)) return
    assert.ok(REVIEWED_FRAMEWORK_MODULES.has(id), `Unreviewed framework dependency ${id}; refusing application initialization`)
    const record = moduleSource(id)
    closure.set(id, record)
    const requireName = record.node.parameters[2]?.name.getText(record.tree)
    const dependencies = new Set()
    function inspect(node, nestedFunction = false) {
      if (ts.isCallExpression(node)) {
        if (!nestedFunction && requireName && ts.isIdentifier(node.expression) && node.expression.text === requireName) {
          assert.equal(node.arguments.length, 1, `Unexpected native require arguments in ${id}`)
          assert.ok(ts.isStringLiteral(node.arguments[0]), `Dynamic native require in ${id} is forbidden`)
          dependencies.add(node.arguments[0].text)
        }
        const lodashGlobalFallback = id === 'E6vh' && ts.isIdentifier(node.expression)
          && node.expression.text === 'Function' && node.arguments.length === 1
          && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'return this';
        if (!lodashGlobalFallback && ts.isIdentifier(node.expression) && ['fetch', 'eval', 'Function'].includes(node.expression.text)) {
          throw new Error(`Unexpected global side-effect call ${node.expression.text} in framework ${id}`)
        }
      }
      if (!nestedFunction && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === requireName) {
        loaderProperties.add(node.name.text)
      }
      // Jotai's reviewed utility only probes the storage API during import;
      // the isolated browser module denies access before native initialization.
      if (ts.isIdentifier(node) && forbiddenGlobals.has(node.text)
          && !(id === 'WWxl' && node.text === 'localStorage')) {
        throw new Error(`Unexpected native data/network surface ${node.text} in framework ${id}`)
      }
      ts.forEachChild(node, child => inspect(child, nestedFunction || ts.isFunctionLike(child)))
    }
    inspect(record.node.body)
    for (const dependency of dependencies) include(dependency)
  }
  ;[...FRAMEWORK_ROOTS, ...profile.roots].forEach(include)
  const implementedProperties = new Set(['d', 'n', 'o', 'r', 'j', 'g', 'nmd'])
  for (const property of loaderProperties) assert.ok(implementedProperties.has(property), `Unreviewed webpack loader helper ${property}`)

  const initialSource = initial.source
  const modelFilterSource = moduleSource('Xvtr').source
  const configHelperSource = profile.config ? moduleSource(profile.config).source : undefined
  const configBridgeSource = profile.config ? moduleSource('wCOm').source : undefined
  const appName = 'assets/348410.synthetic.js'
  const browserModule = `// Isolated installed-package framework exports; no application entry code.\n
const modules = {${[...closure.values()].map(record => record.source).join(',\n')},${initialSource}};
const cache = Object.create(null);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function requireNative(id) {
  if (own(cache, id)) return cache[id].exports;
  if (!own(modules, id)) throw new Error('Native test attempted an unreviewed module: ' + id);
  const module = { exports: {} };
  cache[id] = module;
  try { modules[id](module, module.exports, requireNative); }
  catch (error) { delete cache[id]; throw error; }
  return module.exports;
}
requireNative.m = modules;
requireNative.c = cache;
requireNative.j = 348410;
requireNative.g = globalThis;
requireNative.o = own;
requireNative.nmd = module => { module.paths = []; module.children ||= []; return module; };
requireNative.d = (exports, getters, values) => {
  for (const key in getters) if (!own(exports, key)) Object.defineProperty(exports, key, { enumerable: true, get: getters[key] });
  if (values) for (const key in values) if (!own(exports, key)) Object.defineProperty(exports, key, { enumerable: true, value: values[key] });
};
requireNative.r = exports => { Object.defineProperty(exports, '__esModule', { value: true }); Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' }); };
requireNative.n = value => { const getter = value && value.__esModule ? () => value.default : () => value; requireNative.d(getter, { a: () => getter }); return getter; };
// This origin is test-only, but deny even empty storage to native probes.
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Native fixture storage is disabled'); } });
const React = requireNative('zd8w');
const ReactDOM = requireNative('i5yi');
const scope = requireNative('tyzk').z;
const signal = requireNative('hffr').v;
const derived = requireNative('UQAX').u;
const family = requireNative('jwtq').i1;
const queryFamily = requireNative('${profile.queryFamily[0]}').${profile.queryFamily[1]};
${profile.preload.map(id => `requireNative('${id}');`).join('\n')}
// Retain real application factory provenance for discovery, but never execute it.
cache[${JSON.stringify(profile.initial)}] = { exports: {} };
const querySignal = requireNative('${profile.querySignal[0]}').${profile.querySignal[1]};
const hooks = requireNative('${profile.hooks}');
const QueryClient = requireNative('suje').E;
const ScopeProvider = requireNative('${profile.scopeProvider[0]}').${profile.scopeProvider[1]};
const QueryProvider = requireNative('${profile.queryProvider[0]}').${profile.queryProvider[1]};
const initialized = () => {}; // Legacy adapter call: these modules initialize on require above.
export { requireNative as __webpack_require__, initialized as __fuel_uln, initialized as __fuel_queryInit,
  scope as __fuel_lun, signal as __fuel_Bln, derived as __fuel_Pln, family as __fuel_Aln,
  queryFamily as __fuel_queryFamily, querySignal as __fuel_querySignal,
  QueryClient as __fuel_queryClient, ScopeProvider as __fuel_vln, QueryProvider as __fuel_queryProvider };
export const __fuel_react = () => React;
export const __fuel_client = () => ReactDOM;
export const __fuel_fln = hooks.gh;
export const __fuel_hln = hooks._U;
export const __fuel__ln = hooks.Ul;
`
  const payload = Buffer.from(browserModule)
  const moduleIds = [...closure.keys()]
  // All safety/provenance checks above have completed. No AST or complete
  // extracted chunk is part of the returned fixture or a later browser read.
  modules.clear()
  closure.clear()
  parsed.clear()
  sourceFiles.length = 0
  return {
    appName, format: 'webpack', profile: profile.id, initialSource, modelFilterSource, configHelperSource, configBridgeSource,
    moduleIds,
    read: payloadReader(appName, payload),
  }
}

module.exports = { nativeWebpackFixture }
