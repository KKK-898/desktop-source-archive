import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  buildMirrorManifest,
  canonicalServerDirectory,
  compareVersions,
  validateReleaseConfig,
} from './release-tooling.mjs'

const baseConfig = {
  bootstrapConfigUrls: ['https://oss-one.example/config.json', 'https://oss-two.example/config.json'],
  buildRepo: 'owner/build',
  buildBranch: 'master',
  sourceBranch: 'main',
  sshHosts: {
    primary: {
      host: '203.0.113.10',
      port: 22,
      user: 'root',
      identityFile: '%USERPROFILE%/.ssh/release.pem',
    },
  },
  updateMirrors: [{
    id: 'primary',
    sshHost: 'primary',
    publicBaseUrl: 'https://api.example.com/gaogeaii/updates/',
    remoteRoot: '/var/www/updates/',
  }],
}

test('validates multi-OSS config and normalizes trailing slashes', () => {
  const result = validateReleaseConfig(baseConfig)
  assert.equal(result.bootstrapConfigUrls.length, 2)
  assert.equal(result.updateMirrors[0].publicBaseUrl, 'https://api.example.com/gaogeaii/updates')
  assert.equal(result.updateMirrors[0].remoteRoot, '/var/www/updates')
  assert.equal(result.sshHosts.primary.identityFile, '%USERPROFILE%/.ssh/release.pem')
})

test('rejects secrets and unknown SSH hosts', () => {
  assert.throws(() => validateReleaseConfig({ ...baseConfig, serverPassword: 'bad' }), /must not contain/i)
  assert.throws(() => validateReleaseConfig({
    ...baseConfig,
    updateMirrors: [{ ...baseConfig.updateMirrors[0], sshHost: 'missing' }],
  }), /Unknown sshHost/)
  assert.throws(() => validateReleaseConfig({
    ...baseConfig,
    sshHosts: {
      primary: { ...baseConfig.sshHosts.primary, identityFile: "bad\npath" },
    },
  }), /invalid characters/)
})

test('canonical directory ignores timestamps and server ordering', () => {
  const first = {
    version: 3,
    updatedAt: 'one',
    defaultServerId: 'a',
    servers: [
      { id: 'b', name: 'B', rootDomain: 'b.example', overrides: { updateBaseUrl: 'https://b.example/u' } },
      { id: 'a', name: 'A', rootDomain: 'a.example' },
    ],
  }
  const second = { ...first, updatedAt: 'two', servers: [...first.servers].reverse() }
  assert.equal(canonicalServerDirectory(first), canonicalServerDirectory(second))
})

test('builds same-host mirror manifests without changing signatures', () => {
  const result = buildMirrorManifest({
    version: '1.4.2',
    minimumVersion: '0.0.0',
    notes: 'test',
    platforms: {
      'windows-x86_64': {
        signature: 'signed',
        url: 'https://old.example/win/Gaoge-Free-latest-windows-x64-setup.exe',
      },
    },
  }, 'https://api.gaogeaii.cc/gaogeaii/updates', '1.4.2')
  assert.equal(result.minimumVersion, '1.4.2')
  assert.equal(result.platforms['windows-x86_64'].signature, 'signed')
  assert.equal(
    result.platforms['windows-x86_64'].url,
    'https://api.gaogeaii.cc/gaogeaii/updates/win/Gaoge-Free-latest-windows-x64-setup.exe',
  )
})

test('rejects a minimum version newer than the release', () => {
  assert.equal(compareVersions('1.4.2', '1.4.1') > 0, true)
  assert.throws(() => buildMirrorManifest({
    version: '1.4.2',
    platforms: { 'linux-x86_64': { signature: 's', url: 'https://old/linux/app.AppImage' } },
  }, 'https://api.example/updates', '1.4.3'), /cannot be newer/)
})


