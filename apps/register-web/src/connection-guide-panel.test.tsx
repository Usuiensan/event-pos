import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ConnectionGuideDto } from "./checkout-api.js";
import { ConnectionGuidePanel } from "./connection-guide-panel.js";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});

// useState の呼び出し順: guide, ssid, password, message, saving
function render(guide: ConnectionGuideDto) {
  vi.mocked(useState)
    .mockReturnValueOnce([guide, vi.fn()])
    .mockReturnValueOnce([guide.wifi.ssid, vi.fn()])
    .mockReturnValueOnce([guide.wifi.password, vi.fn()])
    .mockReturnValueOnce(["", vi.fn()])
    .mockReturnValueOnce([false, vi.fn()]);
  return renderToStaticMarkup(<ConnectionGuidePanel />);
}

const base: ConnectionGuideDto = {
  host: "0.0.0.0",
  port: 3000,
  lanPublished: true,
  addresses: ["192.168.68.119"],
  urls: [{ address: "192.168.68.119", registerUrl: "http://192.168.68.119:3000/?register=1&role=staff", customerUrl: "http://192.168.68.119:3000/?register=1&role=customer" }],
  wifi: { ssid: "MyPhone", password: "password123" },
};

it("Wi-Fi QRとレジ・顧客画面QRの元文字列を表示する", () => {
  const html = render(base);
  expect(html).toContain('data-qr-text="WIFI:T:WPA;S:MyPhone;P:password123;;"');
  expect(html).toContain('data-qr-text="http://192.168.68.119:3000/?register=1&amp;role=staff"');
  expect(html).toContain('data-qr-text="http://192.168.68.119:3000/?register=1&amp;role=customer"');
  expect(html).toContain("レジ画面");
  expect(html).toContain("顧客画面");
});

it("LAN未公開では警告を出し、アドレスなしでは案内文を出す", () => {
  const html = render({ ...base, host: "127.0.0.1", lanPublished: false, addresses: [], urls: [] });
  expect(html).toContain("LAN公開が無効のため、他の端末からは接続できません");
  expect(html).toContain("EVENT_POS_LAN=1");
  expect(html).toContain("LANアドレスが見つかりません");
});
