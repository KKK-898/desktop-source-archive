param(
  [string]$ConfigPath = "",
  [string]$ReleaseDir = "",
  [string]$Server = "",
  [int]$SshPort = 22,
  [string]$RemoteRoot = "",
  [string]$PublicBaseUrl = "",
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $rootDir ".release.local.json"
}
if ([string]::IsNullOrWhiteSpace($ReleaseDir)) {
  $ReleaseDir = Join-Path $rootDir "release\themes"
}

$resolvedReleaseDir = (Resolve-Path -LiteralPath $ReleaseDir).Path
$catalogPath = Join-Path $resolvedReleaseDir "catalog.json"
$packagePath = Join-Path $resolvedReleaseDir "packages"
$previewPath = Join-Path $resolvedReleaseDir "previews"

if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
  throw "Missing themes/catalog.json. Run npm run themes:build first."
}
if (-not (Test-Path -LiteralPath $packagePath -PathType Container)) {
  throw "Missing themes/packages directory."
}
if (-not (Test-Path -LiteralPath $previewPath -PathType Container)) {
  throw "Missing themes/previews directory."
}

function Assert-SafeRemoteRoot {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value) -or -not $Value.StartsWith("/")) {
    throw "Theme remoteRoot must be an absolute Linux path."
  }
  if ($Value -eq "/" -or $Value -notmatch "^/[A-Za-z0-9._/-]+$" -or $Value.Contains("..")) {
    throw "Theme remoteRoot contains unsafe characters: $Value"
  }
}

function Assert-SafeSshValue {
  param(
    [string]$Value,
    [string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch "^[A-Za-z0-9._:@-]+$") {
    throw "$Label contains unsafe characters."
  }
}

function Normalize-PublicBaseUrl {
  param([string]$Value)

  $parsed = $null
  if (
    [string]::IsNullOrWhiteSpace($Value) -or
    -not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed) -or
    $parsed.Scheme -ne "https"
  ) {
    throw "Theme publicBaseUrl must be an absolute HTTPS URL."
  }
  return $Value.TrimEnd("/")
}

function Resolve-IdentityFile {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }
  $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim())
  if ($expanded.StartsWith("~/") -or $expanded.StartsWith("~\")) {
    $expanded = Join-Path $HOME $expanded.Substring(2)
  }
  if (-not (Test-Path -LiteralPath $expanded -PathType Leaf)) {
    throw "SSH identity file does not exist: $expanded"
  }
  return (Resolve-Path -LiteralPath $expanded).Path
}

function Read-PublishTargets {
  if (-not [string]::IsNullOrWhiteSpace($Server)) {
    Assert-SafeSshValue $Server "Server"
    Assert-SafeRemoteRoot $RemoteRoot
    return @([pscustomobject]@{
      Id = "manual"
      Server = $Server
      Port = $SshPort
      IdentityFile = ""
      RemoteRoot = $RemoteRoot.TrimEnd("/")
      PublicBaseUrl = Normalize-PublicBaseUrl $PublicBaseUrl
    })
  }

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Missing release configuration: $ConfigPath"
  }
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $mirrors = @($config.updateMirrors)
  if ($mirrors.Count -eq 0) {
    throw "Release configuration does not contain updateMirrors."
  }

  $targets = @()
  foreach ($mirror in $mirrors) {
    $hostProperty = $config.sshHosts.PSObject.Properties |
      Where-Object { $_.Name -eq [string]$mirror.sshHost } |
      Select-Object -First 1
    if ($null -eq $hostProperty) {
      throw "Mirror $($mirror.id) references unknown SSH host $($mirror.sshHost)."
    }

    $hostConfig = $hostProperty.Value
    Assert-SafeSshValue ([string]$hostConfig.user) "SSH user"
    Assert-SafeSshValue ([string]$hostConfig.host) "SSH host"
    Assert-SafeRemoteRoot ([string]$mirror.remoteRoot)
    $port = [int]$hostConfig.port
    if ($port -lt 1 -or $port -gt 65535) {
      throw "Mirror $($mirror.id) has an invalid SSH port."
    }

    $targets += [pscustomobject]@{
      Id = [string]$mirror.id
      Server = "$($hostConfig.user)@$($hostConfig.host)"
      Port = $port
      IdentityFile = Resolve-IdentityFile ([string]$hostConfig.identityFile)
      RemoteRoot = ([string]$mirror.remoteRoot).TrimEnd("/")
      PublicBaseUrl = Normalize-PublicBaseUrl ([string]$mirror.publicBaseUrl)
    }
  }
  return $targets
}

