import { describe, expect, it } from "vitest";
import { customerUrl, escapeWifiValue, registerUrl, wifiQrText } from "./connection-guide.js";

describe("wifiQrText", () => {
  it("WPA形式の文字列を作る", () => {
    expect(wifiQrText("MyPhone", "password123")).toBe("WIFI:T:WPA;S:MyPhone;P:password123;;");
  });

  it("パスワードなしは nopass 形式にする", () => {
    expect(wifiQrText("GuestNet", "")).toBe("WIFI:T:nopass;S:GuestNet;;");
  });

  it("区切り文字をエスケープする", () => {
    expect(wifiQrText("a;b,c:d\"e\\f", "p;w")).toBe("WIFI:T:WPA;S:a\\;b\\,c\\:d\\\"e\\\\f;P:p\\;w;;");
    expect(escapeWifiValue("plain")).toBe("plain");
  });

  it("日本語SSIDはそのまま埋め込む（QR側でUTF-8化）", () => {
    expect(wifiQrText("山田のiPhone", "himitsu-2026")).toBe("WIFI:T:WPA;S:山田のiPhone;P:himitsu-2026;;");
  });
});

describe("URLビルダー", () => {
  it("レジ画面と顧客画面のURLを作る", () => {
    expect(registerUrl("192.168.68.119", 3000)).toBe("http://192.168.68.119:3000/?register=1&role=staff");
    expect(customerUrl("192.168.68.119", 3000)).toBe("http://192.168.68.119:3000/?register=1&role=customer");
    expect(registerUrl("10.0.0.5", 8080)).toBe("http://10.0.0.5:8080/?register=1&role=staff");
  });
});
