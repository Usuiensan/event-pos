// 接続案内のQR元文字列を作る純関数群。
// Wi-Fi QR は ZXing 系の WIFI フォーマット（WIFI:T:WPA;S:<ssid>;P:<pass>;;）。
// SSID / パスワード内の区切り文字（\ ; , : "）はバックスラッシュでエスケープする。

export function escapeWifiValue(value: string): string {
  return value.replace(/([\\;,:"'])/g, "\\$1");
}

export function wifiQrText(ssid: string, password: string): string {
  const escapedSsid = escapeWifiValue(ssid);
  if (!password) return `WIFI:T:nopass;S:${escapedSsid};;`;
  return `WIFI:T:WPA;S:${escapedSsid};P:${escapeWifiValue(password)};;`;
}

export function registerUrl(address: string, port: number): string {
  return `http://${address}:${port}/?register=1&role=staff`;
}

export function customerUrl(address: string, port: number): string {
  return `http://${address}:${port}/?register=1&role=customer`;
}
