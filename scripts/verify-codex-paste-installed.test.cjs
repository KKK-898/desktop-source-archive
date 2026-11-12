const assert = require('node:assert/strict')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('node:test')
const { assertPastePassed, verifyInstalledPaste, nativeTestName } = require('./verify-codex-paste-installed.cjs')

const packagePath = path.resolve('/synthetic/Codex/app.asar')
const packageBytes = Buffer.from('synthetic-asar')
const sha256 = crypto.createHash('sha256').update(packageBytes).digest('hex')
const diagnostic = {
  asar: packagePath, nativeExecuted: true,
  modules: ['rTVh', 'Hpb6', 'HLFh', 'f6KK', 'SAxP', 'GTmQ'],
  anchors: { composer: true, paste: true, viewDesc: true },
}
const files = {
  realpathSync: value => value,
  statSync: () => ({ isFile: () => true, size: packageBytes.length }),
  readFileSync: () => packageBytes,
}
function report(value = diagnostic) {
  return [
    'TAP version 13', '# Subtest: synthetic plain text', 'ok 1 - synthetic plain text',
    '# Subtest: synthetic images', 'ok 2 - synthetic images', `# Subtest: ${nativeTestName}`,
    '    # Subtest: native selection and undo', '    ok 1 - native selection and undo',
    '    # Subtest: native code block newlines', '    ok 2 - native code block newlines',
    '    1..2', `ok 3 - ${nativeTestName}`, `# ${JSON.stringify(value)}`,
    '1..3', '# tests 5', '# suites 0', '# pass 5', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '',
  ].join('\n')
}
const passed = { status: 0, stdout: report() }
const expectedEvidence = {
  installedPasteVerified: true, nativeExecuted: true, packagePath, sha256,
  installationSource: 'explicit-package',
  coverage: { nativeClipboard: true, isolatedBrowser: true, liveWordUiRoundTrip: false },
}

// Synthetic wrapper tests only. No actual process, installed package, browser,
// user clipboard, credential file or Word window is accessed by this file.
test('paste verification always runs a fresh isolated child for the selected package', () => {
  const calls = [], logs = [], reads = []
  const env = { CODEX_NATIVE_APP_ASAR: packagePath, CUSTOM_TEST_ENV: 'preserved' }
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(verifyInstalledPaste({
      env, platform: 'darwin', log: value => logs.push(value),
      files: { ...files, readFileSync: value => { reads.push(value); return packageBytes } },
      run: (command, args, options) => { calls.push({ command, args, options }); return passed },
    }), expectedEvidence)
  }
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.command, process.execPath)
    assert.deepEqual(call.args, ['--test', '--test-reporter=tap', 'scripts/codex-paste-runtime.test.cjs'])
    assert.equal(call.options.cwd, path.resolve(__dirname, '..'))
    assert.equal(call.options.env.CODEX_NATIVE_APP_ASAR, packagePath)
    assert.equal(call.options.env.CUSTOM_TEST_ENV, 'preserved')
    assert.equal(call.options.encoding, 'utf8')
    assert.equal(call.options.shell, false)
    assert.equal(call.options.windowsHide, true)
    assert.ok(call.options.timeout > 0)
    assert.ok(call.options.maxBuffer > 0)
  }
  assert.deepEqual(reads, Array(4).fill(packagePath))
  assert.deepEqual(env, { CODEX_NATIVE_APP_ASAR: packagePath, CUSTOM_TEST_ENV: 'preserved' })
  assert.deepEqual(logs.filter(value => value.startsWith('{')).map(value => JSON.parse(value)), [expectedEvidence, expectedEvidence])
})

test('paste verification discovers and then rechecks the registered installation', () => {
  const calls = []
  const evidence = verifyInstalledPaste({
    env: {}, platform: 'win32', files, log: () => {},
    run: (command, args) => {
      calls.push({ command, args })
      return command === 'powershell.exe' ? { status: 0, stdout: JSON.stringify([packagePath, '/older/app.asar']) } : passed
    },
  })
  assert.deepEqual(calls.map(value => value.command), ['powershell.exe', process.execPath, 'powershell.exe'])
  for (const discovery of [calls[0], calls[2]]) {
    assert.match(discovery.args.at(-1), /Get-AppxPackage -Name OpenAI\.Codex/)
    assert.match(discovery.args.at(-1), /Sort-Object \{ \[Version\]\$_\.Version \} -Descending/)
  }
  assert.deepEqual(evidence, { ...expectedEvidence, installationSource: 'registered-package' })
})

