const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const asar = require('@electron/asar')
const ts = require('typescript')
const NativeModule = require('node:module')

const asarPath = process.env.CODEX_NATIVE_APP_ASAR
const rootDir = path.join(__dirname, '../src-tauri/src')
const rspackPath = path.join(rootDir, 'third_party/codex-plus-plus/native-fast-rspack.js')
const nativeModule = new NativeModule(rspackPath, module)
nativeModule._compile(fs.readFileSync(rspackPath, 'utf8'), rspackPath)
const rspack = nativeModule.exports

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function readFactories(packagePath) {
  const files = asar.listPackage(packagePath).map(file => file.replace(/^[\\/]/, ''))
    .filter(file => /webview[\\/]assets[\\/].*\.js$/.test(file))
  const variants = new Map()
  for (const file of files) {
    const source = asar.extractFile(packagePath, file).toString('utf8')
    if (!source.includes('readServiceTier') && !(source.includes('serviceTierAccess:') && source.includes('authMethod'))
      && !(source.includes('query.setData') && source.includes('personalAccessToken'))) continue
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    // Read factory dictionaries only; application factories are never executed.
    for (const statement of tree.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue
        for (const node of declaration.initializer.properties) {
          if (!ts.isMethodDeclaration(node) || !node.body || node.parameters.length > 3) continue
          const key = node.name.getText(tree).replace(/^['"]|['"]$/g, '')
          const text = node.getText(tree)
          if (!text.includes('readServiceTier') && !(text.includes('serviceTierAccess:') && text.includes('authMethod'))
            && !(text.includes('query.setData') && text.includes('personalAccessToken'))) continue
          if (!variants.has(key)) variants.set(key, new Map())
          variants.get(key).set(text, { key, source: text, file })
        }
      }
    }
  }
  return { factories: [...variants.values()].map(values => values.values().next().value),
    variants: [...variants.values()].flatMap(values => [...values.values()]) }
}

test('registered native ASAR matches and prepares all four Fast gates without executing application modules',
  { skip: !asarPath ? 'Set CODEX_NATIVE_APP_ASAR to the registered native installation for compatibility validation' : false },
  async t => {
    assert.ok(fs.existsSync(asarPath), 'The specified installed ASAR must exist')
    const before = await sha256(asarPath)
    const { factories, variants } = readFactories(asarPath)
    const planned = rspack.planFactories(factories)
    assert.equal(planned.ok, true, JSON.stringify(planned.diagnostics))
    for (const name of ['ui-access', 'request-access', 'queue-default-access', 'queue-explicit-access']) {
      assert.equal(planned.diagnostics.matches[name], 1, `Actual installed package must contain one ${name}`)
    }
    // Rspack legitimately repeats a module in lazy chunks. Every distinct on-disk
    // variant must satisfy the same complete four-gate contract, whichever loads last.
    for (const variant of variants) {
      const input = factories.map(factory => factory.key === variant.key ? variant : factory)
      const checked = rspack.planFactories(input)
      assert.equal(checked.ok, true, `${variant.file}: ${JSON.stringify(checked.diagnostics)}`)
    }
    for (const factory of planned.factories) {
      new vm.Script(`({${factory.source}})`, { filename: `native-fast-${factory.key}.js` })
    }
    const html = asar.extractFile(asarPath, 'webview/index.html').toString('utf8')
    const scripts = [...html.matchAll(/<script[^>]*\bsrc="(\/assets\/[^\"]+\.js)"/g)]
      .map(match => ({ src: `app://-${match[1]}` }))
    assert.ok(scripts.length, 'Native HTML must publish its actual module entries')
    const context = vm.createContext({ URL, TextEncoder, module: { exports: {} }, console })
    context.window = context
    context.location = new URL('app://-/index.html')
    context.document = { scripts }
    vm.runInContext(fs.readFileSync(rspackPath, 'utf8') + '\n'
      + fs.readFileSync(path.join(rootDir, 'third_party/codex-plus-plus/native-fast-unlock.js'), 'utf8')
      + '\n' + fs.readFileSync(path.join(rootDir, 'codex_native_fast_runtime.js'), 'utf8'), context)
    const runtime = context.installCodexNativeFastRuntime({ enabled: true, localApiConfigured: true })
    const result = await runtime.prepare({
      fetchText: async url => asar.extractFile(asarPath, path.join('webview', new URL(url).pathname.slice(1))).toString('utf8'),
      readRspackFactories: async () => factories,
    })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    assert.equal(result.diagnostics.rewriters.fast, 'patched')
    assert.ok(result.modules.length >= 1)
    assert.ok(result.modules.some(item => item.patchedSource.includes('window.__codexPlusNativeFastCompiled="v1";')))
    for (const item of result.modules) {
      const parsed = ts.createSourceFile(item.url, item.patchedSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      assert.equal(parsed.parseDiagnostics.length, 0, `Patched module must remain valid JavaScript: ${item.url}`)
    }
    assert.equal(runtime.status().ready, false, 'Preparation alone must never certify native execution')
    assert.equal(await sha256(asarPath), before, 'Read-only verification must leave the installed package unchanged')
    t.diagnostic(JSON.stringify({ asar: path.resolve(asarPath), sha256: before,
      matches: planned.diagnostics.matches, factoryVariants: variants.length, patchedFactories: planned.factories.map(item => item.key),
      preparedModules: result.modules.map(item => item.url), nativeExecuted: false }))
  })
