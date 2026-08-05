[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$LogicalName,
  [ValidateRange(1, 60000)][int]$ClaimTimeoutMs = 3000
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'EPSON OPOS for .NET requires Windows PowerShell 5.1.' }
$pointOfServicePath = 'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\Microsoft.PointOfService\v4.0_1.14.1.0__31bf3856ad364e35\Microsoft.PointOfService.dll'
if (-not (Test-Path -LiteralPath $pointOfServicePath)) { throw "Microsoft.PointOfService 1.14.1 was not found: $pointOfServicePath" }
Add-Type -Path $pointOfServicePath

$printer = $null
try {
  $explorer = [Microsoft.PointOfService.PosExplorer]::new()
  $device = $explorer.GetDevice('PosPrinter', $LogicalName)
  if ($null -eq $device) { throw "OPOS PosPrinter logical device '$LogicalName' was not found." }
  $printer = [Microsoft.PointOfService.PosPrinter]$explorer.CreateInstance($device)
  $printer.Open()
  $printer.Claim($ClaimTimeoutMs)
  $printer.DeviceEnabled = $true
  [pscustomobject]@{
    schemaVersion = 1
    adapter = 'windows-opos'
    logicalName = $LogicalName
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
  } | ConvertTo-Json -Depth 6 -Compress
} finally {
  if ($null -ne $printer) {
    try { $printer.DeviceEnabled = $false } catch {}
    try { $printer.Release() } catch {}
    try { $printer.Close() } catch {}
  }
}