test('paste verification requires the exact native browser body and rejects any failed skipped or TODO result', () => {
  const nativeLine = `ok 3 - ${nativeTestName}`
  for (const stdout of [
    passed.stdout.replace(nativeLine, ''),
    passed.stdout.replace(nativeLine, 'ok 3 - synthetic fixture'),
    passed.stdout.replace(nativeLine, nativeLine + ' not the exact test'),
    passed.stdout.replace(nativeLine, 'not ' + nativeLine),
    passed.stdout.replace(nativeLine, nativeLine + ' # SKIP unavailable'),
    passed.stdout.replace(nativeLine, nativeLine + ' # TODO pending'),
    passed.stdout + `ok 4 - ${nativeTestName}\n`,
    passed.stdout.replace('ok 1 - synthetic plain text', 'not ok 1 - synthetic plain text'),
    passed.stdout.replace('ok 2 - synthetic images', 'ok 2 - synthetic images # SKIP other test'),
    passed.stdout.replace('    ok 1 - native selection and undo', '    not ok 1 - native selection and undo'),
    passed.stdout.replace('    ok 2 - native code block newlines', '    ok 2 - native code block newlines # TODO pending'),
    passed.stdout + 'Bail out! browser failed\n',
  ]) assert.throws(() => assertPastePassed({ status: 0, stdout }))
  for (const result of [undefined, null, { ...passed, status: 1 }, { ...passed, status: null },
    { ...passed, error: new Error('test timed out') }, { status: 0 }, { status: 0, stdout: Buffer.from(report()) }]) {
    assert.throws(() => assertPastePassed(result))
  }
  assert.equal(assertPastePassed(passed).nativeExecuted, true)
  assert.doesNotThrow(() => assertPastePassed({ status: 0, stdout: report().replace(/\n/g, '\r\n') }))
})

test('paste verification rejects incomplete concatenated and nonsequential TAP plans', () => {
  for (const stdout of [
    passed.stdout.replace('TAP version 13\n', ''),
    passed.stdout.replace('\n1..3\n', '\n1..0 # SKIP missing browser\n'),
    passed.stdout.replace('\n1..3\n', '\n'),
    passed.stdout.replace('\n1..3\n', '\n1..2\n'),
    passed.stdout.replace('ok 2 - synthetic images', 'ok 1 - synthetic images'),
    passed.stdout.replace('ok 2 - synthetic images', 'ok 4 - synthetic images'),
    passed.stdout + '1..3\n',
    passed.stdout + 'TAP version 13\n',
    passed.stdout + passed.stdout,
    passed.stdout.replace('    ok 1 - native selection and undo\n', ''),
  ]) assert.throws(() => assertPastePassed({ status: 0, stdout }))
})

