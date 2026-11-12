param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string] $Version,

  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string] $MinimumVersion = "0.0.0",

  [switch] $KeepBuildPrivate = $true,

  [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
  [string] $PublicSourceRepository = "KKK-898/Gaoge-Free-Desktop"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$script:ConfigPath = Join-Path $script:Root ".release.local.json"
$script:BuildRepoTouched = $false
$script:BuildRepo = ""
$script:RemoteGroups = @()
$script:PromotedGroups = @()
$script:PublicSourceDirectory = ""
$script:PublicSourceVerification = $null

function Write-Step([string] $Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info([string] $Message) {
  Write-Host "    $Message"
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments
  )
  if ($FilePath -eq "git") {
    $Arguments = @("-c", "http.version=HTTP/1.1") + $Arguments
  }
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($exitCode -ne 0) {
    throw "Command failed ($exitCode): $FilePath $($Arguments -join ' ')"
  }
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments
  )
  if ($FilePath -eq "git") {
    $Arguments = @("-c", "http.version=HTTP/1.1") + $Arguments
  }
  $output = @(& $FilePath @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')`n$($output -join "`n")"
  }
  return ($output -join "`n").Trim()
}

function Require-Command([string] $Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Get-Property($Object, [string] $Name, $Default = $null) {
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Assert-HttpsUrl([string] $Value, [string] $Label) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "Missing $Label" }
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne "https") {
    throw "$Label must be an absolute HTTPS URL: $Value"
  }
  return $Value.TrimEnd('/')
}

function Resolve-IdentityFile([string] $Value, [string] $Label) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim())
  if ($expanded.StartsWith("~/") -or $expanded.StartsWith("~\")) {
    $expanded = Join-Path $HOME $expanded.Substring(2)
  }
  if ($expanded -match "[`r`n`"]" -or -not (Test-Path -LiteralPath $expanded -PathType Leaf)) {
    throw "$Label does not reference a valid local SSH identity file."
  }
  return (Resolve-Path -LiteralPath $expanded).Path
}

function Read-ReleaseConfig {
  if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
    throw "Missing $($script:ConfigPath). Copy .release.local.example.json and fill the real release settings."
  }
  $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $script:ConfigPath
  if ($raw -match '(?i)password|private.?key|token|secret') {
    throw ".release.local.json must not contain passwords, tokens, private keys, or secrets."
  }
  $config = $raw | ConvertFrom-Json
  $bootstrapUrls = @(Get-Property $config "bootstrapConfigUrls" @())
  if ($bootstrapUrls.Count -eq 0) { throw "bootstrapConfigUrls must contain at least one OSS URL." }
  foreach ($url in $bootstrapUrls) { Assert-HttpsUrl ([string]$url) "bootstrapConfigUrl" | Out-Null }
  if ([string]::IsNullOrWhiteSpace([string](Get-Property $config "buildRepo" ""))) { throw "Missing buildRepo." }
  $hosts = Get-Property $config "sshHosts"
  if ($null -eq $hosts -or @($hosts.PSObject.Properties).Count -eq 0) { throw "sshHosts must not be empty." }
  foreach ($hostProperty in $hosts.PSObject.Properties) {
    Resolve-IdentityFile ([string](Get-Property $hostProperty.Value "identityFile" "")) "sshHosts.$($hostProperty.Name).identityFile" | Out-Null
  }
  $mirrors = @(Get-Property $config "updateMirrors" @())
  if ($mirrors.Count -eq 0) { throw "updateMirrors must not be empty." }
  $seen = @{}
  foreach ($mirror in $mirrors) {
    $id = [string](Get-Property $mirror "id" "")
    $hostId = [string](Get-Property $mirror "sshHost" "")
    if ([string]::IsNullOrWhiteSpace($id) -or $seen.ContainsKey($id)) { throw "Invalid or duplicate update mirror id: $id" }
    $seen[$id] = $true
    if ($null -eq $hosts.PSObject.Properties[$hostId]) { throw "Mirror $id references unknown sshHost $hostId" }
    Assert-HttpsUrl ([string](Get-Property $mirror "publicBaseUrl" "")) "mirror $id publicBaseUrl" | Out-Null
    $remoteRoot = [string](Get-Property $mirror "remoteRoot" "")
    if (-not $remoteRoot.StartsWith('/')) { throw "Mirror $id remoteRoot must be an absolute Linux path." }
  }
  return $config
}

