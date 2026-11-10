[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$VendorId,
  [Parameter(Mandatory = $true)][int]$ProductId,
  [string]$SerialNumber,
  [Parameter(Mandatory = $true)][int]$TimeoutMs
)

$ErrorActionPreference = 'Stop'
if (-not ('EventPosDleEot' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class EventPosDleEot {
  static readonly Guid UsbPrint = new Guid("28d78fad-5a12-11d1-ae5b-0000f803a8c2");
  const uint DIGCF_PRESENT = 2, DIGCF_DEVICEINTERFACE = 16, ERROR_NO_MORE_ITEMS = 259, ERROR_INSUFFICIENT_BUFFER = 122;
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3, FILE_FLAG_OVERLAPPED = 0x40000000;
  const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258, ERROR_IO_PENDING = 997;
  [StructLayout(LayoutKind.Sequential)] struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct OVERLAPPED { public IntPtr Internal; public IntPtr InternalHigh; public int Offset; public int OffsetHigh; public IntPtr hEvent; }
  [DllImport("setupapi.dll", SetLastError=true)] static extern IntPtr SetupDiGetClassDevs(ref Guid ClassGuid, IntPtr Enumerator, IntPtr hwndParent, uint Flags);
  [DllImport("setupapi.dll", SetLastError=true)] static extern bool SetupDiEnumDeviceInterfaces(IntPtr DeviceInfoSet, IntPtr DeviceInfoData, ref Guid InterfaceClassGuid, uint MemberIndex, ref SP_DEVICE_INTERFACE_DATA DeviceInterfaceData);
  [DllImport("setupapi.dll", SetLastError=true)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr DeviceInfoSet, ref SP_DEVICE_INTERFACE_DATA DeviceInterfaceData, IntPtr DeviceInterfaceDetailData, int DeviceInterfaceDetailDataSize, out int RequiredSize, ref SP_DEVINFO_DATA DeviceInfoData);
  [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetupDiGetDeviceInstanceId(IntPtr DeviceInfoSet, ref SP_DEVINFO_DATA DeviceInfoData, StringBuilder DeviceInstanceId, int DeviceInstanceIdSize, out int RequiredSize);
  [DllImport("setupapi.dll", SetLastError=true)] static extern bool SetupDiDestroyDeviceInfoList(IntPtr DeviceInfoSet);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle, byte[] buffer, int count, IntPtr written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr handle, byte[] buffer, int count, IntPtr read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ResetEvent(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetOverlappedResult(IntPtr handle, IntPtr overlapped, out int transferred, bool wait);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CancelIo(IntPtr handle);

  public static string FindDevice(int vendorId, int productId, string serialNumber, out string error) {
    error = null; IntPtr set = SetupDiGetClassDevs(ref UsbPrint, IntPtr.Zero, IntPtr.Zero, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (set == IntPtr.Zero || set == new IntPtr(-1)) { error = new Win32Exception(Marshal.GetLastWin32Error()).Message; return null; }
    try {
      string needle = string.Format("VID_{0:X4}&PID_{1:X4}", vendorId, productId);
      for (uint index = 0; ; index++) {
        var iface = new SP_DEVICE_INTERFACE_DATA { cbSize = Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA)) };
        if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref UsbPrint, index, ref iface)) {
          if ((uint)Marshal.GetLastWin32Error() == ERROR_NO_MORE_ITEMS) break;
          continue;
        }
        int required; var info = new SP_DEVINFO_DATA { cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA)) };
        SetupDiGetDeviceInterfaceDetail(set, ref iface, IntPtr.Zero, 0, out required, ref info);
        if ((uint)Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER) continue;
        IntPtr detail = Marshal.AllocHGlobal(required);
        try {
          Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 4);
          if (!SetupDiGetDeviceInterfaceDetail(set, ref iface, detail, required, out required, ref info)) continue;
          string path = Marshal.PtrToStringUni(IntPtr.Add(detail, 4));
          var instance = new StringBuilder(1024); int instanceLength;
          if (!SetupDiGetDeviceInstanceId(set, ref info, instance, instance.Capacity, out instanceLength)) continue;
          if (instance.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;
          if (!string.IsNullOrEmpty(serialNumber) && instance.ToString().IndexOf(serialNumber, StringComparison.OrdinalIgnoreCase) < 0) continue;
          return path;
        } finally { Marshal.FreeHGlobal(detail); }
      }
      error = "指定したUSBPRINTデバイスが見つかりません"; return null;
    } finally { SetupDiDestroyDeviceInfoList(set); }
  }

  static IntPtr NewOverlapped() { IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(OVERLAPPED))); Marshal.StructureToPtr(new OVERLAPPED { hEvent = CreateEvent(IntPtr.Zero, true, false, null) }, p, false); return p; }
  static IntPtr EventOf(IntPtr p) { return Marshal.PtrToStructure<OVERLAPPED>(p).hEvent; }
  static void FreeOverlapped(IntPtr p) { var ov = Marshal.PtrToStructure<OVERLAPPED>(p); CloseHandle(ov.hEvent); Marshal.FreeHGlobal(p); }
  public static bool Write(IntPtr handle, byte[] bytes, out string error) {
    error = null; IntPtr ov = NewOverlapped(); try { if (!WriteFile(handle, bytes, bytes.Length, IntPtr.Zero, ov) && Marshal.GetLastWin32Error() != ERROR_IO_PENDING) { error = new Win32Exception(Marshal.GetLastWin32Error()).Message; return false; } int count; if (!GetOverlappedResult(handle, ov, out count, true) || count != bytes.Length) { error = new Win32Exception(Marshal.GetLastWin32Error()).Message; return false; } return true; } finally { FreeOverlapped(ov); }
  }
  public static bool ReadByte(IntPtr handle, int timeoutMs, out byte value, out string error) {
    value = 0; error = null; byte[] buffer = new byte[1]; IntPtr ov = NewOverlapped(); try {
      if (!ReadFile(handle, buffer, 1, IntPtr.Zero, ov)) { int code = Marshal.GetLastWin32Error(); if (code != ERROR_IO_PENDING) { error = new Win32Exception(code).Message; return false; } }
      uint wait = WaitForSingleObject(EventOf(ov), (uint)timeoutMs);
      if (wait == WAIT_TIMEOUT) { CancelIo(handle); error = "timeout"; return false; }
      if (wait != WAIT_OBJECT_0) { error = new Win32Exception(Marshal.GetLastWin32Error()).Message; return false; }
      int count; if (!GetOverlappedResult(handle, ov, out count, false) || count != 1) { error = new Win32Exception(Marshal.GetLastWin32Error()).Message; return false; }
      value = buffer[0]; return true;
    } finally { FreeOverlapped(ov); }
  }
}
'@
}

