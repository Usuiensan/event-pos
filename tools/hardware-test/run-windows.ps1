[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [switch]$Run
)

$ErrorActionPreference = 'Stop'
$env:PRINTER_EVIDENCE_DIR = $EvidenceDir
pnpm --filter @event-pos/printer-host hardware-test
if ($Run) {
  # The common CLI deliberately has no Windows direct-send mode. The bundled Winspool adapter
  # is run below so the result remains bounded to the fixed fixture.bin.
  $fixture = Join-Path $EvidenceDir 'fixture.bin'
  $script = Join-Path $PSScriptRoot '..\..\apps\printer-host\scripts\windows-raw-spooler.ps1'
  $raw = & $script -PrinterName $PrinterName -Path $fixture -DocumentName 'event-pos TM-T70II parity probe' | ConvertFrom-Json
  $printer = Get-Printer -Name $PrinterName | Select-Object Name, DriverName, PortName, PrinterStatus, WorkOffline
  $driver = Get-PrinterDriver -Name $printer.DriverName | Select-Object Name, MajorVersion, Manufacturer
  [pscustomobject]@{
    schemaVersion = 1; mode = 'run'; executedAt = (Get-Date).ToString('o')
    environment = @{ platform = 'Windows'; architecture = $env:PROCESSOR_ARCHITECTURE; os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber) }
    adapter = @{ name = 'Winspool RAW WritePrinter'; printer = $printer; driver = $driver; spoolerJobId = $raw.spoolerJobId; timeoutMs = $null; mutex = 'hardware probe process only; PrinterHost mutex is not exercised' }
    writes = @(@{ offset = 0; bytesWritten = $raw.acceptedBytes; errno = $null })
    statusBefore = 'unknown'; statusAfter = 'unknown'; statusRequests = @(@{ mechanism = 'Get-Printer coarse queue observation'; raw = $printer; normalized = 'unknown'; reason = 'queue state alone is not device-ready proof' })
    delivery = @{ transportAccepted = ($raw.acceptedBytes -eq (Get-Item $fixture).Length); physicalPaperCompleted = $null; automaticRetry = $false }
    physicalPaperEvidenceId = $null
  } | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'windows-spooler-result.json')
}