function ConvertTo-CanonicalDirectory($Payload) {
  $data = if ($null -ne $Payload.PSObject.Properties['data']) { $Payload.data } else { $Payload }
  $servers = @(Get-Property $data "servers" @())
  if ($servers.Count -eq 0) { throw "Runtime server directory has no servers." }
  $normalized = foreach ($server in ($servers | Sort-Object { [string](Get-Property $_ "id" "") })) {
    [ordered]@{
      id = [string](Get-Property $server "id" "")
      name = [string](Get-Property $server "name" (Get-Property $server "title" ""))
      rootDomain = [string](Get-Property $server "rootDomain" (Get-Property $server "root_domain" ""))
      enabled = (Get-Property $server "enabled" $true) -ne $false
      sort = [int](Get-Property $server "sort" 0)
      overrides = Get-Property $server "overrides" ([pscustomobject]@{})
    }
  }
  return ([ordered]@{
    version = [int](Get-Property $data "version" 1)
    defaultServerId = [string](Get-Property $data "defaultServerId" (Get-Property $data "default_server_id" ""))
    servers = @($normalized)
  } | ConvertTo-Json -Depth 50 -Compress)
}

function Test-BootstrapDirectories($Config) {
  Write-Step "Checking OSS bootstrap directories"
  $canonical = $null
  $reachable = 0
  foreach ($entry in @(Get-Property $Config "bootstrapConfigUrls" @())) {
    $url = [string]$entry
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20 -Headers @{ "Cache-Control" = "no-cache" }
      if ([int]$response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
      $payload = $response.Content | ConvertFrom-Json
      $current = ConvertTo-CanonicalDirectory $payload
      if ($null -eq $canonical) { $canonical = $current }
      elseif ($canonical -ne $current) { throw "Reachable OSS directory content differs from the first reachable entry." }
      $reachable += 1
      Write-Info "OK $url"
    } catch {
      if ($_.Exception.Message -like '*differs from*') { throw }
      Write-Warning "OSS directory unavailable, continuing with mirrors: $url ($($_.Exception.Message))"
    }
  }
  if ($reachable -eq 0) { throw "No OSS bootstrap directory is reachable." }
  Write-Info "$reachable OSS bootstrap directory entry/entries validated"
}

function Assert-VersionOrder {
  $release = [Version]$Version
  $minimum = [Version]$MinimumVersion
  if ($minimum -gt $release) { throw "MinimumVersion $MinimumVersion cannot be newer than Version $Version." }
}

function Assert-SourceVersionMatches {
  Write-Step "Checking immutable release version $Version"
  $package = Get-Content -Raw -LiteralPath (Join-Path $script:Root "package.json") | ConvertFrom-Json
  $lockPath = Join-Path $script:Root "package-lock.json"
  # PowerShell PSCustomObject cannot represent npm's empty-string root package key.
  $lock = ConvertFrom-Json (Invoke-Captured -FilePath node -Arguments @('-e', 'const f=require("fs"),p=JSON.parse(f.readFileSync(process.argv[1],"utf8").replace(/^\uFEFF/,""));console.log(JSON.stringify({version:p.version,rootVersion:p.packages[""].version}))', $lockPath))
  $tauri = Get-Content -Raw -LiteralPath (Join-Path $script:Root "src-tauri/tauri.conf.json") | ConvertFrom-Json
  $cargo = [IO.File]::ReadAllText((Join-Path $script:Root "src-tauri/Cargo.toml"))
  $cargoPackage = [regex]::Match($cargo, '(?ms)^\[package\]\s*\r?\n(?<body>.*?)(?=^\[|\z)').Groups["body"].Value
  $cargoLock = [IO.File]::ReadAllText((Join-Path $script:Root "src-tauri/Cargo.lock"))
  $rust = [IO.File]::ReadAllText((Join-Path $script:Root "src-tauri/src/lib.rs"))
  $escapedVersion = [regex]::Escape($Version)
  if ($package.version -ne $Version -or $lock.version -ne $Version -or
      $lock.rootVersion -ne $Version -or $tauri.version -ne $Version -or
      -not [regex]::IsMatch($cargoPackage, ('(?m)^version\s*=\s*"' + $escapedVersion + '"\s*(?:#.*)?$')) -or
      -not [regex]::IsMatch($cargoLock, ('(?ms)\[\[package\]\]\r?\nname = "gaoge-free"\r?\nversion = "' + $escapedVersion + '"')) -or
      -not $rust.Contains('GaogeAii/' + $Version + '"')) {
    throw "All version fields must be committed at $Version before publishing corresponding source."
  }
}

