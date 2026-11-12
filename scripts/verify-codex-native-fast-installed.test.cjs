const assert = require('node:assert/strict')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('node:test')
const { assertNativeFastPassed, verifyInstalledNativeFast, nativeTestName } = require('./verify-codex-native-fast-installed.cjs')

const packagePath = path.resolve('/synthetic/Codex/app.asar')
const packageBytes = Buffer.from('synthetic-asar')
const sha256 = crypto.createHash('sha256').update(packageBytes).digest('hex')
const diagnostic = {
  asar: packagePath, sha256, nativeExecuted: false,
  matches: { 'ui-access': 1, 'request-access': 1, 'queue-default-access': 1, 'queue-explicit-access': 1 },
}
const files = {
  realpathSync: value => value,
  statSync: () => ({ isFile: () => true, size: packageBytes.length }),
  readFileSync: () => packageBytes,
}
function report(value = diagnostic) {
  return [
    'TAP version 13', `# Subtest: ${nativeTestName}`, `ok 1 - ${nativeTestName}`,
    `# ${JSON.stringify(value)}`, '1..1', '# tests 1', '# pass 1', '# fail 0',
    '# cancelled 0', '# skipped 0', '# todo 0', '',
  ].join('\n')
}
const passed = { status: 0, stdout: report() }

// These are ordinary, synthetic release-tooling checks. No installed ASAR or
// native compatibility test is opened or spawned by this unit test file.
test('native Fast always runs a fresh child with the selected installed package', () => {
  const calls = []
  const logs = []
  const selectedEnv = { CODEX_NATIVE_APP_ASAR: packagePath, CUSTOM_TEST_ENV: 'preserved' }
  for (let attempt = 0; attempt < 2; attempt++) {
    const evidence = verifyInstalledNativeFast({
      env: selectedEnv, platform: 'darwin', files, log: value => logs.push(value),
      run: (command, args, options) => { calls.push({ command, args, options }); return passed },
    })
    assert.deepEqual(evidence, {
      installedNativeFastModulesVerified: true, nativeExecuted: false, packagePath, sha256,
      installationSource: 'explicit-package',
    })
  }
  assert.equal(calls.length, 2, 'each invocation must run the installed test again')
  for (const call of calls) {
    assert.equal(call.command, process.execPath)
    assert.deepEqual(call.args, ['--test', '--test-reporter=tap', 'scripts/codex-native-fast-installed.test.cjs'])
    assert.equal(call.options.cwd, path.resolve(__dirname, '..'))
    assert.equal(call.options.env.CODEX_NATIVE_APP_ASAR, packagePath)
    assert.equal(call.options.env.CUSTOM_TEST_ENV, 'preserved')
    assert.equal(call.options.encoding, 'utf8')
    assert.equal(call.options.shell, false)
    assert.equal(call.options.windowsHide, true)
    assert.ok(call.options.timeout > 0)
  }
  const receipts = logs.filter(value => value.startsWith('{')).map(value => JSON.parse(value))
  assert.equal(receipts.length, 2)
  assert.ok(receipts.every(value => value.installedNativeFastModulesVerified === true && value.nativeExecuted === false))
  assert.deepEqual(selectedEnv, { CODEX_NATIVE_APP_ASAR: packagePath, CUSTOM_TEST_ENV: 'preserved' })
})

test('native Fast verification discovers and then rechecks the current registered package', () => {
  const calls = []
  const evidence = verifyInstalledNativeFast({
    env: {}, platform: 'win32', files, log: () => {},
    run: (command, args) => {
      calls.push({ command, args })
      return command === 'powershell.exe'
        ? { status: 0, stdout: JSON.stringify([packagePath, '/older/app.asar']) }
        : passed
    },
  })
  assert.deepEqual(calls.map(value => value.command), ['powershell.exe', process.execPath, 'powershell.exe'])
  for (const discovery of [calls[0], calls[2]]) {
    assert.match(discovery.args.at(-1), /Get-AppxPackage -Name OpenAI\.Codex/)
    assert.match(discovery.args.at(-1), /Sort-Object \{ \[Version\]\$_\.Version \} -Descending/)
  }
  assert.equal(evidence.packagePath, packagePath)
  assert.equal(evidence.installationSource, 'registered-package')
  assert.equal(evidence.nativeExecuted, false)
})

