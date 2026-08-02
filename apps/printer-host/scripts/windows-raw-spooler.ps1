[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$DocumentName
)

$ErrorActionPreference = 'Stop'
if (-not ('EventPosRawSpooler' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EventPosRawSpooler {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOC_INFO_1 { public string pDocName; public string pOutputFile; public string pDatatype; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int StartDocPrinter(IntPtr handle, int level, DOC_INFO_1 info);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
}
'@
}

[IntPtr]$handle = [IntPtr]::Zero
$docStarted = $false
try {
  if (-not [EventPosRawSpooler]::OpenPrinter($PrinterName, [ref]$handle, [IntPtr]::Zero)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  $info = [EventPosRawSpooler+DOC_INFO_1]::new(); $info.pDocName = $DocumentName; $info.pDatatype = 'RAW'
  $jobId = [EventPosRawSpooler]::StartDocPrinter($handle, 1, $info); if ($jobId -eq 0) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }; $docStarted = $true
  if (-not [EventPosRawSpooler]::StartPagePrinter($handle)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  [byte[]]$bytes = [IO.File]::ReadAllBytes($Path); [int]$written = 0
  if (-not [EventPosRawSpooler]::WritePrinter($handle, $bytes, $bytes.Length, [ref]$written)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  if (-not [EventPosRawSpooler]::EndPagePrinter($handle)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  if (-not [EventPosRawSpooler]::EndDocPrinter($handle)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }; $docStarted = $false
  # WritePrinter returning true does not by itself prove that every requested byte was
  # accepted.  Do not retry a short write: the printer may already have consumed a prefix.
  [pscustomobject]@{
    spoolerJobId = $jobId
    requestedBytes = $bytes.Length
    acceptedBytes = $written
    writeComplete = ($written -eq $bytes.Length)
    api = 'Winspool RAW WritePrinter'
  } | ConvertTo-Json -Compress
} finally {
  if ($docStarted -and $handle -ne [IntPtr]::Zero) { [void][EventPosRawSpooler]::EndDocPrinter($handle) }
  if ($handle -ne [IntPtr]::Zero) { [void][EventPosRawSpooler]::ClosePrinter($handle) }
}