function Get-RemoteTagSha([string] $Repository, [string] $Tag) {
  $result = @(& git ls-remote --tags $Repository "refs/tags/$Tag" 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect tag $Tag on $Repository" }
  if ($result.Count -eq 0) { return "" }
  return ([string]$result[0]).Split("`t")[0].Trim()
}

function Assert-BuildSecrets([string] $Repository) {
  $json = Invoke-Captured gh api "repos/$Repository/actions/secrets"
  $names = @((ConvertFrom-Json $json).secrets | ForEach-Object { $_.name })
  foreach ($required in @("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")) {
    if ($names -notcontains $required) { throw "Build repository is missing required secret: $required" }
  }
}

function Get-BuildRepoVisibility {
  if ([string]::IsNullOrWhiteSpace($script:BuildRepo)) { throw "Build repository is not configured." }
  $visibility = (Invoke-Captured gh repo view $script:BuildRepo --json visibility --jq '.visibility').Trim().ToLowerInvariant()
  if ($visibility -notin @("private", "public")) {
    throw "Could not verify build repository visibility."
  }
  return $visibility
}

function Set-BuildRepoVisibility([ValidateSet("private", "public")][string] $Visibility) {
  if ($Visibility -ne "private") {
    throw "KeepBuildPrivate forbids making the build repository public; no public fallback is allowed."
  }
  $current = Get-BuildRepoVisibility
  if ($current -ne $Visibility) {
    Invoke-Checked gh repo edit $script:BuildRepo --visibility $Visibility --accept-visibility-change-consequences
    $current = Get-BuildRepoVisibility
  }
  if ($current -ne $Visibility) {
    throw "Build repository visibility was not confirmed as $Visibility."
  }
  Write-Info "verified build repository visibility: $current"
}

function Initialize-BuildRepoVisibility {
  if (-not $KeepBuildPrivate) {
    throw "KeepBuildPrivate cannot be disabled; the build repository must remain private."
  }
  $script:BuildRepoTouched = $true
  Set-BuildRepoVisibility "private"
}

function Assert-SafeTempPath([string] $Path) {
  $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing recursive temp operation outside $resolvedTemp : $resolvedPath"
  }
}

function Assert-PublicSourceRelease([string] $SourceRef) {
  Write-Step "Verifying public corresponding source before release"
  if ($PublicSourceRepository -eq $script:BuildRepo) {
    throw "Public source and private build repositories must be separate."
  }
  $sourcePackage = ConvertFrom-Json (Invoke-Captured git show "$($SourceRef):package.json")
  if ($sourcePackage.version -ne $Version) {
    throw "Commit version $Version and publish its reviewed corresponding source before release."
  }
  $destination = Join-Path $env:TEMP ("gaoge-reviewed-source-$Version-" + [guid]::NewGuid().ToString('N'))
  Assert-SafeTempPath $destination
  $result = & (Join-Path $script:Root "scripts/export-public-source.ps1") -Ref $SourceRef -OutputDirectory $destination
  $export = ConvertFrom-Json ($result -join "`n")
  if ($export.ReleaseReady -ne $true -or $export.Version -ne $Version) {
    throw "The corresponding-source export is not release-ready for $Version."
  }
  if ([IO.Path]::GetFullPath($export.SourceDirectory) -ne [IO.Path]::GetFullPath($destination)) {
    throw "The source export returned an unexpected directory."
  }
  $script:PublicSourceDirectory = $export.SourceDirectory
  Confirm-PublicSourceRelease
}

