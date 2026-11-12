import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const productionScript = fileURLToPath(new URL('./one-click-release.ps1', import.meta.url))

// Load only the named production functions through PowerShell's AST. Never
// dot-source or execute the release entry point. Every external call and every
// filesystem mutation is intercepted; the command-surface allowlist also makes
// newly introduced execution paths fail before any production function runs.
function releaseGuardScenario(scenario) {
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:GAOGE_RELEASE_SCRIPT_UNDER_TEST, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Release script must parse without errors.' }
$names = @('Assert-ReleaseTag', 'Assert-PublicSourceRelease', 'Confirm-PublicSourceRelease', 'Assert-BuildMatchesPublicSource', 'Export-BuildSnapshot', 'Find-Or-RunWorkflow')
$definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) | Where-Object { $names -contains $_.Name })
if ($definitions.Count -ne $names.Count) { throw 'Missing production corresponding-source guard.' }
$allowedCommands = @('Write-Step', 'Write-Info', 'Invoke-Captured', 'ConvertFrom-Json', 'Join-Path', 'Assert-SafeTempPath', 'Confirm-PublicSourceRelease', 'Test-Path', 'New-Item', 'Out-Null', 'Get-ChildItem', 'ForEach-Object', 'Copy-Item', 'Where-Object', 'Push-Location', 'Invoke-Checked', 'Pop-Location', 'Select-Object', 'Start-Sleep')
$allowedMethods = @('GetFullPath', 'IsNullOrWhiteSpace', 'Trim', 'NewGuid', 'ToString', 'Escape', 'IsMatch')
foreach ($definition in $definitions) {
  foreach ($command in @($definition.Body.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))) {
    $commandName = $command.GetCommandName()
    if ($null -eq $commandName) {
      if ($command.InvocationOperator -ne 'Ampersand' -or $command.CommandElements[0].Extent.Text -ne '(Join-Path $script:Root "scripts/export-public-source.ps1")') { throw 'Unexpected dynamic execution in release guard.' }
    } elseif ($allowedCommands -notcontains $commandName) {
      throw "Unstubbed production command: $commandName"
    }
  }
  foreach ($method in @($definition.Body.FindAll({ param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true))) {
    if ($allowedMethods -notcontains $method.Member.Extent.Text) { throw "Unstubbed production method: $($method.Extent.Text)" }
  }
  . ([scriptblock]::Create($definition.Extent.Text))
}
$script:Root = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($env:GAOGE_RELEASE_SCRIPT_UNDER_TEST))
$script:Version = '1.7.1'
$script:ReleaseTag = 'v1.7.1'
$script:PublicSourceRepository = 'synthetic/public-source'
$script:BuildRepo = 'synthetic/private-build'
if ([string]::IsNullOrWhiteSpace($env:TEMP)) { $env:TEMP = [IO.Path]::GetTempPath() }
$script:PublicSourceDirectory = ''
$script:PublicSourceVerification = $null
$script:PackageVersion = $Version
$script:ExportVersion = $Version
$script:ExportReleaseReady = $true
$script:ExportDirectoryMismatch = $false
$script:VerificationResult = [pscustomobject]@{verified=$true;version=$Version;tag=$ReleaseTag;publicCommit=('a' * 40);sourceCommit=('c' * 40)}
$script:PublicTree = 'd' * 40
$script:BuildTree = 'd' * 40
$script:TagCommit = 'c' * 40
$script:BuildCommit = 'e' * 40
$script:WorkRootExists = $false
$script:ExistingWorkRoot = ''
$script:SnapshotDirectory = ''
$script:WorkflowRuns = @()
$script:WorkflowDispatched = $false
$script:WorkflowBranchOverride = ''
$script:WorkflowCompletionBranchOverride = ''
$script:Events = [System.Collections.Generic.List[string]]::new()
$script:Queries = [System.Collections.Generic.List[object]]::new()
$script:Mutations = [System.Collections.Generic.List[object]]::new()
$script:VerifierPath = Microsoft.PowerShell.Management\Join-Path $script:Root 'scripts/verify-public-source.mjs'
function Write-Step([string]$Message) {}
function Write-Info([string]$Message) {}
function Join-Path {
  param([string]$Path, [string]$ChildPath)
  # The sole direct script execution is redirected to an in-memory function.
  if ($ChildPath -eq 'scripts/export-public-source.ps1') { return '__Test-ExportPublicSource' }
  return Microsoft.PowerShell.Management\Join-Path $Path $ChildPath
}
function Assert-SafeTempPath([string]$Path) {
  $root = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not [IO.Path]::GetFullPath($Path).StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected path outside synthetic temporary root.' }
}
function __Test-ExportPublicSource {
  param([string]$Ref, [string]$OutputDirectory)
  $script:Events.Add('export')
  $returnedDirectory = if ($script:ExportDirectoryMismatch) { Join-Path $env:TEMP 'unexpected-source-directory' } else { $OutputDirectory }
  @{ReleaseReady=$script:ExportReleaseReady;Version=$script:ExportVersion;SourceDirectory=$returnedDirectory} | ConvertTo-Json -Compress
}
function Invoke-Captured {
  param([string]$FilePath, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
  $script:Queries.Add([pscustomobject]@{file=$FilePath;arguments=@($Arguments)})
  if ($FilePath -eq 'git' -and $Arguments[0] -eq 'show') {
    $script:Events.Add('git:show')
    return (@{version=$script:PackageVersion} | ConvertTo-Json -Compress)
  }
  if ($FilePath -eq 'git' -and $Arguments[0] -eq 'rev-list') { $script:Events.Add('git:rev-list'); return $script:TagCommit }
  if ($FilePath -eq 'git' -and $Arguments[0] -eq 'rev-parse') { $script:Events.Add('git:rev-parse'); return $script:BuildCommit }
  if ($FilePath -eq 'node' -and $Arguments[0] -eq $script:VerifierPath) {
    $script:Events.Add('verify')
    return ($script:VerificationResult | ConvertTo-Json -Compress)
  }
  if ($FilePath -eq 'gh' -and $Arguments[0] -eq 'run' -and $Arguments[1] -eq 'list') {
    $script:Events.Add('gh:run-list')
    if (-not $script:WorkflowDispatched) { return (ConvertTo-Json -InputObject @($script:WorkflowRuns) -Compress) }
    $branch = if ($script:WorkflowBranchOverride) { $script:WorkflowBranchOverride } else { $ReleaseTag }
    return (ConvertTo-Json -InputObject @([pscustomobject]@{databaseId=123;headSha=$script:BuildCommit;headBranch=$branch;status='in_progress';conclusion='';url='https://example.invalid/build/123'}) -Compress)
  }
  if ($FilePath -eq 'gh' -and $Arguments[0] -eq 'run' -and $Arguments[1] -eq 'view') {
    $script:Events.Add('gh:run-view')
    $branch = if ($script:WorkflowCompletionBranchOverride) { $script:WorkflowCompletionBranchOverride } else { $ReleaseTag }
    return (@{databaseId=123;headSha=$script:BuildCommit;headBranch=$branch;status='completed';conclusion='success';url='https://example.invalid/build/123'} | ConvertTo-Json -Compress)
  }
  if ($FilePath -eq 'gh' -and $Arguments.Count -eq 4 -and $Arguments[0] -eq 'api' -and $Arguments[2] -eq '--jq' -and $Arguments[3] -eq '.tree.sha') {
    if ($Arguments[1] -eq "repos/$PublicSourceRepository/git/commits/$($script:VerificationResult.publicCommit)") { $script:Events.Add('gh:public-tree'); return $script:PublicTree }
    if ($Arguments[1] -eq "repos/$($script:BuildRepo)/git/commits/$($script:BuildCommit)") { $script:Events.Add('gh:build-tree'); return $script:BuildTree }
  }
  throw "Unexpected external command: $FilePath $($Arguments -join ' ')"
}
function Invoke-Checked {
  param([string]$FilePath, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
  if ($FilePath -eq 'gh' -and (($Arguments[0] -eq 'workflow' -and $Arguments[1] -eq 'run') -or ($Arguments[0] -eq 'run' -and $Arguments[1] -eq 'watch'))) {
    $script:Mutations.Add([pscustomobject]@{operation='gh';arguments=@($Arguments)})
    $script:Events.Add("mutation:gh:$($Arguments[0])")
    if ($Arguments[0] -eq 'workflow') { $script:WorkflowDispatched = $true }
    return
  }
  if ($FilePath -ne 'git' -or $Arguments[0] -notin @('init', 'config', 'checkout', 'add', 'commit', 'remote', 'push', 'tag')) { throw 'Unexpected external mutation.' }
  $script:Events.Add("mutation:git:$($Arguments[0])")
  $script:Mutations.Add([pscustomobject]@{operation='git';arguments=@($Arguments)})
}
function Start-Sleep { param([int]$Seconds) $script:Events.Add('wait:stubbed') }
function Test-Path {
  param([string]$LiteralPath)
  $script:Events.Add('filesystem:exists')
  $script:Queries.Add([pscustomobject]@{file='Test-Path';arguments=@($LiteralPath)})
  return ($script:WorkRootExists -or $LiteralPath -eq $script:ExistingWorkRoot)
}
function New-Item {
  param([string]$ItemType, [string]$Path)
  $script:SnapshotDirectory = $Path
  $script:Events.Add('mutation:new')
  $script:Mutations.Add([pscustomobject]@{operation='new';path=$Path})
}
function Get-ChildItem {
  param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)
  if (-not $Recurse -and $LiteralPath -eq $script:PublicSourceDirectory) {
    return [pscustomobject]@{Name='package.json';FullName=(Join-Path $LiteralPath 'package.json')}
  }
  if ($Recurse -and $LiteralPath -eq $script:SnapshotDirectory) { return }
  throw 'Unexpected filesystem enumeration.'
}
function Copy-Item {
  param([string]$LiteralPath, [string]$Destination, [switch]$Recurse, [switch]$Force)
  $script:Events.Add('mutation:copy')
  $script:Mutations.Add([pscustomobject]@{operation='copy';source=$LiteralPath;destination=$Destination})
}
function Push-Location { param([string]$Path) $script:Events.Add('location:push') }
function Pop-Location { $script:Events.Add('location:pop') }
function Complete-Scenario([scriptblock]$Action) {
  $failure = ''; $value = $null
  try { $value = & $Action } catch { $failure = $_.Exception.Message }
  @{error=$failure;value=$value;directory=$script:PublicSourceDirectory;verification=$script:PublicSourceVerification;events=@($script:Events);queries=@($script:Queries);mutations=@($script:Mutations)} | ConvertTo-Json -Compress -Depth 12
}
` + scenario
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  const result = spawnSync(shell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
    env: {
      ...process.env, GAOGE_RELEASE_SCRIPT_UNDER_TEST: productionScript,
      POWERSHELL_UPDATECHECK: 'Off', POWERSHELL_TELEMETRY_OPTOUT: '1',
    },
  })
  assert.equal(result.error, undefined, `PowerShell guard test could not run: ${result.error?.message}`)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

function expectBlocked(result, message) {
  assert.match(result.error, message)
  assert.deepEqual(result.mutations, [], 'failure must precede all build mutations')
}

test('a release-unready public source export fails before anonymous verification', () => {
  const result = releaseGuardScenario(String.raw`
$script:ExportReleaseReady = $false
Complete-Scenario { Assert-PublicSourceRelease 'HEAD' }
`)
  expectBlocked(result, /not release-ready/)
  assert.deepEqual(result.events, ['git:show', 'export'])
  assert.equal(result.verification, null)
})

test('source commit version must match before exporting or verifying source', () => {
  const result = releaseGuardScenario(String.raw`
$script:PackageVersion = '1.7.0'
Complete-Scenario { Assert-PublicSourceRelease 'HEAD' }
`)
  expectBlocked(result, /Commit version 1\.7\.1/)
  assert.deepEqual(result.events, ['git:show'])
})

test('a mismatched exported source version is not release-ready', () => {
  const result = releaseGuardScenario(String.raw`
$script:ExportVersion = '1.7.0'
Complete-Scenario { Assert-PublicSourceRelease 'HEAD' }
`)
  expectBlocked(result, /not release-ready/)
  assert.deepEqual(result.events, ['git:show', 'export'])
})

test('the exporter cannot substitute a different source directory', () => {
  const result = releaseGuardScenario(String.raw`
$script:ExportDirectoryMismatch = $true
Complete-Scenario { Assert-PublicSourceRelease 'HEAD' }
`)
  expectBlocked(result, /unexpected directory/)
  assert.equal(result.directory, '')
  assert.ok(!result.events.includes('verify'))
})

test('public source cannot reuse the private build repository, including case variants', () => {
  const result = releaseGuardScenario(String.raw`
$script:PublicSourceRepository = 'SYNTHETIC/PRIVATE-BUILD'
Complete-Scenario { Assert-PublicSourceRelease 'HEAD' }
`)
  expectBlocked(result, /repositories must be separate/)
  assert.deepEqual(result.queries, [])
  assert.deepEqual(result.events, [])
})

test('verification refuses a missing reviewed source directory', () => {
  const result = releaseGuardScenario(String.raw`
Complete-Scenario { Confirm-PublicSourceRelease }
`)
  expectBlocked(result, /No reviewed corresponding-source directory/)
  assert.deepEqual(result.queries, [])
})

for (const [label, change] of [
  ['unverified public source', '$script:VerificationResult.verified = $false'],
  ['a public version mismatch', "$script:VerificationResult.version = '1.7.0'"],
  ['a public release tag mismatch', "$script:VerificationResult.tag = 'v1.7.1-build.2'"],
]) {
  test(`verification rejects ${label}`, () => {
    const result = releaseGuardScenario(change + String.raw`
Complete-Scenario { Assert-PublicSourceRelease 'HEAD' }
`)
    expectBlocked(result, /source verification failed/)
    assert.equal(result.verification, null)
    assert.deepEqual(result.events, ['git:show', 'export', 'verify'])
  })
}

test('moving the public source tag after its first verification blocks release', () => {
  const result = releaseGuardScenario(String.raw`
Complete-Scenario {
  Assert-PublicSourceRelease 'HEAD'
  $script:VerificationResult = [pscustomobject]@{verified=$true;version=$Version;tag=$ReleaseTag;publicCommit=('b' * 40);sourceCommit=('c' * 40)}
  Confirm-PublicSourceRelease
}
`)
  expectBlocked(result, /public source tag changed/)
  assert.equal(result.verification.publicCommit, 'a'.repeat(40), 'failed recheck must preserve the pinned commit')
  assert.deepEqual(result.events, ['git:show', 'export', 'verify', 'verify'])
})

test('a successful source export pins and rechecks the same public release commit', () => {
  const result = releaseGuardScenario(String.raw`
Complete-Scenario { Assert-PublicSourceRelease 'HEAD'; Confirm-PublicSourceRelease }
`)
  assert.equal(result.error, '')
  assert.equal(result.verification.verified, true)
  assert.equal(result.verification.version, '1.7.1')
  assert.equal(result.verification.publicCommit, 'a'.repeat(40))
  assert.match(result.directory, /gaoge-reviewed-source-1\.7\.1-/)
  assert.deepEqual(result.events, ['git:show', 'export', 'verify', 'verify'])
  assert.deepEqual(result.mutations, [])
  for (const query of result.queries.filter(query => query.file === 'node')) {
    assert.deepEqual(query.arguments.slice(1), [
      '--repository', 'synthetic/public-source', '--tag', 'v1.7.1', '--source-directory', result.directory,
    ])
  }
})

test('build-tree comparison refuses a missing public source verification', () => {
  const result = releaseGuardScenario(String.raw`
Complete-Scenario { Assert-BuildMatchesPublicSource $script:BuildCommit }
`)
  expectBlocked(result, /Public source is not verified/)
  assert.deepEqual(result.queries, [])
})

for (const [label, assignment] of [
  ['missing public tree', "$script:PublicTree = ''"],
  ['invalid public tree', "$script:PublicTree = 'not-a-git-tree'; $script:BuildTree = 'not-a-git-tree'"],
  ['missing build tree', "$script:BuildTree = ''"],
  ['different build tree', "$script:BuildTree = 'f' * 40"],
]) {
  test(`build-tree comparison blocks ${label}`, () => {
    const result = releaseGuardScenario(assignment + String.raw`
Complete-Scenario {
  Assert-PublicSourceRelease 'HEAD'
  Assert-BuildMatchesPublicSource $script:BuildCommit
}
`)
    expectBlocked(result, /Build snapshot tree differs/)
    assert.deepEqual(result.events.slice(-2), ['gh:public-tree', 'gh:build-tree'])
  })
}

test('identical public and private build trees pass the correspondence guard', () => {
  const result = releaseGuardScenario(String.raw`
Complete-Scenario {
  Assert-PublicSourceRelease 'HEAD'
  Assert-BuildMatchesPublicSource $script:BuildCommit
}
`)
  assert.equal(result.error, '')
  assert.deepEqual(result.mutations, [])
  assert.deepEqual(result.events.slice(-2), ['gh:public-tree', 'gh:build-tree'])
  assert.deepEqual(result.queries.filter(query => query.file === 'gh').map(query => query.arguments[1]), [
    `repos/synthetic/public-source/git/commits/${'a'.repeat(40)}`,
    `repos/synthetic/private-build/git/commits/${'e'.repeat(40)}`,
  ])
})

for (const [label, prelude] of [
  ['missing verification', ''],
  ['missing source identity', "$script:PublicSourceVerification = [pscustomobject]@{verified=$true}"],
  ['blank source identity', "$script:PublicSourceVerification = [pscustomobject]@{verified=$true;sourceCommit=' '}"],
  ['a source commit that differs from the build tag', "Assert-PublicSourceRelease 'HEAD'; $script:TagCommit = 'f' * 40"],
]) {
  for (const existing of [false, true]) {
    test('build export rejects ' + label + ' before inspecting or mutating ' + (existing ? 'an existing' : 'a new') + ' temp path', () => {
      const result = releaseGuardScenario(String.raw`
$script:WorkRootExists = $BOOL
Complete-Scenario {
`
        .replace('$BOOL', existing ? '$true' : '$false') + prelude + String.raw`
  Export-BuildSnapshot 'v1.7.1' 'release/v1.7.1'
}
`
      )
      expectBlocked(result, /build tag does not match verified public corresponding source/)
      assert.ok(result.events.includes('git:rev-list'))
      assert.equal(result.events.includes('filesystem:exists'), false, 'identity guard must precede all temporary-path inspection')
    })
  }
}

test('build export rejects an existing GUID directory without reusing or deleting it', () => {
  const result = releaseGuardScenario(String.raw`
$script:WorkRootExists = $true
Complete-Scenario {
  Assert-PublicSourceRelease 'HEAD'
  Export-BuildSnapshot 'v1.7.1' 'release/v1.7.1'
}
`
  )
  expectBlocked(result, /Refusing to reuse an existing build snapshot directory/)
  const candidate = result.queries.find(query => query.file === 'Test-Path')
  assert.match(candidate.arguments[0].replaceAll('\\', '/'), /\/gaoge-public-build-1\.7\.1-[a-f0-9]{32}$/)
  assert.ok(result.events.indexOf('git:rev-list') < result.events.indexOf('filesystem:exists'))
})


test('a legacy fixed build directory is neither selected nor modified', () => {
  const result = releaseGuardScenario(String.raw`
$script:ExistingWorkRoot = Join-Path $env:TEMP 'gaoge-public-build-1.7.1'
Complete-Scenario {
  Assert-PublicSourceRelease 'HEAD'
  Export-BuildSnapshot 'v1.7.1' 'release/v1.7.1'
}
`)
  assert.equal(result.error, '')
  const created = result.mutations.filter(mutation => mutation.operation === 'new')
  assert.equal(created.length, 1)
  assert.match(created[0].path.replaceAll('\\', '/'), /\/gaoge-public-build-1\.7\.1-[a-f0-9]{32}$/)
  assert.equal(result.mutations.some(mutation => mutation.operation === 'remove'), false)
  assert.equal(result.queries.some(query => query.file === 'Test-Path' && /[\\/]gaoge-public-build-1\.7\.1$/.test(query.arguments[0])), false)
})

test('each successful export allocates a fresh GUID directory', () => {
  const result = releaseGuardScenario(String.raw`
Complete-Scenario {
  Assert-PublicSourceRelease 'HEAD'
  $first = Export-BuildSnapshot 'v1.7.1' 'release/v1.7.1'
  $second = Export-BuildSnapshot 'v1.7.1' 'release/v1.7.1'
}
`)
  assert.equal(result.error, '')
  const paths = result.mutations.filter(mutation => mutation.operation === 'new').map(mutation => mutation.path)
  assert.equal(paths.length, 2)
  assert.notEqual(paths[0], paths[1], 'repeated exports must never reuse a temporary checkout')
  for (const destination of paths) {
    assert.match(destination.replaceAll('\\', '/'), /\/gaoge-public-build-1\.7\.1-[a-f0-9]{32}$/)
  }
  assert.equal(result.mutations.some(mutation => mutation.operation === 'remove'), false)
})

test('build export copies only the reviewed source directory and preserves tree identity', () => {
  const result = releaseGuardScenario(String.raw`
Complete-Scenario {
  Assert-PublicSourceRelease 'HEAD'
  $snapshot = Export-BuildSnapshot 'v1.7.1' 'release/v1.7.1'
  Assert-BuildMatchesPublicSource $snapshot
  $snapshot
}
`)
  assert.equal(result.error, '')
  assert.equal(result.value, 'e'.repeat(40))
  const copy = result.mutations.filter(mutation => mutation.operation === 'copy')
  assert.equal(copy.length, 1)
  assert.equal(copy[0].source.replaceAll('\\', '/'), `${result.directory.replaceAll('\\', '/')}/package.json`)
  const commands = result.mutations.filter(mutation => mutation.operation === 'git').map(mutation => mutation.arguments)
  assert.deepEqual(commands.filter(args => args[0] === 'push'), [
    ['push', '--force', 'origin', 'release/v1.7.1:release/v1.7.1'], ['push', 'origin', 'v1.7.1'],
  ])
  assert.ok(result.events.indexOf('verify') < result.events.indexOf('mutation:copy'))
  assert.ok(result.events.indexOf('git:rev-list') < result.events.indexOf('mutation:git:push'))
  assert.deepEqual(result.events.slice(-3), ['location:pop', 'gh:public-tree', 'gh:build-tree'])
  assert.ok(result.events.indexOf('git:rev-list') < result.events.indexOf('mutation:new'))
  const created = result.mutations.filter(mutation => mutation.operation === 'new')
  assert.equal(created.length, 1)
  assert.equal(copy[0].destination, created[0].path)
  assert.match(created[0].path.replaceAll('\\', '/'), /\/gaoge-public-build-1\.7\.1-[a-f0-9]{32}$/)
})

test('the production AST verifies source before tags and builds, then rechecks before promotion', () => {
  const result = releaseGuardScenario(String.raw`
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
$top = @(); $publication = @(); $sourceGuard = @()
foreach ($command in $commands) {
  $owner = ''; $parent = $command.Parent
  while ($null -ne $parent) {
    if ($parent -is [System.Management.Automation.Language.FunctionDefinitionAst]) { $owner = $parent.Name; break }
    $parent = $parent.Parent
  }
  $entry = [pscustomobject]@{name=$command.GetCommandName();offset=$command.Extent.StartOffset;elements=@($command.CommandElements | ForEach-Object { $_.Extent.Text })}
  if ($owner -eq '') { $top += $entry }
  if ($owner -eq 'Publish-RemoteArtifacts') { $publication += $entry }
  if ($owner -eq 'Assert-PublicSourceRelease') { $sourceGuard += $entry }
}
@{top=@($top | Sort-Object offset);publication=@($publication | Sort-Object offset);sourceGuard=@($sourceGuard | Sort-Object offset)} | ConvertTo-Json -Compress -Depth 12
`)
  const named = name => result.top.filter(command => command.name === name)
  const single = name => {
    const commands = named(name)
    assert.equal(commands.length, 1, `expected exactly one top-level ${name}`)
    return commands[0]
  }
  const source = single('Assert-PublicSourceRelease')
  const immutableVersion = single('Assert-SourceVersionMatches')
  const buildExport = single('Export-BuildSnapshot')
  const workflow = single('Find-Or-RunWorkflow')
  const confirm = single('Confirm-PublicSourceRelease')
  const publish = single('Publish-RemoteArtifacts')
  const treeChecks = named('Assert-BuildMatchesPublicSource')
  assert.equal(treeChecks.length, 2, 'tree identity must be checked both before the build and before publication')
  assert.ok(source.offset < buildExport.offset)
  assert.ok(source.offset < treeChecks[0].offset)
  assert.ok(treeChecks[0].offset < workflow.offset)
  assert.ok(workflow.offset < confirm.offset)
  assert.ok(confirm.offset < treeChecks[1].offset)
  assert.ok(treeChecks[1].offset < publish.offset)
  const gitMutations = result.top.filter(command => command.name === 'Invoke-Checked'
    && command.elements[1] === 'git' && ['tag', 'push', 'add', 'commit'].includes(command.elements[2]))
  assert.ok(gitMutations.some(command => command.elements[2] === 'tag'))
  assert.ok(gitMutations.some(command => command.elements[2] === 'push'))
  for (const command of gitMutations) {
    assert.ok(source.offset < command.offset, 'public source must be verified before source tag/push')
    assert.ok(immutableVersion.offset < command.offset, 'version preflight must precede source tag/push')
    assert.ok(!['add', 'commit'].includes(command.elements[2]), 'release must not mutate its verified source commit')
    if (command.elements[2] === 'push') assert.equal(command.elements.at(-1), '$tagName', 'only the verified source tag is published')
  }
  assert.equal(named('Set-SourceVersion').length, 0, 'verified release source must remain immutable')
  const verifyInsideSourceGuard = result.sourceGuard.filter(command => command.name === 'Confirm-PublicSourceRelease')
  assert.equal(verifyInsideSourceGuard.length, 1)
  const promotions = result.publication.filter(command => command.name === 'Invoke-RemoteReleaseAction'
    && command.elements.includes('"promote"'))
  assert.equal(promotions.length, 1, 'the guarded publication function must own the actual promotion')
  assert.ok(!result.top.some(command => command.name === 'Invoke-RemoteReleaseAction'
    && command.elements.includes('"promote"')), 'promotion cannot bypass the guarded publication call')
})

// Version preflight reads a disposable fixture tree and is itself extracted by
// AST. The Node JSON projection is stubbed, including strict argument binding:
// PowerShell must pass the -e program as one argument, not consume its switches.
function immutableVersionScenario(changes = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gaoge-source-version-guard-'))
  const versions = {
    package: '1.7.1', lock: '1.7.1', lockRoot: '1.7.1', tauri: '1.7.1',
    cargo: '1.7.1', cargoLock: '1.7.1', rust: '1.7.1', ...changes,
  }
  const fixture = {
    'package.json': JSON.stringify({ version: versions.package }),
    'package-lock.json': JSON.stringify({ version: versions.lock, packages: { '': { version: versions.lockRoot } } }),
    'src-tauri/tauri.conf.json': JSON.stringify({ version: versions.tauri }),
    'src-tauri/Cargo.toml': `[package]\nname = "gaoge-free"\nversion = "${versions.cargo}"\n` + (versions.extraToml || ''),
    'src-tauri/Cargo.lock': `[[package]]\nname = "gaoge-free"\nversion = "${versions.cargoLock}"\n`,
    'src-tauri/src/lib.rs': `const USER_AGENT: &str = "GaogeAii/${versions.rust}";\n`,
  }
  try {
    for (const [name, content] of Object.entries(fixture)) {
      const target = path.join(directory, name)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    const lockFixture = JSON.parse(readFileSync(path.join(directory, 'package-lock.json'), 'utf8'))
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:GAOGE_RELEASE_SCRIPT_UNDER_TEST, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Release script must parse without errors.' }
$definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-SourceVersionMatches' }, $false))
if ($definitions.Count -ne 1) { throw 'Missing immutable version preflight.' }
$allowedCommands = @('Write-Step', 'Get-Content', 'Join-Path', 'ConvertFrom-Json', 'Invoke-Captured')
$allowedMethods = @('ReadAllText', 'Escape', 'IsMatch', 'Match', 'Contains')
foreach ($command in @($definitions[0].Body.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))) {
  if ($allowedCommands -notcontains $command.GetCommandName()) { throw 'Unexpected command in immutable version preflight.' }
}
foreach ($method in @($definitions[0].Body.FindAll({ param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true))) {
  if ($allowedMethods -notcontains $method.Member.Extent.Text) { throw 'Unexpected method in immutable version preflight.' }
}
. ([scriptblock]::Create($definitions[0].Extent.Text))
$script:Root = $env:GAOGE_SOURCE_VERSION_FIXTURE
$script:Version = '1.7.1'
$script:ReleaseTag = 'v1.7.1'
$script:QueryCount = 0
function Write-Step([string]$Message) {}
function Invoke-Captured {
  param([string]$FilePath, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
  if ($FilePath -ne 'node' -or $Arguments.Count -ne 3 -or $Arguments[0] -ne '-e' -or
      $Arguments[2] -ne (Join-Path $script:Root 'package-lock.json') -or
      -not $Arguments[1].Contains('p.packages[""].version')) {
    throw 'Unexpected external command or broken Node -e argument binding.'
  }
  $script:QueryCount += 1
  return $env:GAOGE_LOCK_FIXTURE_PROJECTION
}
$failure = ''
try { Assert-SourceVersionMatches } catch { $failure = $_.Exception.Message }
@{error=$failure;queries=$script:QueryCount} | ConvertTo-Json -Compress
`
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    const result = spawnSync(shell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64'),
    ], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
      env: {
        ...process.env, GAOGE_RELEASE_SCRIPT_UNDER_TEST: productionScript,
        GAOGE_SOURCE_VERSION_FIXTURE: directory,
        GAOGE_LOCK_FIXTURE_PROJECTION: JSON.stringify({
          version: lockFixture.version, rootVersion: lockFixture.packages[''].version,
        }),
        POWERSHELL_UPDATECHECK: 'Off', POWERSHELL_TELEMETRY_OPTOUT: '1',
      },
    })
    assert.equal(result.error, undefined, `PowerShell version test could not run: ${result.error?.message}`)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    for (const [name, content] of Object.entries(fixture)) {
      assert.equal(readFileSync(path.join(directory, name), 'utf8'), content, `${name} must stay unchanged during preflight`)
    }
    return JSON.parse(result.stdout.trim())
  } finally {
    // Only the unique directory created by this test is removed, never source.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('gaoge-source-version-guard-'))
    rmSync(directory, { recursive: true, force: true })
  }
}