// Execute only the real visibility functions and parameter block, extracted by
// PowerShell's parser. Never dot-source the release entry point: all gh calls
// below are local stubs and no repository, workflow or server can be changed.
function releaseVisibilityScenario(scenario) {
  const productionScript = fileURLToPath(new URL('./one-click-release.ps1', import.meta.url))
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:GAOGE_RELEASE_SCRIPT_UNDER_TEST, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Release script must parse without errors.' }
$names = @('Get-BuildRepoVisibility', 'Set-BuildRepoVisibility', 'Initialize-BuildRepoVisibility', 'Restore-BuildRepoPrivacy')
$definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) | Where-Object { $names -contains $_.Name })
if ($definitions.Count -ne $names.Count) { throw 'Missing production visibility guard.' }
foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
$script:BuildRepo = 'synthetic/no-network'
$script:BuildRepoTouched = $false
$script:KeepBuildPrivate = $true
$script:remoteVisibility = 'PRIVATE'
$script:ignoreEdit = $false
$script:readFailure = $false
$script:editFailure = $false
$script:edits = [System.Collections.Generic.List[string]]::new()
$script:messages = [System.Collections.Generic.List[string]]::new()
$script:queries = 0
function Write-Info([string]$message) { $script:messages.Add($message) }
function Invoke-Captured {
  param([string]$FilePath, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
  if ($FilePath -ne 'gh' -or $Arguments[0] -ne 'repo' -or $Arguments[1] -ne 'view') { throw 'Unexpected external command.' }
  $script:queries += 1
  if ($script:readFailure) { throw 'Synthetic GitHub status unavailable.' }
  return $script:remoteVisibility
}
function Invoke-Checked {
  param([string]$FilePath, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
  if ($FilePath -ne 'gh' -or $Arguments[0] -ne 'repo' -or $Arguments[1] -ne 'edit') { throw 'Unexpected external mutation.' }
  $index = [Array]::IndexOf($Arguments, '--visibility')
  if ($index -lt 0) { throw 'Missing visibility argument.' }
  $next = $Arguments[$index + 1]
  $script:edits.Add($next)
  if ($script:editFailure) { throw 'Synthetic GitHub visibility edit denied.' }
  if (-not $script:ignoreEdit) { $script:remoteVisibility = $next.ToUpperInvariant() }
}
` + scenario
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  const result = spawnSync(shell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: {
      ...process.env, GAOGE_RELEASE_SCRIPT_UNDER_TEST: productionScript,
      POWERSHELL_UPDATECHECK: 'Off', POWERSHELL_TELEMETRY_OPTOUT: '1',
    },
  })
  assert.equal(result.error, undefined, `PowerShell visibility test could not run: ${result.error?.message}`)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

test('release parameter binding preserves defaults and accepts private builds with an existing minimum version', () => {
  const result = releaseVisibilityScenario(String.raw`
$probe = [scriptblock]::Create($ast.ParamBlock.Extent.Text + [Environment]::NewLine + '[pscustomobject]@{version=$Version;minimum=$MinimumVersion;privateBuild=[bool]$KeepBuildPrivate}')
$default = & $probe -Version '1.7.0'
$private = & $probe -Version '1.7.0' -MinimumVersion '1.6.3' -KeepBuildPrivate
@{default=$default;private=$private} | ConvertTo-Json -Compress
`)
  assert.deepEqual(result.default, { version: '1.7.0', minimum: '0.0.0', privateBuild: true })
  assert.deepEqual(result.private, { version: '1.7.0', minimum: '1.6.3', privateBuild: true })
})

test('private build and final cleanup confirm an already-private repository without visibility edits', () => {
  const result = releaseVisibilityScenario(String.raw`
$script:KeepBuildPrivate = $true
Initialize-BuildRepoVisibility
Restore-BuildRepoPrivacy
@{visibility=$script:remoteVisibility;edits=@($script:edits);queries=$script:queries;messages=@($script:messages)} | ConvertTo-Json -Compress
`)
  assert.equal(result.visibility, 'PRIVATE')
  assert.deepEqual(result.edits, [])
  assert.ok(result.queries >= 2, 'both preparation and cleanup must observe GitHub visibility')
  assert.equal(result.messages.length, 2)
  assert.ok(result.messages.every(message => message.includes('private')))
})

test('private mode closes an existing public repository and rejects every public fallback before mutation', () => {
  const result = releaseVisibilityScenario(String.raw`
$script:KeepBuildPrivate = $true
$script:remoteVisibility = 'PUBLIC'
Initialize-BuildRepoVisibility
$failure = ''
try { Set-BuildRepoVisibility 'public' } catch { $failure = $_.Exception.Message }
Restore-BuildRepoPrivacy
@{visibility=$script:remoteVisibility;edits=@($script:edits);queries=$script:queries;failure=$failure} | ConvertTo-Json -Compress
`)
  assert.equal(result.visibility, 'PRIVATE')
  assert.deepEqual(result.edits, ['private'])
  assert.ok(result.queries >= 3, 'the private edit and final cleanup must be read back')
  assert.match(result.failure, /KeepBuildPrivate.*forbids.*public/i)
})

test('default release remains private and disabling privacy fails before mutation', () => {
  const result = releaseVisibilityScenario(String.raw`
Initialize-BuildRepoVisibility
$defaultVisibility = $script:remoteVisibility
$script:KeepBuildPrivate = $false
$failure = ''; $publicFailure = ''
try { Initialize-BuildRepoVisibility } catch { $failure = $_.Exception.Message }
try { Set-BuildRepoVisibility 'public' } catch { $publicFailure = $_.Exception.Message }
Restore-BuildRepoPrivacy
@{defaultVisibility=$defaultVisibility;finalVisibility=$script:remoteVisibility;edits=@($script:edits);failure=$failure;publicFailure=$publicFailure} | ConvertTo-Json -Compress
`)
  assert.equal(result.defaultVisibility, 'PRIVATE')
  assert.equal(result.finalVisibility, 'PRIVATE')
  assert.deepEqual(result.edits, [])
  assert.match(result.failure, /KeepBuildPrivate cannot be disabled/i)
  assert.match(result.publicFailure, /forbids making.*public/i)
})

test('an acknowledged edit without a private readback cannot authorize a build or report cleanup success', () => {
  const result = releaseVisibilityScenario(String.raw`
$script:KeepBuildPrivate = $true
$script:remoteVisibility = 'PUBLIC'
$script:ignoreEdit = $true
$prepareFailure = ''; $cleanupFailure = ''
try { Initialize-BuildRepoVisibility } catch { $prepareFailure = $_.Exception.Message }
try { Restore-BuildRepoPrivacy } catch { $cleanupFailure = $_.Exception.Message }
@{visibility=$script:remoteVisibility;edits=@($script:edits);messages=@($script:messages);prepareFailure=$prepareFailure;cleanupFailure=$cleanupFailure} | ConvertTo-Json -Compress
`)
  assert.equal(result.visibility, 'PUBLIC')
  assert.deepEqual(result.edits, ['private', 'private'])
  assert.deepEqual(result.messages, [])
  assert.match(result.prepareFailure, /not confirmed as private/i)
  assert.match(result.cleanupFailure, /not confirmed as private/i)
})

test('unavailable visibility or a denied privacy change is an error instead of successful cleanup', () => {
  const result = releaseVisibilityScenario(String.raw`
$script:KeepBuildPrivate = $true
$script:BuildRepoTouched = $true
$script:readFailure = $true
$readErrorMessage = ''; $editErrorMessage = ''
try { Restore-BuildRepoPrivacy } catch { $readErrorMessage = $_.Exception.Message }
$script:readFailure = $false
$script:remoteVisibility = 'PUBLIC'
$script:editFailure = $true
try { Restore-BuildRepoPrivacy } catch { $editErrorMessage = $_.Exception.Message }
@{messages=@($script:messages);edits=@($script:edits);readFailure=$readErrorMessage;editFailure=$editErrorMessage} | ConvertTo-Json -Compress
`)
  assert.deepEqual(result.messages, [])
  assert.deepEqual(result.edits, ['private'])
  assert.match(result.readFailure, /status unavailable/i)
  assert.match(result.editFailure, /edit denied/i)
})

test('the real failure trap preserves the release error and surfaces unconfirmed privacy while cleaning staging', () => {
  const result = releaseVisibilityScenario(String.raw`
$script:KeepBuildPrivate = $true
$script:BuildRepoTouched = $true
$script:readFailure = $true
$script:PromotedGroups = @()
$script:cleaned = $false
function Cleanup-RemoteGroups { $script:cleaned = $true }
$traps = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.TrapStatementAst] }, $false))
if ($traps.Count -ne 1) { throw 'Expected the production release failure trap.' }
$failedRelease = [scriptblock]::Create($traps[0].Extent.Text + [Environment]::NewLine + "throw 'Synthetic workflow failed.'")
$failure = ''
try { & $failedRelease } catch { $failure = $_.Exception.Message }
@{failure=$failure;cleaned=$script:cleaned;edits=@($script:edits)} | ConvertTo-Json -Compress
`)
  assert.equal(result.cleaned, true)
  assert.deepEqual(result.edits, [])
  assert.match(result.failure, /Synthetic workflow failed/)
  assert.match(result.failure, /privacy could not be confirmed.*status unavailable/i)
})