$requests = 1..4 | ForEach-Object { [byte[]]@([byte]0x10, [byte]0x04, [byte]$_) }
$observations = @()
$devicePath = $null
[IntPtr]$handle = [IntPtr]::Zero
try {
  $findError = $null
  $devicePath = [EventPosDleEot]::FindDevice($VendorId, $ProductId, $SerialNumber, [ref]$findError)
  if ($devicePath) { $handle = [EventPosDleEot]::CreateFile($devicePath, 0xC0000000, 3, [IntPtr]::Zero, 3, 0x40000000, [IntPtr]::Zero) }
  $openError = if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr](-1)) { if ($devicePath) { [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message } else { $findError } } else { $null }
  foreach ($request in $requests) {
    $requestHex = [BitConverter]::ToString($request).Replace('-', '').ToLowerInvariant()
    if ($openError) { $observations += [pscustomobject]@{ requestHex = $requestHex; responseHex = $null; normalized = 'unknown'; timeoutMs = $TimeoutMs; error = $openError }; continue }
    $writeError = $null
    if (-not [EventPosDleEot]::Write($handle, $request, [ref]$writeError)) { $observations += [pscustomobject]@{ requestHex = $requestHex; responseHex = $null; normalized = 'unknown'; timeoutMs = $TimeoutMs; error = $writeError }; continue }
    [byte]$response = 0; $readError = $null
    if ([EventPosDleEot]::ReadByte($handle, $TimeoutMs, [ref]$response, [ref]$readError)) { $observations += [pscustomobject]@{ requestHex = $requestHex; responseHex = ('{0:x2}' -f $response); normalized = 'unknown'; timeoutMs = $TimeoutMs } }
    else { $observations += [pscustomobject]@{ requestHex = $requestHex; responseHex = $null; normalized = 'unknown'; timeoutMs = $TimeoutMs; error = $readError } }
  }
  $observations | ConvertTo-Json -Compress
} finally {
  if ($handle -ne [IntPtr]::Zero -and $handle -ne [IntPtr](-1)) { [void][EventPosDleEot]::CloseHandle($handle) }
}