test('immutable version preflight accepts all committed version sources without writing files', () => {
  const result = immutableVersionScenario()
  assert.equal(result.error, '')
  assert.equal(result.queries, 1)
})

for (const field of ['package', 'lock', 'lockRoot', 'tauri', 'cargo', 'cargoLock', 'rust']) {
  test(`immutable version preflight rejects ${field} mismatch without rewriting source`, () => {
    const result = immutableVersionScenario({ [field]: '1.7.0' })
    assert.match(result.error, /All version fields must be committed at 1\.7\.1/)
    assert.equal(result.queries, 1)
  })
}


test('Cargo package version cannot be masked by the same version in an unrelated TOML table', () => {
  const result = immutableVersionScenario({
    cargo: '1.7.0',
    extraToml: '[package.metadata.release]\nversion = "1.7.1"\n',
  })
  assert.match(result.error, /All version fields must be committed at 1\.7\.1/)
  assert.equal(result.queries, 1)
})


test('release tag defaults to the original version tag without changing product version', () => {
  const result = releaseGuardScenario(String.raw`
$probe = [scriptblock]::Create($ast.ParamBlock.Extent.Text + [Environment]::NewLine + 'Assert-ReleaseTag; return @{tag=$ReleaseTag;version=$Version}')
Complete-Scenario { & $probe -Version '1.7.1' }
`)
  assert.equal(result.error, '')
  assert.deepEqual(result.value, { tag: 'v1.7.1', version: '1.7.1' })
  assert.deepEqual(result.queries, [])
  assert.deepEqual(result.mutations, [])
})

