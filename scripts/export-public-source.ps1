param(
  [string] $Ref = "HEAD",
  [Parameter(Mandatory = $true)] [string] $OutputDirectory,
  [string] $ArchivePath = "",
  [switch] $WorkingTree,
  [switch] $ReviewOnly,
  [switch] $DevelopmentSnapshot,
  [string] $PrivacyMaintenanceBaseline = ""
)
$ErrorActionPreference = "Stop"
$arguments = @((Join-Path $PSScriptRoot "export_public_source.py"), "--ref", $Ref, "--output-directory", $OutputDirectory)
if ($WorkingTree) { $arguments += "--working-tree" }
if ($ReviewOnly) { $arguments += "--review-only" }
if ($DevelopmentSnapshot) { $arguments += "--development-snapshot" }
if ($PSBoundParameters.ContainsKey("PrivacyMaintenanceBaseline")) { $arguments += @("--privacy-maintenance-baseline", $PrivacyMaintenanceBaseline) }
if ($ArchivePath) { $arguments += @("--archive-path", $ArchivePath) }
& python @arguments
if ($LASTEXITCODE -ne 0) { throw "Reviewed source export failed (exit $LASTEXITCODE). No publishing is authorized." }
