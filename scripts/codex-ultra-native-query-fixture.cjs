const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const tokens = source => source.match(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\?\.|\S/g) || []

function functionDeclaration(tree, name) {
  const matches = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.equal(matches.length, 1, `Expected one native Ultra function ${name}`)
  return matches[0].getText(tree)
}

function webpackImports(source) {
  const tree = ts.createSourceFile('native-module.js', '({' + source + '})', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const methods = []
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)
        || !ts.isObjectLiteralExpression(statement.expression.expression)) continue
    methods.push(...statement.expression.expression.properties.filter(ts.isMethodDeclaration))
  }
  assert.equal(methods.length, 1, 'Expected one native module factory')
  const method = methods[0], requireName = method.parameters[2]?.name.getText(tree), imports = new Map()
  function visit(node) {
    if (ts.isFunctionLike(node)) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
        && node.initializer.expression.text === requireName && node.initializer.arguments.length === 1
        && ts.isStringLiteral(node.initializer.arguments[0])) {
      const id = node.initializer.arguments[0].text
      assert.ok(!imports.has(id) || imports.get(id) === node.name.text, 'Ambiguous native module import ' + id)
      imports.set(id, node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(method.body)
  return imports
}

function webpackPureExport(source, key, name) {
  const tree = ts.createSourceFile('native-export.js', '({' + source + '})', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const matches = []
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === key && ts.isFunctionExpression(node.initializer)) {
      matches.push(node.initializer.getText(tree))
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.equal(matches.length, 1, 'Expected one pure native export ' + key)
  assert.match(matches[0], /^function\(/, 'Expected an anonymous pure native export')
  return matches[0].replace(/^function\(/, 'function ' + name + '(')
}

function nativeConfigQueryFixture(runtime, initialSource, callbackSource, modelFilterSource, configHelperSource, configBridgeSource) {
  assert.ok(modelFilterSource && configHelperSource && configBridgeSource, 'Config-query fixture requires installed filter, configuration helpers and bridge')
  const reviewed = fs.readFileSync(path.join(__dirname, 'fixtures/codex-ultra-query-26.1103.js'), 'utf8')
  const reviewedTree = ts.createSourceFile('reviewed-config-query.js', reviewed, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const reviewedBridge = reviewedTree.statements.filter(ts.isVariableStatement)
    .flatMap(statement => statement.declarationList.declarations)
    .find(declaration => declaration.name.getText(reviewedTree) === 'nativeConfigBridge26_1103')?.initializer
  assert.ok(reviewedBridge && ts.isStringLiteral(reviewedBridge), 'Missing reviewed configuration bridge source')
  // This application bridge contains live config/read functions. Compare its
  // source only: never initialize it to obtain the helper re-exports.
  assert.equal(runtime.codexUltraCanonical(configBridgeSource), runtime.codexUltraCanonical(reviewedBridge.text),
    'Unsupported native configuration helper bridge')
  const filterSource = webpackPureExport(modelFilterSource, 'a', 'i')
  assert.equal(runtime.codexUltraCanonical(filterSource), runtime.codexUltraCanonical(functionDeclaration(reviewedTree, 'i')),
    'Unsupported native config-query model filter')

  const configTree = ts.createSourceFile('native-config.js', '({' + configHelperSource + '})', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const recordParsers = []
  function findRecordParser(node) {
    if (ts.isFunctionDeclaration(node) && node.body?.getText(configTree).includes('.safeParse(')) recordParsers.push(node)
    ts.forEachChild(node, findRecordParser)
  }
  findRecordParser(configTree)
  assert.equal(recordParsers.length, 1, 'Expected one native JSON-record parser')
  const parserName = recordParsers[0].name.text
  const recordSource = recordParsers[0].getText(configTree).replace('function ' + parserName + '(', 'function recordNativeConfig(')
  const schemaName = /([\w$]+)\.safeParse\(/.exec(recordSource)?.[1]
  assert.ok(schemaName, 'Native configuration record validator must be recognizable')
  const configSources = [recordSource, ...[['Y$', 'parseNativeConfig'], ['bo', 'hasNativeCatalog'], ['cc', 'isNativeCustomProvider']]
    .map(([key, name]) => webpackPureExport(configHelperSource, key, name)
      .replace(new RegExp('\\b' + parserName.replace(/\$/g, '\\$') + '\\(', 'g'), 'recordNativeConfig('))]
  for (const [index, name] of ['recordNativeConfig', 'parseNativeConfig', 'hasNativeCatalog', 'isNativeCustomProvider'].entries()) {
    assert.equal(runtime.codexUltraCanonical(configSources[index]), runtime.codexUltraCanonical(functionDeclaration(reviewedTree, name)),
      'Unsupported native configuration helper ' + name)
  }

  const imports = webpackImports(initialSource), validator = webpackImports(modelFilterSource).get('FQih')
  assert.ok(validator, 'Expected the reviewed native reasoning validator')
  const bindings = {
    GaA7: '{appServices:bindings.daybreak}', kfGJ: '{fI:"local"}', jRfV: '{i:bindings.preference}',
    qcLg: '{dK:bindings.daybreakSupported||{}}', Q4dB: '{o:bindings.modelKey||((host,auth,limit)=>["model/list",host,auth,limit])}',
    Q3tq: '{pN:bindings.efforts}', dPoV: '{t:bindings.catalog}', OMIV: '{JW:bindings.gate}', tl5a: '{Dj:bindings.hosts}',
    rvFo: '{D:{FIVE_MINUTES:300000}}', Dgwo: '{V:()=>({sendRequest:bindings.sendRequest})}', Xvtr: '{a:__nativeFilter}',
    wCOm: '__nativeConfig', OeLR: '__nativeConfig', B81s: '{I2:bindings.config}',
  }
  const declarations = Object.entries(bindings).map(([id, value]) => {
    assert.ok(imports.has(id), 'Missing reviewed native query binding ' + id)
    return 'const ' + imports.get(id) + '=' + value + ';'
  })
  const factorySource = [
    'const __nativeFilter=(()=>{const ' + validator + '={eE:value=>["none","minimal","low","medium","high","xhigh","max","ultra","persistent"].includes(value)};',
    filterSource, 'return i;})();',
    // Native config comes from a JSON transport. Keep only JSON records in this
    // synthetic transport; execute the actual reviewed profile/custom helpers.
    'const __nativeConfig=(()=>{const isJson=value=>value===null||typeof value==="string"||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)||Array.isArray(value)&&value.every(isJson)||value!==null&&typeof value==="object"&&!Array.isArray(value)&&Object.values(value).every(isJson);',
    'const ' + schemaName + '={safeParse:value=>({success:value!==null&&typeof value==="object"&&!Array.isArray(value)&&isJson(value),data:value})};',
    ...configSources, 'return {Y$:parseNativeConfig,bo:hasNativeCatalog,cc:isNativeCustomProvider};})();',
    ...declarations, 'return (' + callbackSource + ');',
  ].join('\n')
  return { callbackSource, filterSource, factorySource, filterName: 'i', format: 'webpack', profile: '26.1103' }
}

// Extract only the reviewed, pure model-list callback/filter from the actual
// installation. Never evaluate its module initialization or account services.
function nativeUltraQueryFixture(initialSource, { modelFilterSource, configHelperSource, configBridgeSource } = {}) {
  const runtime = vm.createContext({})
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_ultra_runtime.js'), 'utf8'), runtime)
  const callbackSource = runtime.inspectCodexUltraRuntimeSource(initialSource).callback
  if (runtime.CODEX_ULTRA_RUNTIME_CONFIG_QUERY_SHAPE
      && runtime.codexUltraCanonical(callbackSource) === runtime.codexUltraCanonical(runtime.CODEX_ULTRA_RUNTIME_CONFIG_QUERY_SHAPE)) {
    return nativeConfigQueryFixture(runtime, initialSource, callbackSource, modelFilterSource, configHelperSource, configBridgeSource)
  }
  if (runtime.codexUltraCanonical(callbackSource) === runtime.codexUltraCanonical(runtime.CODEX_ULTRA_RUNTIME_WEBPACK_QUERY_SHAPE)) {
    assert.ok(modelFilterSource, 'Webpack fixture requires the actual installed pure filter')
    const wrapped = ts.createSourceFile('native-filter.js', '({' + modelFilterSource + '})', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const declarations = []
    function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'i') declarations.push(node); ts.forEachChild(node, visit) }
    visit(wrapped)
    assert.equal(declarations.length, 1, 'Expected one native webpack filter')
    const filterSource = declarations[0].getText(wrapped)
    const reviewedSource = fs.readFileSync(path.join(__dirname, 'fixtures/codex-ultra-query-26.1029.js'), 'utf8')
    const reviewedTree = ts.createSourceFile('reviewed-filter.js', reviewedSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    assert.equal(runtime.codexUltraCanonical(filterSource), runtime.codexUltraCanonical(functionDeclaration(reviewedTree, 'i')), 'Unsupported native webpack model filter')
    const factorySource = [
      "const r={eE:value=>['none','minimal','low','medium','high','xhigh','max','ultra','persistent'].includes(value)};",
      filterSource.replace(/^function i\(/, 'function filter('),
      'const p={appServices:bindings.daybreak},m={fI:"local"},f={i:bindings.preference},h={dK:bindings.daybreakSupported||{}},I={o:bindings.modelKey||((host,auth,limit)=>["model/list",host,auth,limit])};',
      'const x={pN:bindings.efforts},C={t:bindings.catalog},v={JW:bindings.gate},s={Dj:bindings.hosts},y={D:{FIVE_MINUTES:300000}},d={V:()=>({sendRequest:bindings.sendRequest})},l={a:filter};',
      'return ('+callbackSource+');',
    ].join('\n')
    return { callbackSource, filterSource, factorySource, filterName:'i', format:'webpack' }
  }
  const legacy = runtime.CODEX_ULTRA_RUNTIME_QUERY_SHAPE
  const patched = legacy.replace('a&&u(kc,`1186680773`)', 'a&&(u(kc,`1186680773`)||t===`apikey`&&o&&r)')
  const references = [
    { source: legacy, names: ['Pd', 'zc', 'dHe', 'yee', 'GRi', 'BRi', 'kc', 'Ie', 'Qg', 'jg', 'ARi'] },
    { source: patched, names: ['Pd', 'zc', 'dHe', 'yee', 'GRi', 'BRi', 'kc', 'Ie', 'Qg', 'jg', 'ARi'] },
    { source: runtime.CODEX_ULTRA_RUNTIME_TEAM_QUERY_SHAPE, names: ['Oi', 'Dh', 'Ntr', 'VIn', 'vvo', 'svo', 'rg', 'Ih', 'Zi', 'Vh', 'lvo'] },
    { source: runtime.CODEX_ULTRA_RUNTIME_SIGNAL_QUERY_SHAPE, preferenceSignal: true,
      names: ['Js', 'Jir', 'Zir', '_zn', 'lIo', 'QFo', 'Fh', 'dh', 'fu', 'gh', 'eIo'] },
  ]
  const reference = references.find(item => item.source &&
    runtime.codexUltraCanonical(item.source) === runtime.codexUltraCanonical(callbackSource))
  assert.ok(reference, 'Installed Ultra callback must match a reviewed runtime contract')
  const expectedTokens = tokens(reference.source), actualTokens = tokens(callbackSource)
  assert.equal(actualTokens.length, expectedTokens.length)
  const aliases = reference.names.map(name => {
    const occurrences = expectedTokens.flatMap((token, index) => token === name ? [actualTokens[index]] : [])
    assert.ok(occurrences.length > 0 && occurrences.every(value => value === occurrences[0]), `Ambiguous native binding ${name}`)
    assert.match(occurrences[0], /^[A-Za-z_$][\w$]*$/)
    return occurrences[0]
  })
  const [daybreak, preference, daybreakSupported, modelKey, efforts, catalog, gate, hosts, times, manager, filter] = aliases
  const tree = ts.createSourceFile('native-app-initial.js', initialSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const filterFunction = functionDeclaration(tree, filter)
  const helper = /if\(([\w$]+)\(\{additionalAvailableModels:/.exec(filterFunction)?.[1]
  const validator = /\.filter\(\(\{reasoningEffort:([\w$]+)\}\)=>([\w$]+)\(\1\)&&/.exec(filterFunction)?.[2]
  assert.ok(helper && validator, 'Native model filter helper and reasoning validator must be recognizable')
  const helperFunction = functionDeclaration(tree, helper)
  // The current installed functions remain the execution source. This check
  // limits extraction to the pure filtering semantics that were reviewed.
  const reviewed = fs.readFileSync(path.join(__dirname, 'fixtures/codex-model-filter-26.1007.js'), 'utf8')
  const reviewedTree = ts.createSourceFile('reviewed-filter.js', reviewed, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(runtime.codexUltraCanonical(filterFunction),
    runtime.codexUltraCanonical(functionDeclaration(reviewedTree, 'ARi')), 'Unsupported native Ultra model filter')
  assert.equal(runtime.codexUltraCanonical(helperFunction),
    runtime.codexUltraCanonical(functionDeclaration(reviewedTree, 'jRi')), 'Unsupported native Ultra visibility filter')
  const filterSource = `${filterFunction}\n${helperFunction}`
  const factorySource = [
    `const ${daybreak} = bindings.daybreak;`,
    `const ${preference} = ${reference.preferenceSignal ? 'bindings.preference' : '(bindings.readPreference || (() => undefined))'};`,
    `const ${daybreakSupported} = bindings.daybreakSupported || {};`,
    `const ${modelKey} = bindings.modelKey || ((host, auth, limit) => ['model/list', host, auth, limit]);`,
    `const ${efforts} = bindings.efforts, ${catalog} = bindings.catalog, ${gate} = bindings.gate, ${hosts} = bindings.hosts;`,
    `const ${times} = { FIVE_MINUTES: 300000 };`,
    `const ${manager} = () => ({ sendRequest: bindings.sendRequest });`,
    `const ${validator} = value => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'].includes(value);`,
    filterSource,
    `return (${callbackSource});`,
  ].join('\n')
  return { callbackSource, filterSource, factorySource, filterName: filter, helperName: helper, validatorName: validator }
}

module.exports = { nativeUltraQueryFixture }
