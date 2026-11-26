import { useEffect, useRef, useState } from "react";
import { checkoutApi, type ConnectionGuideDto } from "./checkout-api.js";
import { customerUrl, registerUrl, wifiQrText } from "./connection-guide.js";
import { encodeQr } from "./qr-encode.js";

// QRコードを canvas へ描く。生成はブラウザ内で完結し、外部通信は発生しない。
// data-qr-text に元文字列を持たせ、テストと目視確認で内容を照合できるようにする。
export function QrCode({ text, label }: { text: string; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { size, modules } = encodeQr(text);
    const quiet = 4;
    const scale = 6;
    canvas.width = (size + quiet * 2) * scale;
    canvas.height = (size + quiet * 2) * scale;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r]![c]) context.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }, [text]);
  return <canvas ref={canvasRef} className="connection-qr" role="img" aria-label={label} data-qr-text={text} />;
}

// 接続案内: テザリング等の Wi-Fi 接続 QR と、この端末の LAN アドレスで作る
// レジ画面 / 顧客画面 QR を表示する。アドレスは表示時点のサーバー応答を使う。
export function ConnectionGuidePanel() {
  const [guide, setGuide] = useState<ConnectionGuideDto | null>(null);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void checkoutApi.getConnectionGuide()
      .then((dto) => {
        setGuide(dto);
        setSsid(dto.wifi.ssid);
        setPassword(dto.wifi.password);
      })
      .catch(() => setMessage("接続案内を取得できませんでした"));
  }, []);

  const save = () => {
    setSaving(true);
    void checkoutApi.saveConnectionWifi({ ssid, password })
      .then((result) => {
        setGuide((current) => (current ? { ...current, wifi: result.wifi } : current));
        setMessage("Wi-Fi設定を保存しました");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "Wi-Fi設定を保存できませんでした"))
      .finally(() => setSaving(false));
  };

  const wifiText = ssid ? wifiQrText(ssid, password) : "";
  return (
    <section className="admin-panel connection-guide-panel">
      <h2>接続案内</h2>
      {message && <p className="admin-message">{message}</p>}
      {!guide ? (
        <p>接続案内を取得中…</p>
      ) : (
        <>
          {!guide.lanPublished && (
            <p className="connection-guide-warning" role="alert">
              LAN公開が無効のため、他の端末からは接続できません。キットを LAN 公開オプション（環境変数 EVENT_POS_LAN=1、または起動引数 --lan）で起動してください。
            </p>
          )}
          <section className="connection-guide-wifi">
            <h3>Wi-Fi接続（テザリング）</h3>
            <div className="admin-form">
              <label>SSID<input type="text" value={ssid} onChange={(event) => setSsid(event.target.value)} autoComplete="off" /></label>
              <label>パスワード<input type="text" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" /></label>
            </div>
            <button type="button" disabled={saving || !ssid} onClick={save}>Wi-Fi設定を保存</button>
            {wifiText && (
              <div className="connection-guide-qr">
                <QrCode text={wifiText} label="Wi-Fi接続用QRコード" />
                <p>スマートフォンのカメラで読み取ると、このWi-Fiへ接続できます。</p>
                <code>{wifiText}</code>
              </div>
            )}
          </section>
          <section className="connection-guide-urls">
            <h3>レジ・顧客画面への接続</h3>
            {guide.addresses.length === 0 ? (
              <p>LANアドレスが見つかりません。Wi-Fi（テザリング）へ接続してから開き直してください。</p>
            ) : (
              guide.addresses.map((address) => {
                const register = registerUrl(address, guide.port);
                const customer = customerUrl(address, guide.port);
                return (
                  <div key={address} className="connection-guide-address">
                    <h4>{address}:{guide.port}</h4>
                    <div className="connection-guide-qr">
                      <QrCode text={register} label={`レジ画面のQRコード（${address}）`} />
                      <p>レジ画面</p>
                      <code>{register}</code>
                    </div>
                    <div className="connection-guide-qr">
                      <QrCode text={customer} label={`顧客画面のQRコード（${address}）`} />
                      <p>顧客画面</p>
                      <code>{customer}</code>
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </>
      )}
    </section>
  );
}
