[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$LogicalName,
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [ValidateRange(1, 60000)][int]$ClaimTimeoutMs = 3000,
  [switch]$EnableDevice,
  [switch]$Run
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') {
  throw 'EPSON OPOS for .NET requires Windows PowerShell 5.1 (.NET Framework). Run this script with powershell.exe, not pwsh.exe.'
}
if (-not $Run) {
  throw 'OPOS Open/Claim requires explicit -Run; no device operation was performed.'
}

New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$pointOfServicePath = 'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\Microsoft.PointOfService\v4.0_1.14.1.0__31bf3856ad364e35\Microsoft.PointOfService.dll'
if (-not (Test-Path $pointOfServicePath)) {
  throw "Microsoft.PointOfService 1.14.1 was not found at $pointOfServicePath"
}
Add-Type -Path $pointOfServicePath

function Get-ExceptionDetails([Exception]$Exception) {
  if ($null -eq $Exception) { return $null }
  return [ordered]@{
    type = $Exception.GetType().FullName
    message = $Exception.Message
    inner = Get-ExceptionDetails $Exception.InnerException
  }
}

$record = [ordered]@{
  schemaVersion = 1
  mode = 'OPOS status-only'
  executedAt = (Get-Date).ToString('o')
  environment = @{
    platform = 'Windows'
    architecture = $env:PROCESSOR_ARCHITECTURE
    os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber)
  }
  opos = @{
    logicalName = $LogicalName
    api = 'Microsoft.PointOfService PosExplorer / PosPrinter'
    claimTimeoutMs = $ClaimTimeoutMs
    deviceEnable = @{ requested = $EnableDevice.IsPresent; completed = $false; cleanupCompleted = $false }
    open = @{ attempted = $false; completed = $false; elapsedMs = $null }
    claim = @{ attempted = $false; completed = $false; elapsedMs = $null }
    properties = $null
    release = @{ attempted = $false; completed = $false }
    close = @{ attempted = $false; completed = $false }
  }
  delivery = @{ transportAccepted = $null; physicalPaperCompleted = $null; automaticRetry = $false }
  exception = $null
}

$printer = $null
try {
  $explorer = [Microsoft.PointOfService.PosExplorer]::new()
  $device = $explorer.GetDevice('PosPrinter', $LogicalName)
  if ($null -eq $device) { throw "OPOS PosPrinter logical device '$LogicalName' was not found." }
  $printer = [Microsoft.PointOfService.PosPrinter]$explorer.CreateInstance($device)

  $record.opos.open.attempted = $true
  $openStart = [Diagnostics.Stopwatch]::StartNew()
  $printer.Open()
  $openStart.Stop()
  $record.opos.open.completed = $true
  $record.opos.open.elapsedMs = $openStart.ElapsedMilliseconds

  $record.opos.claim.attempted = $true
  $claimStart = [Diagnostics.Stopwatch]::StartNew()
  $printer.Claim($ClaimTimeoutMs)
  $claimStart.Stop()
  $record.opos.claim.completed = $true
  $record.opos.claim.elapsedMs = $claimStart.ElapsedMilliseconds

  if ($EnableDevice) {
    $printer.DeviceEnabled = $true
    $record.opos.deviceEnable.completed = $true
  }

  $record.opos.properties = [ordered]@{
    state = $printer.State.ToString()
    claimed = $printer.Claimed
    deviceEnabled = $printer.DeviceEnabled
    coverOpen = $printer.CoverOpen
    receiptEmpty = $printer.RecEmpty
    receiptNearEnd = $printer.RecNearEnd
    errorLevel = $printer.ErrorLevel.ToString()
    errorStation = $printer.ErrorStation.ToString()
    errorString = $printer.ErrorString
    powerState = $printer.PowerState.ToString()
    capCoverSensor = $printer.CapCoverSensor
    capRecEmptySensor = $printer.CapRecEmptySensor
    capRecNearEndSensor = $printer.CapRecNearEndSensor
    capPowerReporting = $printer.CapPowerReporting
  }
} catch {
  $record.exception = Get-ExceptionDetails $_.Exception
} finally {
  if ($null -ne $printer) {
    if ($record.opos.deviceEnable.completed) {
      try { $printer.DeviceEnabled = $false; $record.opos.deviceEnable.cleanupCompleted = $true } catch { if ($null -eq $record.exception) { $record.exception = Get-ExceptionDetails $_.Exception } }
    }
    if ($record.opos.claim.completed) {
      $record.opos.release.attempted = $true
      try { $printer.Release(); $record.opos.release.completed = $true } catch { if ($null -eq $record.exception) { $record.exception = Get-ExceptionDetails $_.Exception } }
    }
    if ($record.opos.open.completed) {
      $record.opos.close.attempted = $true
      try { $printer.Close(); $record.opos.close.completed = $true } catch { if ($null -eq $record.exception) { $record.exception = Get-ExceptionDetails $_.Exception } }
    }
  }
}

$resultPath = Join-Path $EvidenceDir 'windows-opos-status-result.json'
$record | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $resultPath
Get-Content -Raw $resultPath
if ($null -ne $record.exception -or -not $record.opos.claim.completed) { exit 1 }