for (const tag of ['v1.7.2', 'v1.7.2-build.2', 'v1.7.1-build.0', 'v1.7.1-build.02', 'v1.7.1-build.-1', 'v1.7.1-build.2-extra', 'V1.7.1', 'v1.7.1-build.2\n']) {
  test(`release entry rejects nonmatching or malformed immutable tag ${JSON.stringify(tag)}`, () => {
    const value = Buffer.from(tag).toString('base64')
    const result = releaseGuardScenario(`$script:ReleaseTag = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${value}'))\nComplete-Scenario { Assert-ReleaseTag }`)
    expectBlocked(result, /ReleaseTag must be v1\.7\.1 or v1\.7\.1-build\.N/)
    assert.deepEqual(result.queries, [], 'invalid tags must fail without querying external state')
  })
}

test('build.2 flows through anonymous source verification, build tags, workflow ref, and recheck', () => {
  const result = releaseGuardScenario(String.raw`
$script:ReleaseTag = 'v1.7.1-build.2'
$script:VerificationResult.tag = $ReleaseTag
Complete-Scenario {
  Assert-ReleaseTag
  Assert-PublicSourceRelease 'HEAD'
  $sha = Export-BuildSnapshot $ReleaseTag 'synthetic-build'
  Assert-BuildMatchesPublicSource $sha
  Find-Or-RunWorkflow $sha $ReleaseTag
  Confirm-PublicSourceRelease
}
`)
  assert.equal(result.error, '')
  assert.equal(result.verification.version, '1.7.1')
  assert.equal(result.verification.tag, 'v1.7.1-build.2')
  const queries = result.queries
  for (const query of queries.filter(query => query.file === 'node')) assert.equal(query.arguments[query.arguments.indexOf('--tag') + 1], 'v1.7.1-build.2')
  assert.deepEqual(queries.find(query => query.file === 'git' && query.arguments[0] === 'rev-list').arguments, ['rev-list', '-n', '1', 'v1.7.1-build.2'])
  const git = result.mutations.filter(entry => entry.operation === 'git')
  assert.ok(git.some(entry => JSON.stringify(entry.arguments) === JSON.stringify(['tag', 'v1.7.1-build.2'])))
  assert.ok(git.some(entry => JSON.stringify(entry.arguments) === JSON.stringify(['push', 'origin', 'v1.7.1-build.2'])))
  assert.ok(git.some(entry => entry.arguments[0] === 'commit' && entry.arguments.at(-1) === 'release: build snapshot v1.7.1-build.2'))
  for (const query of queries.filter(query => query.file === 'gh' && query.arguments[0] === 'run' && query.arguments[1] === 'list')) assert.equal(query.arguments[query.arguments.indexOf('--branch') + 1], 'v1.7.1-build.2')
  const dispatch = result.mutations.find(entry => entry.operation === 'gh' && entry.arguments[0] === 'workflow')
  assert.equal(dispatch.arguments[dispatch.arguments.indexOf('--ref') + 1], 'v1.7.1-build.2')
  assert.ok(!git.some(entry => entry.arguments.includes('v1.7.1')), 'the original tag must not be recreated, pushed, or rewritten')
})

