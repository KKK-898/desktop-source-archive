const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { installedAsar, assertNativeTestPassed, verifyInstalledUltra } = require('./verify-codex-ultra-installed.cjs')

const packagePath = path.resolve('/synthetic/Codex/app.asar')
const files = {
  realpathSync: value => value,
  statSync: () => ({ isFile: () => true, size: 10 }),
  readFileSync: () => Buffer.from('synthetic-asar'),
}
const expectedNativeNames = ['reviewed query', 'model-response fallback'].flatMap(adaptation => ['apikey', 'chatgpt']
  .map(auth => `installed native ${auth} ${adaptation} scope, QueryObserver and React rerenders retain scoped Ultra`))
expectedNativeNames.push('installed native aggregate full model IDs preserve Ultra selection and rerenders')
const passed = {
  status: 0,
  stdout: ['TAP version 13', ...expectedNativeNames.map((name, index) => `ok ${index + 1} - ${name}`),
    '# tests 5', '# pass 5', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', ''].join('\n'),
}

test('explicit installed package works on any platform and is passed to a fresh native test process', () => {
  const calls = []
  const run = (command, args, options) => { calls.push({ command, args, options }); return passed }
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(verifyInstalledUltra({
      env: { CODEX_NATIVE_APP_ASAR: packagePath, CUSTOM_TEST_ENV: 'preserved' },
      platform: 'darwin', files, run, log: () => {},
    }).installedUltraVerified, true)
  }
  assert.equal(calls.length, 2, 'a previous successful result is never reused')
  for (const call of calls) {
    assert.equal(call.command, process.execPath)
    assert.deepEqual(call.args.slice(0, 2), ['--test', '--test-reporter=tap'])
    assert.equal(call.args.at(-1), 'scripts/codex-ultra-runtime.test.cjs')
    assert.equal(call.args.length, 4)
    assert.ok(call.args[2].startsWith('--test-name-pattern='))
    const selection = new RegExp(call.args[2].slice('--test-name-pattern='.length))
    for (const name of expectedNativeNames) assert.ok(selection.test(name))
    for (const name of ['synthetic fixture', 'installed native apikey scope, query family and visible Ultra',
      'installed native apikey unsupported scope, QueryObserver and React rerenders retain scoped Ultra',
      expectedNativeNames[0] + ' unexpected suffix']) assert.equal(selection.test(name), false)
    assert.equal(call.options.timeout, 300000)
    assert.equal(call.options.env.CODEX_NATIVE_APP_ASAR, packagePath)
    assert.equal(call.options.env.CUSTOM_TEST_ENV, 'preserved')
    assert.equal(call.options.shell, false)
  }
})

test('Windows discovery uses the current registered package and refuses a missing installation', () => {
  const calls = []
  const run = (command, args) => {
    calls.push({ command, args })
    return { status: 0, stdout: JSON.stringify([packagePath, '/older/app.asar']) }
  }
  assert.equal(installedAsar({ env: {}, platform: 'win32', files, run }), packagePath)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.match(calls[0].args.at(-1), /Get-AppxPackage -Name OpenAI\.Codex/)
  assert.match(calls[0].args.at(-1), /Sort-Object \{ \[Version\]\$_\.Version \} -Descending/)
  assert.throws(() => installedAsar({
    env: {}, platform: 'win32', files, run: () => ({ status: 0, stdout: '[]' }),
  }), /No registered Codex installation/)
  assert.throws(() => installedAsar({
    env: {}, platform: 'win32', files, run: () => ({ status: 1, stderr: 'discovery error' }),
  }), /discovery error/)
})

test('missing, invalid and empty package paths fail instead of silently skipping', () => {
  assert.throws(() => installedAsar({ env: {}, platform: 'linux', files }), /Set CODEX_NATIVE_APP_ASAR/)
  assert.throws(() => installedAsar({ env: { CODEX_NATIVE_APP_ASAR: '/fixture.js' }, files }), /app\.asar file/)
  assert.throws(() => installedAsar({
    env: { CODEX_NATIVE_APP_ASAR: packagePath },
    files: { ...files, realpathSync: () => { throw new Error('ENOENT') } },
  }), /ENOENT/)
  assert.throws(() => installedAsar({
    env: { CODEX_NATIVE_APP_ASAR: packagePath },
    files: { ...files, statSync: () => ({ isFile: () => true, size: 0 }) },
  }), /nonempty file/)
})

