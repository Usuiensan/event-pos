[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$PrinterName)

$ErrorActionPreference = 'Stop'
try {
  $printer = Get-Printer -Name $PrinterName -ErrorAction Stop |
    Select-Object Name, DriverName, PortName, PrinterStatus, WorkOffline
  $usb = @()
  $pnpAvailable = [bool](Get-Command Get-PnpDevice -ErrorAction SilentlyContinue)
  if ($pnpAvailable) {
    $usb = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Status -eq 'OK' -and
        ($_.InstanceId -match 'VID_04B8&PID_0202' -or ($_.Class -eq 'USB' -and $_.FriendlyName -match 'EPSON USB Controller'))
      } |
      Select-Object Status, Class, FriendlyName, InstanceId, Problem, ConfigManagerErrorCode)
  }
  $queueStatus = [int]$printer.PrinterStatus
  $offlineFlag = (($queueStatus -band 4096) -ne 0)
  $normalized = if (-not $pnpAvailable) { 'unknown' } elseif ($usb.Count -eq 0 -or $offlineFlag) { 'offline' } else { 'ready' }
  [pscustomobject]@{
    schemaVersion = 1
    normalized = $normalized
    printer = $printer
    usbControllerPresent = ($usb.Count -gt 0)
    usbDevices = $usb
    reason = if (-not $pnpAvailable) { 'Get-PnpDevice is unavailable' } elseif ($usb.Count -eq 0) { 'TM-T70II USB controller is absent' } elseif ($offlineFlag) { 'print queue reports offline' } else { $null }
  } | ConvertTo-Json -Depth 6 -Compress
} catch {
  [pscustomobject]@{
    schemaVersion = 1
    normalized = 'unknown'
    printerName = $PrinterName
    error = $_.Exception.Message
  } | ConvertTo-Json -Depth 4 -Compress
}
