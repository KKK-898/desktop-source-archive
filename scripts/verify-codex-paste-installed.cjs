const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')

const root = path.resolve(__dirname, '..')
const nativeTest = 'scripts/codex-paste-runtime.test.cjs'
const nativeTestName = 'registered Codex ProseMirror preserves selection, paragraphs, marks and undo in an isolated browser'

function samePackagePath(left, right, platform) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = path.resolve(left), b = path.resolve(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function assertPastePassed(result, { packagePath, platform = process.platform } = {}) {
  if (!result || result.error || result.status !== 0) {
    throw new Error(`Installed Codex paste verification failed: ${result?.error?.message || `test exit ${result?.status}`}`)
  }
  if (typeof result.stdout !== 'string') throw new Error('Installed paste verification did not return a TAP report.')
  const lines = result.stdout.split(/\r?\n/)
  const results = lines.map(line => /^(\s*)(not )?ok (\d+) - (.+)$/.exec(line)).filter(Boolean)
  const topLevel = results.filter(match => match[1] === '')
  const nativeResults = topLevel.filter(match => match[4] === nativeTestName)
  if (nativeResults.length !== 1 || results.some(match => match[2] || /#\s*(?:SKIP|TODO)\b/i.test(match[4]))
    || lines.some(line => /^\s*Bail out!/i.test(line))) {
    throw new Error('Installed paste verification must run and pass the native browser test exactly once, without any failed, skipped, TODO, or cancelled checks.')
  }
  // Node's total includes nested tests, while its unindented plan counts only
  // top-level tests. Validate both so truncated or concatenated TAP cannot pass.
  const plans = lines.map(line => /^1\.\.(\d+)\s*$/.exec(line)).filter(Boolean)
  if (lines.filter(line => /^TAP version 13\s*$/.test(line)).length !== 1
    || plans.length !== 1 || Number(plans[0][1]) !== topLevel.length
    || topLevel.some((match, index) => Number(match[3]) !== index + 1)) {
    throw new Error('Installed paste verification requires one complete sequential TAP plan.')
  }
  for (const [name, expected] of Object.entries({ tests: results.length, pass: results.length, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    const counters = lines.map(line => new RegExp(`^# ${name} (\\d+)\\s*$`).exec(line)).filter(Boolean)
    if (counters.length !== 1 || Number(counters[0][1]) !== expected) {
      throw new Error(`Installed paste verification requires exactly ${expected} ${name}, with no missing or duplicate TAP summaries.`)
    }
  }
  const diagnostics = []
  for (const line of lines) {
    const match = /^\s*#\s+(\{.*\})\s*$/.exec(line)
    if (!match) continue
    try {
      const value = JSON.parse(match[1])
      if (value && (Object.hasOwn(value, 'nativeExecuted') || Object.hasOwn(value, 'asar'))) diagnostics.push(value)
    } catch (_) { /* Other TAP comments do not certify installed verification. */ }
  }
  const diagnostic = diagnostics[0]
  if (diagnostics.length !== 1 || diagnostic.nativeExecuted !== true
    || typeof diagnostic.asar !== 'string' || !diagnostic.asar.trim()
    || !Array.isArray(diagnostic.modules) || diagnostic.modules.length === 0
    || diagnostic.modules.some(name => typeof name !== 'string' || !name.trim())
    || new Set(diagnostic.modules).size !== diagnostic.modules.length
    || !['composer', 'paste', 'viewDesc'].every(name => diagnostic.anchors?.[name] === true)
    || (packagePath && !samePackagePath(diagnostic.asar, packagePath, platform))) {
    throw new Error('Installed paste verification requires one native browser diagnostic for the selected ASAR, reviewed modules and all composer/paste anchors.')
  }
  return diagnostic
}

function verifyInstalledPaste({ env = process.env, platform = process.platform, run = spawnSync, files = fs, log = console.log } = {}) {
  const selectedEnv = { ...env }
  const packagePath = installedAsar({ env: selectedEnv, platform, run, files })
  const digest = () => crypto.createHash('sha256').update(files.readFileSync(packagePath)).digest('hex')
  const before = digest()
  log(`Verifying native paste behavior against installed Codex: ${packagePath}`)
  // Execute only the isolated regression harness. It extracts reviewed editor
  // modules; it never starts Codex, reads credentials, or accesses real clipboard.
  const result = run(process.execPath, ['--test', '--test-reporter=tap', nativeTest], {
    cwd: root,
    env: { ...selectedEnv, CODEX_NATIVE_APP_ASAR: packagePath },
    encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result?.stdout) log(result.stdout.trimEnd())
  if (result?.stderr) log(result.stderr.trimEnd())
  assertPastePassed(result, { packagePath, platform })
  if (digest() !== before) throw new Error('Codex updated during paste verification. Run verification again against the current installation.')
  const explicitPackage = Boolean(selectedEnv.CODEX_NATIVE_APP_ASAR?.trim())
  if (!explicitPackage) {
    const currentPackage = installedAsar({ env: selectedEnv, platform, run, files })
    if (!samePackagePath(currentPackage, packagePath, platform)) {
      throw new Error('Codex installation changed during paste verification. Run verification again against the current registered installation.')
    }
  }
  const evidence = {
    installedPasteVerified: true, nativeExecuted: true, packagePath, sha256: before,
    installationSource: explicitPackage ? 'explicit-package' : 'registered-package',
    coverage: { nativeClipboard: true, isolatedBrowser: true, liveWordUiRoundTrip: false },
  }
  log(JSON.stringify(evidence))
  return evidence
}

module.exports = { assertPastePassed, verifyInstalledPaste, nativeTestName }
if (require.main === module) {
  try { verifyInstalledPaste() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