test('native failure, missing test, skip and TODO cannot be mistaken for successful verification', () => {
  assert.doesNotThrow(() => assertNativeTestPassed(passed))
  for (const result of [
    { ...passed, status: 1 },
    { ...passed, error: new Error('test process timed out') },
    { ...passed, stdout: passed.stdout.replace('installed native', 'synthetic') },
    { ...passed, stdout: passed.stdout.replace('retain scoped Ultra', 'retain scoped Ultra # SKIP unavailable') },
    { ...passed, stdout: passed.stdout.replace('retain scoped Ultra', 'retain scoped Ultra # TODO pending') },
    { ...passed, stdout: passed.stdout.replace('ok 2 -', 'not ok 2 -') },
    { ...passed, stdout: passed.stdout.replace('# skipped 0', '# skipped 1') },
  ]) assert.throws(() => assertNativeTestPassed(result))
})

test('an app update during verification invalidates otherwise passing results', () => {
  let reads = 0
  assert.throws(() => verifyInstalledUltra({
    env: { CODEX_NATIVE_APP_ASAR: packagePath }, files: {
      ...files, readFileSync: () => Buffer.from(reads++ ? 'updated-asar' : 'original-asar'),
    }, run: () => passed, log: () => {},
  }), /updated during Ultra verification/)
})