function Confirm-PublicSourceRelease {
  if ([string]::IsNullOrWhiteSpace($script:PublicSourceDirectory)) {
    throw "No reviewed corresponding-source directory has been prepared."
  }
  $verified = ConvertFrom-Json (Invoke-Captured node (Join-Path $script:Root "scripts/verify-public-source.mjs") `
    --repository $PublicSourceRepository --tag "v$Version" --source-directory $script:PublicSourceDirectory)
  if ($verified.verified -ne $true -or $verified.version -ne $Version) {
    throw "Public corresponding source verification failed."
  }
  if ($null -ne $script:PublicSourceVerification -and
      $script:PublicSourceVerification.publicCommit -ne $verified.publicCommit) {
    throw "The public source tag changed during release."
  }
  $script:PublicSourceVerification = $verified
  Write-Info "verified public source: $PublicSourceRepository @ $($verified.publicCommit)"
}

function Assert-BuildMatchesPublicSource([string] $BuildSha) {
  if ($null -eq $script:PublicSourceVerification) { throw "Public source is not verified." }
  $publicCommit = $script:PublicSourceVerification.publicCommit
  $publicTree = (Invoke-Captured gh api "repos/$PublicSourceRepository/git/commits/$publicCommit" --jq '.tree.sha').Trim()
  $buildTree = (Invoke-Captured gh api "repos/$($script:BuildRepo)/git/commits/$BuildSha" --jq '.tree.sha').Trim()
  if ($publicTree -notmatch '^[a-f0-9]{40}$' -or $buildTree -ne $publicTree) {
    throw "Build snapshot tree differs from verified public corresponding source."
  }
  Write-Info "verified identical public source and private build trees: $publicTree"
}

function Export-BuildSnapshot([string] $TagName, [string] $BuildBranch) {
  Write-Step "Exporting clean build snapshot"
  $tagCommit = (Invoke-Captured git rev-list -n 1 $TagName).Trim()
  if ($null -eq $script:PublicSourceVerification -or
      $null -eq $script:PublicSourceVerification.PSObject.Properties['sourceCommit'] -or
      [string]::IsNullOrWhiteSpace([string]$script:PublicSourceVerification.sourceCommit) -or
      $script:PublicSourceVerification.sourceCommit -ne $tagCommit) {
    throw "The build tag does not match verified public corresponding source."
  }
  $workRoot = Join-Path $env:TEMP ("gaoge-public-build-$Version-" + [guid]::NewGuid().ToString('N'))
  Assert-SafeTempPath $workRoot
  if (Test-Path -LiteralPath $workRoot) {
    throw "Refusing to reuse an existing build snapshot directory: $workRoot"
  }
  New-Item -ItemType Directory -Path $workRoot | Out-Null
  # Build exactly the reviewed public tree, not an unfiltered private archive.
  Get-ChildItem -LiteralPath $script:PublicSourceDirectory -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $workRoot -Recurse -Force
  }

  $sensitive = @(Get-ChildItem -LiteralPath $workRoot -Recurse -Force | Where-Object {
    $_.Name -eq '.release.local.json' -or
    $_.Name -like '.env*' -or
    $_.Name -like 'tauri-update.key*' -or
    $_.Name -match '(?i)password|private.?key|credentials'
  })
  if ($sensitive.Count -gt 0) {
    throw "Sensitive file detected in public snapshot: $($sensitive[0].FullName)"
  }

  Push-Location $workRoot
  try {
    Invoke-Checked git init
    Invoke-Checked git config core.autocrlf false
    Invoke-Checked git config user.name "Gaoge Release Bot"
    Invoke-Checked git config user.email "release-bot@gaogeai.cloud"
    Invoke-Checked git checkout -b $BuildBranch
    Invoke-Checked git add .
    Invoke-Checked git commit -m "release: build snapshot $Version"
    Invoke-Checked git remote add origin "https://github.com/$($script:BuildRepo).git"
    Invoke-Checked git push --force origin "$BuildBranch`:$BuildBranch"
    Invoke-Checked git tag $TagName
    Invoke-Checked git push origin $TagName
    return (Invoke-Captured git rev-parse HEAD)
  } finally {
    Pop-Location
  }
}