test('paste verification requires explicit unique totals and zero failures cancellations skips and todos', () => {
  for (const [name, expected] of Object.entries({ tests: 5, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    const line = `# ${name} ${expected}`
    for (const stdout of [
      passed.stdout.replace(line + '\n', ''),
      passed.stdout.replace(line, `# ${name} ${expected + 1}`),
      passed.stdout + line + '\n',
    ]) assert.throws(() => assertPastePassed({ status: 0, stdout }), undefined, name)
  }
})

test('paste verification binds one native editor diagnostic to the selected ASAR and all anchors', () => {
  assert.doesNotThrow(() => assertPastePassed(passed, { packagePath }))
  for (const value of [
    { ...diagnostic, nativeExecuted: false },
    { ...diagnostic, nativeExecuted: undefined },
    { ...diagnostic, asar: undefined },
    { ...diagnostic, asar: '' },
    { ...diagnostic, asar: path.resolve('/obsolete/app.asar') },
    { ...diagnostic, modules: [] },
    { ...diagnostic, modules: undefined },
    { ...diagnostic, modules: ['duplicate', 'duplicate'] },
    { ...diagnostic, modules: [''] },
    { ...diagnostic, modules: [1] },
    { ...diagnostic, anchors: { ...diagnostic.anchors, composer: false } },
    { ...diagnostic, anchors: { ...diagnostic.anchors, paste: undefined } },
    { ...diagnostic, anchors: { ...diagnostic.anchors, viewDesc: 'true' } },
  ]) assert.throws(() => assertPastePassed({ status: 0, stdout: report(value) }, { packagePath }))
  for (const stdout of [
    passed.stdout.replace(`# ${JSON.stringify(diagnostic)}\n`, ''),
    passed.stdout + `# ${JSON.stringify(diagnostic)}\n`,
    passed.stdout.replace(JSON.stringify(diagnostic), '{invalid-json}'),
  ]) assert.throws(() => assertPastePassed({ status: 0, stdout }))
  assert.doesNotThrow(() => assertPastePassed(passed, { packagePath: packagePath.toUpperCase(), platform: 'win32' }))
  assert.throws(() => assertPastePassed(passed, { packagePath: packagePath.toUpperCase(), platform: 'darwin' }))
})

test('an ASAR update invalidates passing paste evidence without publishing a receipt', () => {
  let reads = 0
  const logs = []
  assert.throws(() => verifyInstalledPaste({
    env: { CODEX_NATIVE_APP_ASAR: packagePath }, platform: 'darwin',
    files: { ...files, readFileSync: () => reads++ ? Buffer.from('updated-asar') : packageBytes },
    run: () => passed, log: value => logs.push(value),
  }), /updated during paste verification/)
  assert.equal(reads, 2)
  assert.equal(logs.filter(value => value.startsWith('{')).length, 0)
})

test('paste verification refuses the old unchanged ASAR after registration changes', () => {
  let discoveries = 0
  const logs = []
  assert.throws(() => verifyInstalledPaste({
    env: {}, platform: 'win32', files, log: value => logs.push(value),
    run: command => command === 'powershell.exe'
      ? { status: 0, stdout: JSON.stringify([discoveries++ ? path.resolve('/new-version/app.asar') : packagePath]) }
      : passed,
  }), /installation changed during paste verification/)
  assert.equal(discoveries, 2)
  assert.equal(logs.filter(value => value.startsWith('{')).length, 0)
})

test('paste verification refuses missing or lost registration and never falls back to a cached result', () => {
  for (const absentAfterTest of [false, true]) {
    let discoveries = 0, children = 0
    assert.throws(() => verifyInstalledPaste({
      env: {}, platform: 'win32', files, log: () => {},
      run: command => {
        if (command !== 'powershell.exe') { children++; return passed }
        return { status: 0, stdout: JSON.stringify(absentAfterTest && discoveries++ === 0 ? [packagePath] : []) }
      },
    }), /No registered Codex installation/)
    assert.equal(children, absentAfterTest ? 1 : 0)
  }
  assert.throws(() => verifyInstalledPaste({ env: {}, platform: 'darwin', files, run: () => assert.fail('No child before package selection'), log: () => {} }), /Set CODEX_NATIVE_APP_ASAR/)
})

test('failed or mismatched native paste checks cannot publish verified evidence', () => {
  for (const result of [
    { ...passed, status: 1 },
    { ...passed, error: new Error('browser timed out') },
    { ...passed, stdout: passed.stdout.replace('# skipped 0', '# skipped 1') },
    { ...passed, stdout: report({ ...diagnostic, asar: path.resolve('/different/app.asar') }) },
  ]) {
    const logs = []
    assert.throws(() => verifyInstalledPaste({
      env: { CODEX_NATIVE_APP_ASAR: packagePath }, platform: 'darwin', files,
      run: () => result, log: value => logs.push(value),
    }))
    assert.equal(logs.filter(value => value.startsWith('{')).length, 0)
  }
})