test('one-click release requires fresh installed verification before both new and resumed release branches', () => {
  const { spawnSync } = require('node:child_process')
  const releasePath = path.join(__dirname, 'one-click-release.ps1')
  // Parse without evaluating the entry point. The inline source-ref selection
  // has the same condition text but is not the top-level side-effect branch.
  const probe = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:GAOGE_ULTRA_RELEASE_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Release script must parse without errors.' }
$branches = @($ast.EndBlock.Statements | Where-Object {
  $_ -is [System.Management.Automation.Language.IfStatementAst] -and
  $_.Clauses.Count -eq 1 -and
  $_.Clauses[0].Item1.Extent.Text -eq '[string]::IsNullOrWhiteSpace($remoteSourceTag)' -and
  $null -ne $_.ElseClause
})
if ($branches.Count -ne 1) { throw 'Expected one top-level new/resume release branch.' }
$branch = $branches[0]
function Command-Entries($Root) {
  @($Root.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
    $parent = $_.Parent; $inFunction = $false
    while ($null -ne $parent -and $parent -ne $Root) {
      if ($parent -is [System.Management.Automation.Language.FunctionDefinitionAst]) { $inFunction = $true; break }
      $parent = $parent.Parent
    }
    if (-not $inFunction) {
      [pscustomobject]@{
        name=$_.GetCommandName()
        offset=$_.Extent.StartOffset
        direct=($_.Parent -is [System.Management.Automation.Language.PipelineAst] -and $_.Parent.Parent -eq $Root)
        elements=@($_.CommandElements | ForEach-Object { $_.Extent.Text })
      }
    }
  })
}
@{
  branchStart=$branch.Extent.StartOffset
  newStart=$branch.Clauses[0].Item2.Extent.StartOffset
  resumeStart=$branch.ElseClause.Extent.StartOffset
  all=@(Command-Entries $ast.EndBlock)
  new=@(Command-Entries $branch.Clauses[0].Item2)
  resume=@(Command-Entries $branch.ElseClause)
} | ConvertTo-Json -Depth 8 -Compress
`
  const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000,
    env: { ...process.env, GAOGE_ULTRA_RELEASE_SCRIPT: releasePath, POWERSHELL_UPDATECHECK: 'Off', POWERSHELL_TELEMETRY_OPTOUT: '1' },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const parsed = JSON.parse(result.stdout.trim())
  const select = (commands, elements) => commands.filter(command => command.elements.slice(0, elements.length).join('\0') === elements.join('\0'))
  const nativeChecks = select(parsed.all, ['Invoke-Checked', 'npm', 'run', 'verify:codex-ultra-installed'])
  assert.equal(nativeChecks.length, 1, 'a single fresh installed Ultra check is required on every release')
  const nativeCheck = nativeChecks[0]
  assert.equal(nativeCheck.direct, true, 'installed Ultra verification must be unconditional, not hidden in either release branch')
  assert.ok(nativeCheck.offset < parsed.branchStart, 'installed Ultra verification must precede the complete new/resume branch')
  assert.ok(parsed.branchStart < parsed.newStart && parsed.newStart < parsed.resumeStart)
  const newTags = select(parsed.new, ['Invoke-Checked', 'git', 'tag', '$tagName'])
  const newPushes = select(parsed.new, ['Invoke-Checked', 'git', 'push', 'origin', '$tagName'])
  const resumedFetches = select(parsed.resume, ['Invoke-Checked', 'git', 'fetch', 'origin'])
  assert.equal(newTags.length, 1, 'new release tagging must remain in the guarded new-release branch')
  assert.equal(newPushes.length, 1, 'new release publication must remain in the guarded new-release branch')
  assert.equal(resumedFetches.length, 1, 'resumed release fetch must remain in the guarded resume branch')
  for (const command of [...newTags, ...newPushes, ...resumedFetches]) {
    assert.equal(command.direct, true, 'release side effects must be reached only through their verified branch')
    assert.ok(nativeCheck.offset < command.offset)
  }
  assert.equal(select(parsed.all, ['Invoke-Checked', 'git', 'tag', '$tagName']).length, newTags.length,
    'source tagging cannot bypass the guarded release branch')
  assert.equal(select(parsed.all, ['Invoke-Checked', 'git', 'push', 'origin', '$tagName']).length, newPushes.length,
    'source tag publication cannot bypass the guarded release branch')
  const sourceChecks = select(parsed.all, ['Invoke-Captured', 'git', 'diff', '--name-only', '$remoteSourceTag', 'HEAD', '--'])
  assert.equal(sourceChecks.length, 1)
  assert.ok(sourceChecks[0].offset < nativeCheck.offset, 'a resumed tag must match the code under verification')
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).scripts
  assert.equal(scripts['verify:codex-ultra-installed'], 'node scripts/verify-codex-ultra-installed.cjs')
  assert.ok(scripts['test:release-tooling'].includes('verify-codex-ultra-installed.test.cjs'))
})


test('an installed-package registration change cannot approve an obsolete but unchanged archive', () => {
  let discoveries = 0;
  assert.throws(() => verifyInstalledUltra({
    env: {}, platform: 'win32', files, log: () => {},
    run: (command) => command === 'powershell.exe'
      ? { status: 0, stdout: JSON.stringify([discoveries++ ? '/new-version/app.asar' : packagePath]) }
      : passed,
  }), /installation changed during Ultra verification/);
  assert.equal(discoveries, 2);
});

test('automatic verification rechecks the registered installation even if the old archive hash is unchanged', () => {
  let discoveries = 0;
  const evidence = verifyInstalledUltra({
    env: {}, platform: 'win32', files, log: () => {},
    run: (command) => command === 'powershell.exe'
      ? (discoveries++, { status: 0, stdout: JSON.stringify([packagePath]) })
      : passed,
  });
  assert.equal(discoveries, 2);
  assert.equal(evidence.installationSource, 'registered-package');
});

test('loss of registered installation during verification cannot reuse old success', () => {
  let discoveries = 0;
  assert.throws(() => verifyInstalledUltra({
    env: {}, platform: 'win32', files, log: () => {},
    run: (command) => command === 'powershell.exe'
      ? { status: 0, stdout: JSON.stringify(discoveries++ ? [] : [packagePath]) }
      : passed,
  }), /No registered Codex installation/);
});

test('cancelled or TODO checks cannot be counted as a completed native regression suite', () => {
  for (const summary of ['# cancelled 1', '# todo 1']) {
    assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout + summary + '\n' }));
  }
});


test('all five exact native auth, adaptation and aggregate checks must pass once without substitutions', () => {
  for (const name of expectedNativeNames) {
    const line = passed.stdout.split('\n').find(line => line.endsWith(name))
    assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout.replace(line + '\n', '') }), /all five native checks/)
    assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout + line + '\n' }), /all five native checks/)
    assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout.replace(name, name + ' extra') }), /all five native checks/)
    for (const directive of ['SKIP unavailable', 'TODO pending']) {
      assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout.replace(line, line + ' # ' + directive) }), /did not run and pass/)
    }
  }
  assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout.replace('ok 2 -', 'ok 1 -') }), /all five native checks/)
  assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout.replace('model-response fallback', 'reviewed query') }), /all five native checks/)
})

test('a successful legacy four-case report cannot skip the aggregate regression', () => {
  const aggregate = expectedNativeNames.at(-1)
  const legacy = passed.stdout.split('\n').filter(line => !line.endsWith(aggregate)).join('\n')
    .replace('# tests 5', '# tests 4').replace('# pass 5', '# pass 4')
  assert.throws(() => assertNativeTestPassed({ ...passed, stdout: legacy }), /all five native checks/)
})

test('the five installed checks require a single complete TAP summary with no synthetic or skipped cases', () => {
  for (const [kind, count] of [['tests', 5], ['pass', 5], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]]) {
    const summary = `# ${kind} ${count}\n`
    assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout.replace(summary, '') }), /incomplete/)
    assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout + summary }), /duplicate/)
    assert.throws(() => assertNativeTestPassed({ ...passed, stdout: passed.stdout.replace(summary, `# ${kind} ${count + 1}\n`) }))
  }
})