function Find-Or-RunWorkflow([string] $BuildSha, [string] $TagName) {
  $runs = @()
  try {
    $parsedRuns = ConvertFrom-Json (Invoke-Captured gh run list --repo $script:BuildRepo --workflow release-build.yml --limit 30 --json 'databaseId,headSha,headBranch,status,conclusion,url,createdAt')
    foreach ($parsedRun in $parsedRuns) { $runs += $parsedRun }
  } catch { $runs = @() }
  $existing = $runs | Where-Object { $_.headSha -eq $BuildSha -and $_.conclusion -eq "success" } | Select-Object -First 1
  if ($null -ne $existing) {
    Write-Info "reusing successful build run $($existing.url)"
    return $existing
  }
  $active = $runs | Where-Object { $_.headSha -eq $BuildSha -and $_.status -ne "completed" } | Select-Object -First 1
  if ($null -ne $active) {
    Write-Info "waiting for existing build run $($active.url)"
    Invoke-Checked gh run watch ([string]$active.databaseId) --repo $script:BuildRepo --exit-status
    $completedActive = ConvertFrom-Json (Invoke-Captured gh run view ([string]$active.databaseId) --repo $script:BuildRepo --json 'databaseId,headSha,status,conclusion,url')
    if ($completedActive.headSha -ne $BuildSha -or $completedActive.conclusion -ne "success") {
      throw "Existing Release Build did not complete successfully for the expected snapshot."
    }
    return $completedActive
  }

  Write-Step "Starting three-platform build"
  Invoke-Checked gh workflow run release-build.yml --repo $script:BuildRepo --ref $TagName
  $run = $null
  for ($attempt = 0; $attempt -lt 30 -and $null -eq $run; $attempt += 1) {
    Start-Sleep -Seconds 2
    $runs = @()
    $parsedRuns = ConvertFrom-Json (Invoke-Captured gh run list --repo $script:BuildRepo --workflow release-build.yml --limit 30 --json 'databaseId,headSha,headBranch,status,conclusion,url,createdAt')
    foreach ($parsedRun in $parsedRuns) { $runs += $parsedRun }
    $run = $runs | Where-Object { $_.headSha -eq $BuildSha } | Select-Object -First 1
  }
  if ($null -eq $run) { throw "Could not find Release Build run for $BuildSha" }
  Write-Info "workflow run: $($run.url)"
  Invoke-Checked gh run watch ([string]$run.databaseId) --repo $script:BuildRepo --exit-status
  $completed = ConvertFrom-Json (Invoke-Captured gh run view ([string]$run.databaseId) --repo $script:BuildRepo --json 'databaseId,headSha,status,conclusion,url')
  if ($completed.headSha -ne $BuildSha -or $completed.conclusion -ne "success") {
    throw "Release Build did not complete successfully for the expected snapshot."
  }
  return $completed
}

function New-RemoteGroups($Config, [long] $RunId) {
  $groups = @()
  foreach ($hostProperty in (Get-Property $Config "sshHosts").PSObject.Properties) {
    $mirrors = @(@(Get-Property $Config "updateMirrors" @()) | Where-Object { [string]$_.sshHost -eq $hostProperty.Name })
    if ($mirrors.Count -eq 0) { continue }
    $hostConfig = $hostProperty.Value
    $payload = [ordered]@{
      buildRepo = $script:BuildRepo
      runId = $RunId
      version = $Version
      minimumVersion = $MinimumVersion
      mirrors = @($mirrors | ForEach-Object {
        [ordered]@{
          id = [string]$_.id
          publicBaseUrl = ([string]$_.publicBaseUrl).TrimEnd('/')
          remoteRoot = ([string]$_.remoteRoot).TrimEnd('/')
        }
      })
    }
    $json = $payload | ConvertTo-Json -Depth 20 -Compress
    $groups += [pscustomobject]@{
      Id = $hostProperty.Name
      Host = [string]$hostConfig.host
      Port = [int](Get-Property $hostConfig "port" 22)
      User = [string]$hostConfig.user
      IdentityFile = Resolve-IdentityFile ([string](Get-Property $hostConfig "identityFile" "")) "sshHosts.$($hostProperty.Name).identityFile"
      Target = "$([string]$hostConfig.user)@$([string]$hostConfig.host)"
      ConfigB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
      RemoteScript = "/tmp/gaoge-remote-release-$Version.py"
      Mirrors = $mirrors
    }
  }
  return @($groups)
}

function Invoke-RemoteReleaseAction($Group, [string] $Action, [string] $InputText = "") {
  $command = "python3 '$($Group.RemoteScript)' '$Action' --config-b64 '$($Group.ConfigB64)'"
  $identityArgument = if ([string]::IsNullOrWhiteSpace($Group.IdentityFile)) {
    ""
  } else {
    "-i `"$($Group.IdentityFile)`" "
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = "ssh"
  $startInfo.Arguments = "${identityArgument}-p $($Group.Port) -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o TCPKeepAlive=yes $($Group.Target) `"$command`""
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "Could not start SSH for remote $Action" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not [string]::IsNullOrEmpty($InputText)) { $process.StandardInput.WriteLine($InputText) }
  $process.StandardInput.Close()
  $process.WaitForExit()
  $stdout = $stdoutTask.Result.Trim()
  $stderr = $stderrTask.Result.Trim()
  if ($process.ExitCode -ne 0) {
    throw "Remote ${Action} failed on $($Group.Id): $stderr`n$stdout"
  }
  Write-Info "$($Group.Id) ${Action}: $stdout"
}

