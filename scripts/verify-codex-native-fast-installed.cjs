const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')

const root = path.resolve(__dirname, '..')
const nativeTest = 'scripts/codex-native-fast-installed.test.cjs'
const nativeTestName = 'registered native ASAR matches and prepares all four Fast gates without executing application modules'

function samePackagePath(left, right, platform) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = path.resolve(left)
  const b = path.resolve(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function assertNativeFastPassed(result, { packagePath, sha256, platform = process.platform } = {}) {
  if (!result || result.error || result.status !== 0) {
    throw new Error(`Installed Codex native Fast verification failed: ${result?.error?.message || `test exit ${result?.status}`}`)
  }
  const output = result.stdout
  if (typeof output !== 'string') throw new Error('Installed native Fast verification did not return a TAP report.')
  const lines = output.split(/\r?\n/)
  const results = lines.filter(line => /^(?:not )?ok \d+ - /.test(line))
  if (results.length !== 1 || results[0] !== `ok 1 - ${nativeTestName}`) {
    throw new Error('Installed native Fast verification must run and pass exactly one target test. Missing, duplicate, skipped, TODO, or failed checks cannot approve a release.')
  }
  // A zero exit status alone can mean an entirely skipped test. Require every
  // completion counter explicitly; a missing counter is not evidence of zero.
  for (const [name, expected] of Object.entries({ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    const counters = lines.map(line => new RegExp(`^# ${name} (\\d+)\\s*$`).exec(line)).filter(Boolean)
    if (counters.length !== 1 || Number(counters[0][1]) !== expected) {
      throw new Error(`Installed native Fast verification requires exactly ${expected} ${name}, with no missing or duplicate TAP summaries.`)
    }
  }
  if (lines.filter(line => /^1\.\.1\s*$/.test(line)).length !== 1) {
    throw new Error('Installed native Fast verification must finish the one-test TAP plan.')
  }
  const diagnostics = []
  for (const line of lines) {
    const match = /^\s*#\s+(\{.*\})\s*$/.exec(line)
    if (!match) continue
    try {
      const value = JSON.parse(match[1])
      if (value && (Object.hasOwn(value, 'nativeExecuted') || Object.hasOwn(value, 'asar'))) diagnostics.push(value)
    } catch (_) { /* Other TAP comments cannot certify installed verification. */ }
  }
  const diagnostic = diagnostics[0]
  if (diagnostics.length !== 1 || diagnostic.nativeExecuted !== false
    || typeof diagnostic.asar !== 'string' || !/^[a-f0-9]{64}$/.test(diagnostic.sha256 || '')
    || !['ui-access', 'request-access', 'queue-default-access', 'queue-explicit-access']
      .every(name => diagnostic.matches?.[name] === 1)) {
    throw new Error('Installed native Fast verification requires one read-only ASAR diagnostic with all four gates and nativeExecuted=false.')
  }
  if ((packagePath && !samePackagePath(diagnostic.asar, packagePath, platform))
    || (sha256 && diagnostic.sha256 !== sha256)) {
    throw new Error('Installed native Fast test evidence does not match the selected package and SHA-256.')
  }
  return diagnostic
}

function verifyInstalledNativeFast({ env = process.env, platform = process.platform, run = spawnSync, files = fs, log = console.log } = {}) {
  const selectedEnv = { ...env }
  const packagePath = installedAsar({ env: selectedEnv, platform, run, files })
  const digest = () => crypto.createHash('sha256').update(files.readFileSync(packagePath)).digest('hex')
  const before = digest()
  log(`Verifying native Fast modules against installed Codex: ${packagePath}`)
  // Never reuse an old report or execute the native application factories.
  // The child only reads and prepares the current package's module graph.
  const result = run(process.execPath, ['--test', '--test-reporter=tap', nativeTest], {
    cwd: root,
    env: { ...selectedEnv, CODEX_NATIVE_APP_ASAR: packagePath },
    encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result?.stdout) log(result.stdout.trimEnd())
  if (result?.stderr) log(result.stderr.trimEnd())
  assertNativeFastPassed(result, { packagePath, sha256: before, platform })
  if (digest() !== before) {
    throw new Error('Codex updated during native Fast verification. Run verification again against the current installation.')
  }
  // Store updates can register a new package without changing the archive that
  // this run selected. Recheck registration instead of approving the old path.
  const explicitPackage = Boolean(selectedEnv.CODEX_NATIVE_APP_ASAR?.trim())
  if (!explicitPackage) {
    const currentPackage = installedAsar({ env: selectedEnv, platform, run, files })
    if (!samePackagePath(currentPackage, packagePath, platform)) {
      throw new Error('Codex installation changed during native Fast verification. Run verification again against the current registered installation.')
    }
  }
  const evidence = {
    installedNativeFastModulesVerified: true, nativeExecuted: false, packagePath, sha256: before,
    installationSource: explicitPackage ? 'explicit-package' : 'registered-package',
  }
  log(JSON.stringify(evidence))
  return evidence
}

module.exports = { assertNativeFastPassed, verifyInstalledNativeFast, nativeTestName }
if (require.main === module) {
  try { verifyInstalledNativeFast() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
