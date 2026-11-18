const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')

function assertApiModePassed(result, format = 'esm', projectContract = 'renderer-owner') {
  const output = result.stdout || ''
  if (result.error || result.status !== 0) {
    const names = [...output.matchAll(/^not ok \d+ - ([^\r\n]+)/gm)].map(match => match[1].trim())
    const files = names.filter(name => /(?:^|[\\/])[^\\/]+\.test\.cjs$/.test(name))
    const named = names.filter(name => !files.includes(name))
    const details = []
    if (files.length) details.push(`${files.length} file-level failure(s): ${files.map(name => name.split(/[\\/]/).pop()).join(', ')}`)
    if (named.length) details.push(`${named.length} named test failure(s): ${named.slice(0, 3).join('; ')}${named.length > 3 ? `; and ${named.length - 3} more` : ''}`)
    const reason = result.error?.message || result.signal || `exit ${result.status}`
    throw new Error(`Installed API mode verification failed (${reason}). ${[...details, 'See the native test output above; this check does not call the relay.'].join('. ')}`)
  }
  const required = format === 'webpack' ? ['installed webpack native settings use API Coding policy without granting account access', 'installed webpack renderer bindings use native state and setter without initializing modules', 'installed webpack native Coding selects Codex sidebar without rewriting home composer preference',
    'real native RPC proxies restore API completion and Coding without assigning methods',
    'native scoped API hydration preserves only its reviewed shared completion whitelist',
    'native API hydration filters private atoms without relying on owner-state cleanup',
    'installed webpack mode events recognize only the committed native product selector',
    'installed webpack API mode captures native selector and portal events until account switch or disposal',
    'native direct welcome redirects home when shared completion is restored despite pending=true',
    'native first API onboarding is preserved and genuine completion still persists without a principal',
    'installed native onboarding restores a verified API completion receipt after an empty host hydration',
    'installed native onboarding keeps a fresh API identity on welcome without a receipt',
    'installed native project chain and final sidebar preserve projects and complete legacy memberships in pure API mode',
    'installed native project sidebar survives repeated API official API transitions without changing membership or account permissions',
    'installed native first-pass migration matches all Rust-restored local memberships beyond the pending queue',
    'installed native completed-read checkpoint restricts writes to pending memberships',
    'installed native completed migration never replays stale legacy assignments',
    'real main owner selection clears desktop catalog while app-server projects survive',
    'real native main services restore canonical API projects and memberships then CAS persist',
    'API rename removal and explicit projectless edits persist without replaying an older GET',
    'deleting every local project remains a persisted empty catalog across repeated polling',
    'native explicit assignment and projectless conflicts stay unverified and are not overwritten',
    'newer GET revisions cannot silently authorize overwriting a concurrent snapshot',
    'native owner change blocks hydration before any catalog write',
    'installed native project guard checks the active owner before accessing project data',
    'installed API project guard rejects legacy snapshots on the native shared store',
    'real native account switch closes old RPC before selecting another owner',
    'same API renderer stops on a different home',
    'full native message-port RPC restores catalog and membership without replacing service methods',
    'confirmed API snapshot conflicts with startup database membership remain visible and unmodified',
    'same-home settings revision renews authorization without replaying a deleted API project',
    "verified native checkpoint publishes one non-shared key only after successful CAS",
    "incomplete native hydration and rejected CAS never publish a checkpoint",
    "malformed CAS checkpoint receipts cannot authorize native exit capture",
    "delayed native checkpoint IPC retries the receipt without another snapshot commit",
    "subsequent CAS updates checkpoint revision and nonce without exposing the receipt in status",
    "native null-owner reset removes checkpoint even when the previous owner was already null",
    "disposing runtime preserves the verified native checkpoint for final exit capture",
    "home runtime grant and account changes during CAS prevent checkpoint publication",
    "checkpoint publication requires host hydration a valid receipt and current identity",
    "installed webpack graceful quit requires the current API grant and defers the native message",
    "installed webpack graceful quit rejects stale disabled unsupported and official sessions",
    "installed webpack queued graceful quit rechecks grant identity freshness and disposal before sending",
    "installed webpack graceful quit uses live API identity without restarting project polling",
    "first native hydration merges projects created before the bridge without dropping saved projects",
    "first native hydration keeps live same-ID edits and unions only valid catalog roots and labels",
    "a fresh guard honors matched native checkpoint deletions and membership changes",
    "a mismatched native checkpoint waits for a fresh snapshot before treating live deletions as authoritative",
    "foreign or malformed native checkpoints never authorize initial snapshot replay"] : ['installed native API Work fails before normalization', 'installed renderer bindings use native state'];
  // The startup-clear/restore checkpoint is a legacy native contract, not a
  // product requirement for modern hosts that retain the shared catalog.
  // Keep its 26 assertions in the legacy suite; require positive modern native
  // behavior checks for the current installed host instead of marking skips.
  const legacy = new Set([...fs.readFileSync(path.join(__dirname, 'codex-api-project-state.test.cjs'), 'utf8')
    .matchAll(/^run\('([^']+)'/gm)].map(match => match[1]));
  const modern = [...fs.readFileSync(path.join(__dirname, 'codex-api-project-shared-state.test.cjs'), 'utf8')
    .matchAll(/^run\('([^']+)'/gm)].map(match => match[1]);
  if (format === 'webpack' && !['renderer-owner', 'content-owner'].includes(projectContract)) {
    throw new Error('Unreviewed native project contract: ' + projectContract);
  }
  if (format === 'webpack' && projectContract === 'content-owner' && (legacy.size !== 26 || modern.length < 13)) {
    throw new Error('Native project contract coverage is incomplete');
  }
  const contractRequired = format === 'webpack' && projectContract === 'content-owner'
    ? [...required.filter(name => !legacy.has(name)), ...modern] : required;
  for (const name of contractRequired) {
    if (!output.split(/\r?\n/).some(line => /^ok \d+ - /.test(line)
        && line.replace(/^ok \d+ - /, '').trim() === name && !/#\s*(?:SKIP|TODO)\b/i.test(line))) {
      throw new Error(`Required native API mode check did not run: ${name}`)
    }
  }
  if (!/^# fail 0\s*$/m.test(output) || !/^# skipped 0\s*$/m.test(output) || /^# (?:cancelled|todo) [1-9]\d*\s*$/m.test(output)) {
    throw new Error('API mode verification contains failed or skipped checks.')
  }
}

function verifyInstalledApiMode({ env = process.env, run = spawnSync, files = fs, log = console.log } = {}) {
  const packagePath = installedAsar({ env, run, files })
  const digest = () => crypto.createHash('sha256').update(files.readFileSync(packagePath)).digest('hex')
  const before = digest()
  const format = require('@electron/asar').listPackage(packagePath).some(name => /app-initial-[^\\/]+\.js$/.test(name)) ? 'esm' : 'webpack'
  const packageVersion = JSON.parse(require('@electron/asar').extractFile(packagePath, 'package.json')).version
  const projectContract = packageVersion === '26.1111.21308' ? 'content-owner' : 'renderer-owner'
  const tests = format === 'webpack' ? [
    'scripts/codex-api-mode-webpack.test.cjs', 'scripts/codex-api-onboarding.test.cjs',
    'scripts/codex-api-onboarding-host-receipt.test.cjs', 'scripts/codex-projects-native.test.cjs',
    'scripts/codex-project-migration-native.test.cjs', 'scripts/codex-api-project-state.test.cjs',
    'scripts/codex-api-project-owner-key.test.cjs', 'scripts/codex-api-project-scope.test.cjs',
  ] : ['scripts/codex-api-mode-runtime.test.cjs', 'scripts/codex-api-mode-bindings.test.cjs']
  log(`Verifying API coding mode against installed Codex: ${packagePath}`)
  const result = run(process.execPath, ['--test', '--test-reporter=tap',
    ...tests], {
    cwd: path.resolve(__dirname, '..'), env: { ...env, CODEX_API_MODE_ASAR: packagePath, CODEX_NATIVE_APP_ASAR: packagePath },
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.stdout) log(result.stdout.trimEnd())
  if (result.stderr) log(result.stderr.trimEnd())
  assertApiModePassed(result, format, projectContract)
  if (digest() !== before) throw new Error('Codex updated during API mode verification; rerun against the current installation.')
  const evidence = { installedApiModeVerified: true, format, packagePath, packageVersion, projectContract, sha256: before,
    coverage: { nativeModeContract: true, nativeSharedOnboarding: format === 'webpack', nativeProjectSidebar: format === 'webpack', nativeProjectMigration: format === 'webpack', nativeProjectMainState: format === 'webpack', nativeProjectScopeGuard: format === 'webpack', nativeProjectExitCheckpoint: format === 'webpack' && projectContract === 'renderer-owner', nativeGracefulExit: format === 'webpack', nativeInitialProjectMerge: format === 'webpack' && projectContract === 'renderer-owner', nativeSharedProjectPersistence: format === 'webpack' && projectContract === 'content-owner', legacyRestoreAssertionsExecuted: format === 'webpack' && projectContract === 'renderer-owner', liveUiRoundTrip: false } }
  log(JSON.stringify(evidence))
  return evidence
}

module.exports = { assertApiModePassed, verifyInstalledApiMode }
if (require.main === module) {
  try { verifyInstalledApiMode() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