for (const status of ['completed', 'in_progress']) {
  test(`workflow never reuses a ${status} run of another tag with the same commit`, () => {
    const result = releaseGuardScenario(`
$script:ReleaseTag = 'v1.7.1-build.2'
$script:WorkflowRuns = @([pscustomobject]@{databaseId=99;headSha=$script:BuildCommit;headBranch='v1.7.1';status='${status}';conclusion='${status === 'completed' ? 'success' : ''}';url='https://example.invalid/build/99'})
Complete-Scenario { Find-Or-RunWorkflow $script:BuildCommit $ReleaseTag }
`)
    assert.equal(result.error, '')
    assert.equal(result.value.databaseId, 123)
    assert.ok(result.mutations.some(entry => entry.operation === 'gh' && entry.arguments[0] === 'workflow'))
  })
}

test('workflow completion must still identify the selected immutable tag', () => {
  const result = releaseGuardScenario(String.raw`
$script:ReleaseTag = 'v1.7.1-build.2'
$script:WorkflowCompletionBranchOverride = 'v1.7.1'
Complete-Scenario { Find-Or-RunWorkflow $script:BuildCommit $ReleaseTag }
`)
  assert.match(result.error, /Release Build did not complete successfully/)
})

test('release entry validates the tag before config reads and retains one selected tag throughout', () => {
  const script = readFileSync(productionScript, 'utf8')
  assert.match(script, /\[string\] \$ReleaseTag = "v\$Version"/)
  assert.match(script, /Assert-VersionOrder\s+Assert-ReleaseTag\s+Write-Info[^\n]*\$ReleaseTag[^\n]*\s+\$config = Read-ReleaseConfig/)
  assert.match(script, /\$tagName = \$ReleaseTag/)
  assert.doesNotMatch(script, /\$tagName = "v\$Version"|--tag "v\$Version"/)
  assert.match(script, /Get-RemoteTagSha "origin" \$tagName/)
  assert.match(script, /Export-BuildSnapshot \$tagName \$buildBranch/)
  assert.match(script, /Find-Or-RunWorkflow \$buildSha \$tagName/)
  assert.match(script, /tag = \$tagName/)
  assert.match(script, /publicSourceUrl = "https:\/\/github\.com\/\$PublicSourceRepository\/tree\/\$tagName"/)
})


test('adding ReleaseTag preserves existing positional Version and MinimumVersion arguments', () => {
  const result = releaseGuardScenario(String.raw`
$probe = [scriptblock]::Create($ast.ParamBlock.Extent.Text + [Environment]::NewLine + 'Assert-ReleaseTag; return @{tag=$ReleaseTag;version=$Version;minimumVersion=$MinimumVersion}')
Complete-Scenario { & $probe '1.7.1' '1.6.3' }
`)
  assert.equal(result.error, '')
  assert.deepEqual(result.value, { tag: 'v1.7.1', version: '1.7.1', minimumVersion: '1.6.3' })
  assert.deepEqual(result.queries, [])
  assert.deepEqual(result.mutations, [])
})