test('retaining a webpack payload does not retain extracted source ASTs between native scenarios', () => {
  const { spawnSync } = require('node:child_process')
  const fixturePath = path.join(__dirname, 'codex-ultra-webpack-native-fixture.cjs')
  const program = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const NativeModule = require('node:module');
    const ts = require('typescript');
    const fixturePath = process.argv[1];
    const trees = [];
    const frameworkIds = ['j44z','zd8w','i5yi','suje','tyzk','hffr','UQAX','jwtq','zTeN','Xvtr','OeLR','wCOm'];
    const source = 'var m={' + frameworkIds.map(id => id + '(e,t,n){}').join(',') + '};';
    const fixtureModule = new NativeModule(fixturePath, module);
    fixtureModule.filename = fixturePath;
    fixtureModule.paths = NativeModule._nodeModulePaths(require('node:path').dirname(fixturePath));
    fixtureModule.require = id => id === 'typescript'
      ? { ...ts, createSourceFile(...args) { const tree = ts.createSourceFile(...args); trees.push(new WeakRef(tree)); return tree; } }
      : id === '@electron/asar'
        ? { listPackage: () => ['webview/assets/fixture.js'], extractFile: () => Buffer.from(source) }
        : require(id);
    fixtureModule._compile(fs.readFileSync(fixturePath, 'utf8'), fixturePath);
    const payload = fixtureModule.exports.nativeWebpackFixture('/synthetic/app.asar');
    assert.equal(payload.profile, '26.1103');
    assert.equal(trees.length, 1);
    assert.ok(payload.read(payload.appName).length > 0);
    async function collect() {
      // WeakRef targets remain alive until the creating job finishes. Two GC
      // jobs are deliberate; no memory threshold or enlarged heap hides leaks.
      await new Promise(setImmediate); global.gc();
      await new Promise(setImmediate); global.gc();
      assert.ok(trees.every(tree => tree.deref() === undefined), 'Retained browser payload must not keep whole native TypeScript ASTs alive');
      assert.ok(payload.read(payload.appName).includes(Buffer.from('requireNative')));
      assert.equal(payload.read('unreviewed-module.js'), null);
      console.log(JSON.stringify({ retainedPayloadReadable: true, extractedAstsCollected: trees.length }));
    }
    collect().catch(error => { console.error(error); process.exitCode = 1; });
  `
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', program, fixturePath], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true,
    shell: false, timeout: 30000, maxBuffer: 1024 * 1024,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(result.stdout), { retainedPayloadReadable: true, extractedAstsCollected: 1 })
})

test('reviewed webpack framework profiles still refuse application dependencies and side effects', async t => {
  const os = require('node:os')
  const asar = require('@electron/asar')
  const { nativeWebpackFixture } = require('./codex-ultra-webpack-native-fixture.cjs')
  const cases = [
    { name: 'query tracker cannot initialize an application dependency',
      source: 'var m={j44z(e,t,n){},zd8w(e,t,n){n("iwK1")},iwK1(e,t,n){n("accountConfiguration")}};',
      expected: /Unreviewed framework dependency accountConfiguration/ },
    { name: 'a reviewed framework ID cannot introduce network calls',
      source: 'var m={j44z(e,t,n){},zd8w(e,t,n){n("zTeN")},zTeN(e,t,n){fetch("https:\/\/example.invalid")}};',
      expected: /Unexpected global side-effect call fetch in framework zTeN/ },
    { name: 'mixed application profiles cannot select a permissive fallback',
      source: 'var m={j44z(e,t,n){},WL4f(e,t,n){}};',
      expected: /query ownership requires one reviewed framework profile/ },
  ]
  for (const fixture of cases) await t.test(fixture.name, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gaoge-ultra-framework-boundary-'))
    assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()))
    try {
      const input = path.join(tempRoot, 'input'), assets = path.join(input, 'webview', 'assets')
      fs.mkdirSync(assets, { recursive: true })
      fs.writeFileSync(path.join(assets, 'fixture.js'), fixture.source)
      const archive = path.join(tempRoot, 'app.asar')
      await asar.createPackage(input, archive)
      assert.throws(() => nativeWebpackFixture(archive), fixture.expected)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

test('config-query fixture refuses altered native filter and configuration semantics before initialization', () => {
  const ts = require('typescript')
  const { nativeUltraQueryFixture } = require('./codex-ultra-native-query-fixture.cjs')
  const reviewed = fs.readFileSync(path.join(__dirname, 'fixtures/codex-ultra-query-26.1103.js'), 'utf8')
  const tree = ts.createSourceFile('reviewed.js', reviewed, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const declaration = name => tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(tree)
  const anonymous = name => declaration(name).replace('function ' + name + '(', 'function(')
  const filter = anonymous('i')
  const configBridgeSource = tree.statements.filter(ts.isVariableStatement)
    .flatMap(statement => statement.declarationList.declarations)
    .find(declaration => declaration.name.getText(tree) === 'nativeConfigBridge26_1103').initializer.text
  const modelFilterSource = 'Xvtr(e,t,n){var r=n("FQih");n.d(t,{},{a:' + filter + '})}'
  const configHelperSource = 'OeLR(e,t,n){' + declaration('recordNativeConfig')
    + 'n.d(t,{},{Y$:' + anonymous('parseNativeConfig') + ',bo:' + anonymous('hasNativeCatalog')
    + ',cc:' + anonymous('isNativeCustomProvider') + '})}'
  assert.throws(() => nativeUltraQueryFixture(reviewed, {
    modelFilterSource: modelFilterSource.replace('"copilot"', '"unreviewed-provider"'), configHelperSource, configBridgeSource,
  }), /Unsupported native config-query model filter/)
  assert.throws(() => nativeUltraQueryFixture(reviewed, {
    modelFilterSource, configHelperSource: configHelperSource.replace(anonymous('hasNativeCatalog'), 'function(e){return true}'), configBridgeSource,
  }), /Unsupported native configuration helper hasNativeCatalog/)
  assert.throws(() => nativeUltraQueryFixture(reviewed, {
    modelFilterSource, configHelperSource,
    configBridgeSource: configBridgeSource.replace('Y$:()=>i.Y$', 'Y$:()=>value=>i.Y$(value)'),
  }), /Unsupported native configuration helper bridge/)
  assert.throws(() => nativeUltraQueryFixture(reviewed, {
    modelFilterSource, configHelperSource,
    configBridgeSource: configBridgeSource.replace('cc:()=>i.cc', 'cc:()=>i.Y$'),
  }), /Unsupported native configuration helper bridge/)
})
