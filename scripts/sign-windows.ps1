param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[windows-sign] $Message"
}

function Find-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path -LiteralPath $kitsRoot) {
    $candidate = Get-ChildItem -LiteralPath $kitsRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
      Sort-Object FullName -Descending |
      Select-Object -First 1

    if ($candidate) {
      return $candidate.FullName
    }
  }

  throw "signtool.exe was not found. Install the Windows SDK or add signtool.exe to PATH."
}

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

function Test-Truthy {
  param([string]$Value)
  return $Value -match "^(1|true|yes|on)$"
}

$resolvedFile = (Resolve-Path -LiteralPath $FilePath).Path
$required = Test-Truthy $env:GAOGE_WINDOWS_SIGNING_REQUIRED
$timestampUrl = if ($env:GAOGE_WINDOWS_TIMESTAMP_URL) {
  $env:GAOGE_WINDOWS_TIMESTAMP_URL
} else {
  "http://timestamp.digicert.com"
}

$pfxPath = $env:GAOGE_WINDOWS_PFX_PATH
$pfxPassword = $env:GAOGE_WINDOWS_PFX_PASSWORD
$thumbprint = $env:GAOGE_WINDOWS_CERTIFICATE_THUMBPRINT

if (!$pfxPath -and $env:GAOGE_WINDOWS_PFX_BASE64) {
  $tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
  $pfxPath = Join-Path $tempRoot "gaoge-windows-code-signing.pfx"
  [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:GAOGE_WINDOWS_PFX_BASE64))
}

if (!$pfxPath -and !$thumbprint) {
  $message = "No Windows code signing certificate configured for $resolvedFile. Set GAOGE_WINDOWS_PFX_BASE64/GAOGE_WINDOWS_PFX_PASSWORD or GAOGE_WINDOWS_CERTIFICATE_THUMBPRINT."
  if ($required) {
    throw $message
  }

  Write-Step "$message Skipping because GAOGE_WINDOWS_SIGNING_REQUIRED is not enabled."
  exit 0
}

$signtool = Find-SignTool
$signArgs = @("sign", "/fd", "SHA256", "/tr", $timestampUrl, "/td", "SHA256", "/v")

if ($pfxPath) {
  if (!(Test-Path -LiteralPath $pfxPath)) {
    throw "Configured PFX file does not exist: $pfxPath"
  }
  if (!$pfxPassword) {
    throw "GAOGE_WINDOWS_PFX_PASSWORD is required when signing with a PFX certificate."
  }
  $signArgs += @("/f", $pfxPath, "/p", $pfxPassword)
} else {
  $signArgs += @("/sha1", ($thumbprint -replace "\s", ""))
}

$signArgs += $resolvedFile

Write-Step "Signing $resolvedFile"
Invoke-Checked $signtool $signArgs

Write-Step "Verifying Authenticode signature for $resolvedFile"
Invoke-Checked $signtool @("verify", "/pa", "/v", $resolvedFile)
