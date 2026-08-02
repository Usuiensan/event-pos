[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [Parameter(Mandatory = $true)][string]$Scenario
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

$printer = Get-Printer -Name $PrinterName -ErrorAction Stop |
  Select-Object Name, DriverName, PortName, PrinterStatus, WorkOffline, Shared, Published
$driver = Get-PrinterDriver -Name $printer.DriverName -ErrorAction Stop |
  Select-Object Name, MajorVersion, Manufacturer, DriverPath

$pnp = @()
if (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue) {
  $pnp = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -match 'EPSON|TM-T70II' -or $_.InstanceId -match 'EPSON|TM-T70II' } |
    Select-Object Status, Class, FriendlyName, InstanceId, Problem, ConfigManagerErrorCode)
}

$oposRoots = @(
  'HKLM:\SOFTWARE\OLEforRetail\ServiceOPOS',
  'HKLM:\SOFTWARE\WOW6432Node\OLEforRetail\ServiceOPOS',
  'HKCU:\SOFTWARE\OLEforRetail\ServiceOPOS'
)
$oposKeys = @()
foreach ($root in $oposRoots) {
  if (Test-Path $root) {
    $oposKeys += Get-ChildItem -Path $root -Recurse -ErrorAction SilentlyContinue |
      ForEach-Object { $_.Name }
  }
}
$oposHome = Join-Path ${env:ProgramFiles} 'epson\OPOS for .NET'
$oposT70iiComponent = Join-Path $oposHome 'Epson.opos.tm.service.T70II.dll'

[pscustomobject]@{
  schemaVersion = 1
  mode = 'status-only'
  scenario = $Scenario
  executedAt = (Get-Date).ToString('o')
  environment = @{
    platform = 'Windows'
    architecture = $env:PROCESSOR_ARCHITECTURE
    os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber)
  }
  adapter = @{
    name = 'Windows print queue observation only'
    printer = $printer
    driver = $driver
  }
  statusRequests = @(
    @{
      mechanism = 'Get-Printer coarse queue observation'
      raw = $printer
      normalized = 'unknown'
      reason = 'queue state alone is not device-ready proof'
    }
  )
  pnpDevices = $pnp
  opos = @{
    installed = (Test-Path $oposHome)
    t70iiServiceComponentInstalled = (Test-Path $oposT70iiComponent)
    logicalDeviceRegistryKeys = $oposKeys
    logicalDeviceConfigured = ($oposKeys.Count -gt 0)
    openOrClaimAttempted = $false
    reason = 'inventory only; no configured logical device is guessed or opened'
  }
  delivery = @{
    transportAccepted = $null
    physicalPaperCompleted = $null
    automaticRetry = $false
  }
} | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'windows-status-result.json')

Get-Content -Raw (Join-Path $EvidenceDir 'windows-status-result.json')
