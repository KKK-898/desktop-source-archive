const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const nativeTest = 'scripts/codex-ultra-runtime.test.cjs'
const nativeTestNamePattern = '^installed native (?:(?:apikey|chatgpt) (?:reviewed query|model-response fallback) scope, QueryObserver and React rerenders retain scoped Ultra|aggregate full model IDs preserve Ultra selection and rerenders)$'
const nativeTestNames = ['reviewed query', 'model-response fallback'].flatMap(adaptation => ['apikey', 'chatgpt']
  .map(auth => `installed native ${auth} ${adaptation} scope, QueryObserver and React rerenders retain scoped Ultra`))
nativeTestNames.push('installed native aggregate full model IDs preserve Ultra selection and rerenders')

function installedAsar({ env = process.env, platform = process.platform, run = spawnSync, files = fs } = {}) {
  let candidate = env.CODEX_NATIVE_APP_ASAR?.trim()
  if (!candidate) {
    if (platform !== 'win32') {
      throw new Error('Set CODEX_NATIVE_APP_ASAR to the installed Codex app.asar. Release verification cannot skip the installed client.')
    }
    // Query the current user's registered package, not a cached extracted copy
    // or an arbitrary older directory left in WindowsApps after an update.
    const script = [
      '$ErrorActionPreference = "Stop"',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$packages = @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop | Sort-Object { [Version]$_.Version } -Descending)',
      '$paths = @($packages | ForEach-Object { Join-Path $_.InstallLocation "app\\resources\\app.asar" })',
      'ConvertTo-Json -InputObject $paths -Compress',
    ].join('\n')
    const discovery = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
    })
    if (discovery.error || discovery.status !== 0) {
      throw new Error(`Cannot discover installed Codex: ${discovery.error?.message || discovery.stderr?.trim() || 'PowerShell failed'}`)
    }
    let candidates
    try { candidates = JSON.parse(discovery.stdout.replace(/^\uFEFF/, '').trim()) }
    catch { throw new Error('Installed Codex discovery did not return a package list.') }
    candidate = Array.isArray(candidates) ? candidates[0] : undefined
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error('No registered Codex installation found. Install Codex or set CODEX_NATIVE_APP_ASAR to its actual app.asar; release verification cannot be skipped.')
    }
  }
  if (path.basename(candidate).toLowerCase() !== 'app.asar') {
    throw new Error('CODEX_NATIVE_APP_ASAR must point to the installed app.asar file.')
  }
  try {
    const resolved = files.realpathSync(candidate)
    const stat = files.statSync(resolved)
    if (!stat.isFile() || stat.size === 0) throw new Error('not a nonempty file')
    return resolved
  } catch (error) {
    throw new Error(`Cannot read installed Codex app.asar: ${error.message}`)
  }
}

function assertNativeTestPassed(result) {
  if (result.error || result.status !== 0) {
    throw new Error(`Installed Codex Ultra verification failed: ${result.error?.message || `test exit ${result.status}`}`)
  }
  const output = result.stdout || ''
  // An exit code of zero also means "all tests skipped". Require the installed
  // framework test itself, not only the synthetic fixtures, to have passed.
  const installedResults = output.split(/\r?\n/).filter(line => /^(?:not )?ok \d+ - installed native\b/.test(line))
  if (installedResults.length === 0 || installedResults.some(line => !/^ok /.test(line) || /#\s*(?:SKIP|TODO)\b/i.test(line))) {
    throw new Error('The installed native Ultra test did not run and pass. Skipped, missing, or TODO checks cannot approve a release.')
  }
  const names = installedResults.map(line => line.replace(/^ok \d+ - /, ''))
  const resultIds = installedResults.map(line => /^(?:not )?ok (\d+) - /.exec(line)[1])
  if (names.length !== nativeTestNames.length || new Set(resultIds).size !== nativeTestNames.length
      || nativeTestNames.some(name => names.filter(value => value === name).length !== 1)) {
    throw new Error('Installed Codex Ultra verification must pass all five native checks exactly once: each auth mode (apikey/chatgpt) and adaptation (reviewed query/model-response fallback), plus aggregate full model IDs.')
  }
  // Require one complete TAP summary for this fresh five-case invocation.
  // A skipped case, concatenated report, or synthetic-only success is not proof.
  for (const [kind, expected] of [['tests', nativeTestNames.length], ['pass', nativeTestNames.length], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]]) {
    const summaries = Array.from(output.matchAll(new RegExp('^# ' + kind + ' (\\d+)\\s*$', 'gm')))
    if (summaries.length !== 1 || Number(summaries[0][1]) !== expected) {
      throw new Error('Installed Codex Ultra verification contains incomplete, duplicate, failed, skipped, cancelled, or TODO test results.')
    }
  }
}

function verifyInstalledUltra({ env = process.env, platform = process.platform, run = spawnSync, files = fs, log = console.log } = {}) {
  const packagePath = installedAsar({ env, platform, run, files })
  const digest = () => crypto.createHash('sha256').update(files.readFileSync(packagePath)).digest('hex')
  const before = digest()
  log(`Verifying Ultra against installed Codex: ${packagePath}`)
  // Always run a fresh child with the selected installation. A prior release
  // report, extracted fixture, or successful synthetic run is never reused.
  const result = run(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=' + nativeTestNamePattern, nativeTest], {
    cwd: root,
    env: { ...env, CODEX_NATIVE_APP_ASAR: packagePath },
    encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 300000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.stdout) log(result.stdout.trimEnd())
  if (result.stderr) log(result.stderr.trimEnd())
  assertNativeTestPassed(result)
  if (digest() !== before) {
    throw new Error('Codex updated during Ultra verification. Run verification again against the current installation.')
  }
  // Store updates can register a new package while leaving the old archive
  // unchanged. Hashing only the selected file would incorrectly approve it.
  // Explicit paths remain deliberate cross-platform fixture selections.
  const explicitPackage = Boolean(env.CODEX_NATIVE_APP_ASAR?.trim())
  if (!explicitPackage) {
    const currentPackage = installedAsar({ env, platform, run, files })
    const samePath = platform === 'win32'
      ? currentPackage.toLowerCase() === packagePath.toLowerCase()
      : currentPackage === packagePath
    if (!samePath) {
      throw new Error('Codex installation changed during Ultra verification. Run verification again against the current registered installation.')
    }
  }
  const evidence = {
    installedUltraVerified: true, packagePath, sha256: before,
    installationSource: explicitPackage ? 'explicit-package' : 'registered-package',
  }
  log(JSON.stringify(evidence))
  return evidence
}

module.exports = { installedAsar, assertNativeTestPassed, verifyInstalledUltra }
if (require.main === module) {
  try { verifyInstalledUltra() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