test('native Fast requires exactly one passing target and rejects missing duplicate failed skipped and TODO checks', () => {
  const successLine = `ok 1 - ${nativeTestName}`
  for (const stdout of [
    passed.stdout.replace(successLine, ''),
    passed.stdout.replace(successLine, `ok 1 - synthetic fixture`),
    passed.stdout.replace(successLine, `not ok 1 - ${nativeTestName}`),
    passed.stdout.replace(successLine, successLine + ' # SKIP unavailable'),
    passed.stdout.replace(successLine, successLine + ' # TODO pending'),
    passed.stdout + `ok 2 - ${nativeTestName}\n`,
    passed.stdout + 'ok 2 - unrelated test\n',
    passed.stdout.replace('1..1', '1..0 # SKIP unavailable'),
    passed.stdout.replace('1..1', ''),
  ]) assert.throws(() => assertNativeFastPassed({ status: 0, stdout }))
  for (const result of [undefined, { ...passed, status: 1 }, { ...passed, status: null },
    { ...passed, error: new Error('test timed out') }, { status: 0 }]) {
    assert.throws(() => assertNativeFastPassed(result))
  }
  assert.equal(assertNativeFastPassed(passed).nativeExecuted, false)
})

test('native Fast requires explicit unique completed counters with zero fail cancel skip and todo', () => {
  for (const [name, expected] of Object.entries({ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    const line = `# ${name} ${expected}`
    const different = expected === 1 ? 0 : 1
    for (const stdout of [
      passed.stdout.replace(line + '\n', ''),
      passed.stdout.replace(line, `# ${name} ${different}`),
      passed.stdout + line + '\n',
    ]) assert.throws(() => assertNativeFastPassed({ status: 0, stdout }), undefined, name)
  }
})

test('native Fast accepts only one four-gate read-only diagnostic for the selected ASAR and digest', () => {
  assert.doesNotThrow(() => assertNativeFastPassed(passed, { packagePath, sha256 }))
  for (const value of [
    { ...diagnostic, nativeExecuted: true },
    { ...diagnostic, nativeExecuted: undefined },
    { ...diagnostic, asar: undefined },
    { ...diagnostic, sha256: 'not-a-digest' },
    { ...diagnostic, sha256: 'f'.repeat(64) },
    { ...diagnostic, asar: path.resolve('/obsolete/app.asar') },
    { ...diagnostic, matches: { ...diagnostic.matches, 'request-access': 0 } },
    { ...diagnostic, matches: { ...diagnostic.matches, 'queue-explicit-access': 2 } },
  ]) assert.throws(() => assertNativeFastPassed({ status: 0, stdout: report(value) }, { packagePath, sha256 }))
  for (const stdout of [
    passed.stdout.replace(`# ${JSON.stringify(diagnostic)}\n`, ''),
    passed.stdout + `# ${JSON.stringify(diagnostic)}\n`,
    passed.stdout.replace(JSON.stringify(diagnostic), '{invalid-json}'),
  ]) assert.throws(() => assertNativeFastPassed({ status: 0, stdout }))
})

test('an ASAR update invalidates otherwise passing native Fast evidence', () => {
  let reads = 0
  const logs = []
  assert.throws(() => verifyInstalledNativeFast({
    env: { CODEX_NATIVE_APP_ASAR: packagePath }, files: {
      ...files, readFileSync: () => reads++ ? Buffer.from('updated-asar') : packageBytes,
    }, run: () => passed, log: value => logs.push(value),
  }), /updated during native Fast verification/)
  assert.equal(reads, 2)
  assert.equal(logs.filter(value => value.startsWith('{')).length, 0, 'a changed package never publishes a success receipt')
})

test('native Fast refuses an obsolete unchanged ASAR after registration switches to another package', () => {
  let discoveries = 0
  assert.throws(() => verifyInstalledNativeFast({
    env: {}, platform: 'win32', files, log: () => {},
    run: command => command === 'powershell.exe'
      ? { status: 0, stdout: JSON.stringify([discoveries++ ? path.resolve('/new-version/app.asar') : packagePath]) }
      : passed,
  }), /installation changed during native Fast verification/)
  assert.equal(discoveries, 2)
})

test('native Fast refuses a missing or lost registration rather than reusing a prior result', () => {
  for (const absentAfterTest of [false, true]) {
    let discoveries = 0
    let children = 0
    assert.throws(() => verifyInstalledNativeFast({
      env: {}, platform: 'win32', files, log: () => {},
      run: command => {
        if (command !== 'powershell.exe') { children++; return passed }
        return { status: 0, stdout: JSON.stringify(absentAfterTest && discoveries++ === 0 ? [packagePath] : []) }
      },
    }), /No registered Codex installation/)
    assert.equal(children, absentAfterTest ? 1 : 0)
  }
})

test('native Fast compares Windows registration paths without case sensitivity', () => {
  let discoveries = 0
  const evidence = verifyInstalledNativeFast({
    env: {}, platform: 'win32', files, log: () => {},
    run: command => command === 'powershell.exe'
      ? { status: 0, stdout: JSON.stringify([discoveries++ ? packagePath.toUpperCase() : packagePath]) }
      : passed,
  })
  assert.equal(discoveries, 2)
  assert.equal(evidence.installedNativeFastModulesVerified, true)
})
