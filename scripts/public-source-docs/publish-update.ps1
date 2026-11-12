param(
  [ValidateSet("win", "mac", "linux")]
  [string]$Platform = "win",
  [Parameter(Mandatory = $true)]
  [string]$Server,
  [int]$SshPort = 22,
  [string]$RemoteRoot = "/var/www/gaogeaii/updates",
  [string]$ReleaseDir = "",
  [switch]$AllowLegacyServer
)

$ErrorActionPreference = "Stop"

# Public source: the operator must explicitly supply the target host.
if ([string]::IsNullOrWhiteSpace($Server) -or $Server -notmatch '^[A-Za-z0-9_.@:-]+$') {
  throw "Supply a valid SSH target using -Server user@example-host."
}

if ([string]::IsNullOrWhiteSpace($ReleaseDir)) {
  $ReleaseDir = Join-Path $PSScriptRoot "..\release\$Platform"
}

$resolvedReleaseDir = Resolve-Path -LiteralPath $ReleaseDir
$latest = Join-Path $resolvedReleaseDir "latest.json"
$remoteDir = "$RemoteRoot/$Platform"
$artifactPatterns = @("*.exe", "*.dmg", "*.AppImage", "*.appimage", "*.deb", "*.rpm", "*.tar.gz")

if (-not (Test-Path -LiteralPath $latest)) {
  throw "Missing latest.json. Run npm run dist:$Platform first."
}

$artifacts = @()
foreach ($pattern in $artifactPatterns) {
  $artifacts += Get-ChildItem -LiteralPath $resolvedReleaseDir -Filter $pattern -File -ErrorAction SilentlyContinue
}
$artifacts = $artifacts | Sort-Object FullName -Unique

if (-not $artifacts -or $artifacts.Count -eq 0) {
  throw "Missing $Platform updater artifact. Run npm run dist:$Platform first."
}

$manifest = Get-Content -Raw -LiteralPath $latest | ConvertFrom-Json
$manifestUrls = @()
if ($manifest.platforms) {
  $manifestUrls = $manifest.platforms.PSObject.Properties |
    ForEach-Object { $_.Value.url } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
}
$manifestArtifactNames = $manifestUrls |
  ForEach-Object {
    $pathPart = ([Uri]$_).AbsolutePath
    [Uri]::UnescapeDataString([IO.Path]::GetFileName($pathPart))
  } |
  Sort-Object -Unique

$uploadFiles = @($latest)
foreach ($artifact in $artifacts) {
  $sig = "$($artifact.FullName).sig"
  $requiresSignature = $manifestArtifactNames -contains $artifact.Name
  if ($requiresSignature -and -not (Test-Path -LiteralPath $sig)) {
    throw "Missing updater artifact signature $sig. Run npm run dist:$Platform first."
  }
  $uploadFiles += $artifact.FullName
  if (Test-Path -LiteralPath $sig) {
    $uploadFiles += $sig
  }
}

$tempDir = "/tmp/gaogeaii-update-upload-$Platform"

& ssh -p $SshPort $Server "rm -rf '$tempDir' && mkdir -p '$tempDir'"
if ($LASTEXITCODE -ne 0) { throw "Failed to prepare remote temp directory." }

& scp -P $SshPort @uploadFiles "${Server}:$tempDir/"
if ($LASTEXITCODE -ne 0) { throw "Failed to upload update artifacts." }

& ssh -p $SshPort $Server "sudo mkdir -p '$remoteDir' && sudo cp '$tempDir'/* '$remoteDir'/ && sudo chown -R www-data:www-data /var/www/gaogeaii && sudo find /var/www/gaogeaii -type f -exec chmod 0644 {} \; && sudo find /var/www/gaogeaii -type d -exec chmod 0755 {} \; && rm -rf '$tempDir'"
if ($LASTEXITCODE -ne 0) { throw "Failed to publish update artifacts." }

Write-Host "Published $Platform update artifacts to remote path $remoteDir"