function Invoke-CheckedNativeCommand {
  param(
    [string]$Program,
    [string[]]$Arguments,
    [string]$FailureMessage
  )

  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

function Get-CacheBustedUrl {
  param([string]$Url)

  $separator = if ($Url.Contains("?")) { "&" } else { "?" }
  return "$Url${separator}gaoge_theme_verify=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
}

function Assert-RemoteContentType {
  param(
    [string]$Url,
    [string]$ExpectedPattern,
    [string]$Label
  )

  $response = Invoke-WebRequest `
    -UseBasicParsing `
    -Method Head `
    -TimeoutSec 30 `
    -Uri (Get-CacheBustedUrl $Url)
  $contentType = [string]$response.Headers["Content-Type"]
  if ($contentType -notmatch $ExpectedPattern) {
    throw "$Label returned invalid Content-Type '$contentType'."
  }
}

function Assert-RemoteThemeResources {
  param(
    [pscustomobject]$Target,
    [object]$LocalCatalog
  )

  $themeBaseUrl = "$($Target.PublicBaseUrl)/themes/"
  $verifyDir = Join-Path ([IO.Path]::GetTempPath()) "gaoge-theme-verify-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $verifyDir | Out-Null
  try {
    $remoteCatalogPath = Join-Path $verifyDir "catalog.json"
    Assert-RemoteContentType "${themeBaseUrl}catalog.json" "^application/(?:json|[^;]+\+json)(?:;|$)" "Remote theme catalog"
    Invoke-WebRequest `
      -UseBasicParsing `
      -TimeoutSec 30 `
      -Uri (Get-CacheBustedUrl "${themeBaseUrl}catalog.json") `
      -OutFile $remoteCatalogPath

    $localCatalogHash = (Get-FileHash -LiteralPath $catalogPath -Algorithm SHA256).Hash
    $remoteCatalogHash = (Get-FileHash -LiteralPath $remoteCatalogPath -Algorithm SHA256).Hash
    if ($localCatalogHash -ne $remoteCatalogHash) {
      throw "Remote catalog hash does not match the local release."
    }

    $remoteCatalog = Get-Content -LiteralPath $remoteCatalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($remoteCatalog.themes).Count -ne @($LocalCatalog.themes).Count) {
      throw "Remote catalog theme count is incorrect."
    }

    foreach ($theme in @($remoteCatalog.themes)) {
      $remoteZipPath = Join-Path $verifyDir "$($theme.id).zip"
      $zipUrl = [Uri]::new([Uri]$themeBaseUrl, [string]$theme.package).AbsoluteUri
      Assert-RemoteContentType $zipUrl "^(?:application/(?:zip|x-zip-compressed|octet-stream))(?:;|$)" "Theme package $($theme.id)"
      Invoke-WebRequest `
        -UseBasicParsing `
        -TimeoutSec 60 `
        -Uri (Get-CacheBustedUrl $zipUrl) `
        -OutFile $remoteZipPath
      $remoteZipHash = (Get-FileHash -LiteralPath $remoteZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($remoteZipHash -ne ([string]$theme.sha256).ToLowerInvariant()) {
        throw "Remote package hash mismatch for theme $($theme.id)."
      }
      if ((Get-Item -LiteralPath $remoteZipPath).Length -ne [long]$theme.sizeBytes) {
        throw "Remote package size mismatch for theme $($theme.id)."
      }

      $remotePreviewPath = Join-Path $verifyDir "$($theme.id).webp"
      $previewUrl = [Uri]::new([Uri]$themeBaseUrl, [string]$theme.preview).AbsoluteUri
      Assert-RemoteContentType $previewUrl "^image/webp(?:;|$)" "Theme preview $($theme.id)"
      Invoke-WebRequest `
        -UseBasicParsing `
        -TimeoutSec 30 `
        -Uri (Get-CacheBustedUrl $previewUrl) `
        -OutFile $remotePreviewPath
      $localPreviewPath = Join-Path $resolvedReleaseDir ([string]$theme.preview).Replace("/", "\")
      if (
        (Get-FileHash -LiteralPath $localPreviewPath -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $remotePreviewPath -Algorithm SHA256).Hash
      ) {
        throw "Remote preview hash mismatch for theme $($theme.id)."
      }
    }
  }
  finally {
    Remove-Item -LiteralPath $verifyDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Publish-ThemeMirror {
  param(
    [pscustomobject]$Target,
    [object]$LocalCatalog
  )

  $uploadId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $remoteTemp = "/tmp/gaoge-codex-themes-$uploadId"
  $remoteThemeDir = "$($Target.RemoteRoot)/themes"
  $identityArguments = if ([string]::IsNullOrWhiteSpace($Target.IdentityFile)) {
    @()
  } else {
    @("-i", $Target.IdentityFile)
  }

  Write-Host "Publishing themes to mirror $($Target.Id)..."
  Invoke-CheckedNativeCommand "ssh" @($identityArguments + @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-p", [string]$Target.Port,
    $Target.Server,
    "rm -rf '$remoteTemp' && mkdir -p '$remoteTemp'"
  )) "Failed to prepare theme upload directory for mirror $($Target.Id)."

  Invoke-CheckedNativeCommand "scp" @($identityArguments + @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-P", [string]$Target.Port,
    "-r",
    $catalogPath,
    $packagePath,
    $previewPath,
    "$($Target.Server):$remoteTemp/"
  )) "Failed to upload theme resources to mirror $($Target.Id)."

  $remoteCommand = @"
set -eu
test -f '$remoteTemp/catalog.json'
test -d '$remoteTemp/packages'
test -d '$remoteTemp/previews'
sudo mkdir -p '$($Target.RemoteRoot)'
sudo rm -rf '${remoteThemeDir}.next'
sudo rm -rf '${remoteThemeDir}.previous'
sudo mv '$remoteTemp' '${remoteThemeDir}.next'
if [ -d '$remoteThemeDir' ]; then
  sudo mv '$remoteThemeDir' '${remoteThemeDir}.previous'
fi
sudo mv '${remoteThemeDir}.next' '$remoteThemeDir'
sudo rm -rf '${remoteThemeDir}.previous'
sudo chown -R www-data:www-data '$remoteThemeDir'
sudo find '$remoteThemeDir' -type f -exec chmod 0644 {} \;
sudo find '$remoteThemeDir' -type d -exec chmod 0755 {} \;
"@

  Invoke-CheckedNativeCommand "ssh" @($identityArguments + @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-p", [string]$Target.Port,
    $Target.Server,
    $remoteCommand
  )) "Failed to publish theme resources on mirror $($Target.Id)."

  Assert-RemoteThemeResources $Target $LocalCatalog
  Write-Host "Verified theme mirror $($Target.Id): $($Target.PublicBaseUrl)/themes/catalog.json"
}

Invoke-CheckedNativeCommand "npm" @("run", "themes:verify") "Local theme package verification failed."
$localCatalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$targets = @(Read-PublishTargets)
if ($ValidateOnly) {
  Write-Host "Validated $($localCatalog.themes.Count) Codex themes and $($targets.Count) configured mirror(s)."
  exit 0
}
$failures = @()
foreach ($target in $targets) {
  try {
    Publish-ThemeMirror $target $localCatalog
  }
  catch {
    $failures += "$($target.Id): $($_.Exception.Message)"
    Write-Warning "Theme mirror $($target.Id) failed verification; continuing with the remaining mirrors."
  }
}
if ($failures.Count -gt 0) {
  throw "Theme publishing was incomplete:`n$($failures -join "`n")"
}

Write-Host "Published and verified $($localCatalog.themes.Count) Codex themes on $($targets.Count) mirror(s)."