function Publish-RemoteArtifacts($Config, [long] $RunId) {
  Write-Step "Staging signed artifacts on update servers"
  $script:RemoteGroups = @(New-RemoteGroups $Config $RunId)
  $token = (Invoke-Captured gh auth token).Trim()
  $tokenB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($token))
  try {
    foreach ($group in $script:RemoteGroups) {
      $identityArguments = if ([string]::IsNullOrWhiteSpace($group.IdentityFile)) {
        @()
      } else {
        @("-i", $group.IdentityFile)
      }
      Invoke-Checked -FilePath scp -Arguments @($identityArguments + @(
        "-P", ([string]$group.Port),
        "-o", "BatchMode=yes",
        (Join-Path $PSScriptRoot "remote-release.py"),
        "$($group.Target):$($group.RemoteScript)"
      ))
      Invoke-RemoteReleaseAction $group "stage" $tokenB64
    }
  } finally {
    $token = $null
    $tokenB64 = $null
  }

  Write-Step "Promoting all update mirrors"
  try {
    foreach ($group in $script:RemoteGroups) {
      Invoke-RemoteReleaseAction $group "promote"
      $script:PromotedGroups += $group
    }
  } catch {
    foreach ($group in @($script:PromotedGroups)) {
      try { Invoke-RemoteReleaseAction $group "rollback" } catch { Write-Warning $_.Exception.Message }
    }
    throw
  }
}

function Get-StableDownloadAliases([string] $Platform) {
  switch ($Platform) {
    "win" { return @("Gaoge-Free-latest-windows-x64-setup.exe") }
    "mac" { return @("Gaoge-Free-latest-macos-universal.dmg") }
    "linux" { return @("Gaoge-Free-latest-linux-x86_64.AppImage", "Gaoge-Free-latest-linux-x86_64.deb") }
    default { throw "Unsupported download alias platform: $Platform" }
  }
}

function Test-PublicMirrors($Config) {
  Write-Step "Verifying public update mirrors"
  $cacheBust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $allowedArtifactHosts = @{}
  foreach ($configuredMirror in @(Get-Property $Config "updateMirrors" @())) {
    $configuredHost = ([Uri]([string]$configuredMirror.publicBaseUrl)).Host
    $allowedArtifactHosts[$configuredHost] = $true
  }
  foreach ($mirror in @(Get-Property $Config "updateMirrors" @())) {
    $base = ([string]$mirror.publicBaseUrl).TrimEnd('/')
    $expectedHost = ([Uri]$base).Host
    foreach ($platform in @("win", "mac", "linux")) {
      $url = "$base/$platform/latest.json?release=$cacheBust"
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 60 -Headers @{ "Cache-Control" = "no-cache" }
      if ([int]$response.StatusCode -ne 200) { throw "Bad update manifest HTTP status: $url" }
      $manifest = $response.Content | ConvertFrom-Json
      if ([string]$manifest.version -ne $Version) { throw "$url returned version $($manifest.version), expected $Version" }
      if ([string]$manifest.minimumVersion -ne $MinimumVersion) { throw "$url returned minimumVersion $($manifest.minimumVersion), expected $MinimumVersion" }
      foreach ($property in $manifest.platforms.PSObject.Properties) {
        $entryUrl = [Uri]$property.Value.url
        if (-not $allowedArtifactHosts.ContainsKey($entryUrl.Host)) {
          throw "$url contains an unmanaged artifact URL $entryUrl"
        }
        $separator = if ([string]::IsNullOrWhiteSpace($entryUrl.Query)) { "?" } else { "&" }
        $artifactCheckUrl = "$($entryUrl.AbsoluteUri)$separator`release=$cacheBust"
        try {
          $head = Invoke-WebRequest -Uri $artifactCheckUrl -Method Head -UseBasicParsing -TimeoutSec 90 -Headers @{ "Cache-Control" = "no-cache" }
        } catch {
          throw "Artifact verification failed: $artifactCheckUrl ($($_.Exception.Message))"
        }
        if ([int]$head.StatusCode -ne 200) { throw "Artifact is unavailable: $artifactCheckUrl" }
      }
      foreach ($alias in @(Get-StableDownloadAliases $platform)) {
        $aliasUrl = "$base/$platform/$alias`?release=$cacheBust"
        $aliasHead = Invoke-WebRequest -Uri $aliasUrl -Method Head -UseBasicParsing -TimeoutSec 90 -Headers @{ "Cache-Control" = "no-cache" }
        if ([int]$aliasHead.StatusCode -ne 200) { throw "Stable download alias is unavailable: $aliasUrl" }
        $contentLength = 0L
        if (-not [long]::TryParse([string]$aliasHead.Headers["Content-Length"], [ref]$contentLength) -or $contentLength -le 0) {
          throw "Stable download alias is empty or has no Content-Length: $aliasUrl"
        }
      }
      Write-Info "OK $url"
    }
  }
}

function Cleanup-RemoteGroups {
  foreach ($group in @($script:RemoteGroups)) {
    try {
      Invoke-RemoteReleaseAction $group "cleanup"
      $identityArguments = if ([string]::IsNullOrWhiteSpace($group.IdentityFile)) {
        @()
      } else {
        @("-i", $group.IdentityFile)
      }
      & ssh @identityArguments -p $group.Port -o BatchMode=yes $group.Target "rm -f '$($group.RemoteScript)'" 2>$null
    } catch { Write-Warning "Remote cleanup failed on $($group.Id): $($_.Exception.Message)" }
  }
}

function Restore-BuildRepoPrivacy {
  if (-not $script:BuildRepoTouched -or [string]::IsNullOrWhiteSpace($script:BuildRepo)) { return }
  # A release must not report success until GitHub confirms the final privacy.
  Set-BuildRepoVisibility "private"
}

trap {
  $releaseFailure = $_
  foreach ($group in @($script:PromotedGroups)) {
    try { Invoke-RemoteReleaseAction $group "rollback" } catch { Write-Warning $_.Exception.Message }
  }
  $privacyFailure = ""
  try { Restore-BuildRepoPrivacy } catch { $privacyFailure = $_.Exception.Message }
  Cleanup-RemoteGroups
  if (-not [string]::IsNullOrWhiteSpace($privacyFailure)) {
    throw "Release failed: $($releaseFailure.Exception.Message) Build repository privacy could not be confirmed: $privacyFailure"
  }
  throw $releaseFailure
}

Set-Location $script:Root
Assert-VersionOrder
$config = Read-ReleaseConfig
$script:BuildRepo = [string]$config.buildRepo
$sourceBranch = [string](Get-Property $config "sourceBranch" "main")
$buildBranch = [string](Get-Property $config "buildBranch" "master")
$tagName = "v$Version"

foreach ($command in @("git", "gh", "node", "npm", "cargo", "ssh", "scp", "python")) { Require-Command $command }

Write-Step "Checking source repository"
$branch = (Invoke-Captured git branch --show-current).Trim()
if ($branch -ne $sourceBranch) { throw "Expected branch $sourceBranch, got $branch" }
Invoke-Checked git fetch origin $sourceBranch --tags
$head = (Invoke-Captured git rev-parse HEAD).Trim()
$originHead = (Invoke-Captured git rev-parse "origin/$sourceBranch").Trim()
if ($head -ne $originHead) { throw "Local HEAD is not aligned with origin/$sourceBranch" }
$status = (Invoke-Captured git status --short)
if (-not [string]::IsNullOrWhiteSpace($status)) { throw "Working tree must be clean before release.`n$status" }

$remoteSourceTag = Get-RemoteTagSha "origin" $tagName
if (-not [string]::IsNullOrWhiteSpace($remoteSourceTag)) {
  # A successful check of newer local code cannot approve an older release tag.
  $verificationSourceChanges = Invoke-Captured git diff --name-only $remoteSourceTag HEAD -- src-tauri/src scripts package.json package-lock.json
  if (-not [string]::IsNullOrWhiteSpace($verificationSourceChanges)) {
    throw "Existing release $tagName differs from the code being verified. Resume from matching release source or create a new version.`n$verificationSourceChanges"
  }
}
$sourceRefForVerification = if ([string]::IsNullOrWhiteSpace($remoteSourceTag)) { "HEAD" } else { $tagName }
Assert-PublicSourceRelease $sourceRefForVerification

Write-Step "Verifying native Fast module compatibility against the currently installed Codex"
Invoke-Checked npm run verify:codex-native-fast-installed
Write-Step "Verifying Ultra against the currently installed Codex (required on every release and resume)"
Invoke-Checked npm run verify:codex-ultra-installed
Write-Step "Verifying API coding mode against the currently installed Codex"
Invoke-Checked npm run verify:codex-api-mode-installed

Test-BootstrapDirectories $config
Assert-BuildSecrets $script:BuildRepo

if ([string]::IsNullOrWhiteSpace($remoteSourceTag)) {
  Assert-SourceVersionMatches
  Write-Step "Running release verification"
  Invoke-Checked npm run verify:local
  Invoke-Checked cargo test --locked --manifest-path src-tauri/Cargo.toml
  Invoke-Checked git diff --check
  $postVerificationStatus = Invoke-Captured git status --short
  if (-not [string]::IsNullOrWhiteSpace($postVerificationStatus)) {
    throw "Verification changed source files; review, commit and republish corresponding source before release."
  }
  Invoke-Checked git tag $tagName
  Invoke-Checked git push origin $tagName
  $releaseSha = (Invoke-Captured git rev-parse HEAD).Trim()
} else {
  Write-Step "Resuming existing source release $tagName"
  Invoke-Checked git fetch origin "refs/tags/$tagName`:refs/tags/$tagName"
  $releaseSha = (Invoke-Captured git rev-list -n 1 $tagName).Trim()
  $packageAtTag = Invoke-Captured git show "$tagName`:package.json"
  if ([string]::IsNullOrWhiteSpace($packageAtTag) -or ($packageAtTag | ConvertFrom-Json).version -ne $Version) {
    throw "Existing source tag $tagName does not contain version $Version"
  }
}
Write-Info "release commit: $releaseSha"

$bootstrapValue = (@(Get-Property $config "bootstrapConfigUrls" @()) -join ',')
$primaryUpdateBase = ([string](@(Get-Property $config "updateMirrors" @())[0].publicBaseUrl)).TrimEnd('/')
Invoke-Checked gh variable set VITE_GAOGE_BOOTSTRAP_CONFIG_URLS --body $bootstrapValue --repo $script:BuildRepo
Invoke-Checked gh variable set GAOGE_UPDATE_BASE_URL --body $primaryUpdateBase --repo $script:BuildRepo
Invoke-Checked gh variable set GAOGE_UPDATE_MINIMUM_VERSION --body $MinimumVersion --repo $script:BuildRepo

$remoteBuildTag = Get-RemoteTagSha "https://github.com/$($script:BuildRepo).git" $tagName
Initialize-BuildRepoVisibility
if ([string]::IsNullOrWhiteSpace($remoteBuildTag)) {
  $buildSha = Export-BuildSnapshot $tagName $buildBranch
} else {
  Write-Step "Reusing existing build tag $tagName"
  $buildSha = $remoteBuildTag
}

Assert-BuildMatchesPublicSource $buildSha
$run = Find-Or-RunWorkflow $buildSha $tagName
# Recheck source accessibility after the long build and before promotion.
Confirm-PublicSourceRelease
Assert-BuildMatchesPublicSource $buildSha
Publish-RemoteArtifacts $config ([long]$run.databaseId)
try {
  Test-PublicMirrors $config
} catch {
  foreach ($group in @($script:PromotedGroups)) {
    try { Invoke-RemoteReleaseAction $group "rollback" } catch { Write-Warning $_.Exception.Message }
  }
  throw
}

# Keep rollback state until final privacy has been confirmed.
Restore-BuildRepoPrivacy
$script:BuildRepoTouched = $false
Cleanup-RemoteGroups

Write-Step "Release complete"
[ordered]@{
  version = $Version
  minimumVersion = $MinimumVersion
  releaseCommit = $releaseSha
  tag = $tagName
  publicSourceRepository = $PublicSourceRepository
  publicSourceCommit = $script:PublicSourceVerification.publicCommit
  publicSourceUrl = "https://github.com/$PublicSourceRepository/tree/$tagName"
  buildRepository = $script:BuildRepo
  buildRepositoryVisibility = "private"
  privateBuild = [bool]$KeepBuildPrivate
  buildRun = $run.url
  mirrors = @(Get-Property $config "updateMirrors" @() | ForEach-Object { $_.publicBaseUrl })
} | ConvertTo-Json -Depth 10
