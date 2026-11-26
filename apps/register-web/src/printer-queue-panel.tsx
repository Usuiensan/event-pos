import { useCallback, useEffect, useState } from "react";
import { checkoutApi, type PrinterStatusDto } from "./checkout-api.js";
import { printQueueBlockMessage, printerAlert } from "./print-status.js";

// 印刷キューの状態表示と、device fault 停止時の責任者再開（F-057）。
// 状態は数秒ごとに読み直し、再開後はキューが流れ始めることをメッセージで示す。
export function PrinterQueuePanel({ actorId }: { actorId: string }) {
  const [status, setStatus] = useState<PrinterStatusDto | null>(null);
  const [message, setMessage] = useState("");
  const [resuming, setResuming] = useState(false);
  const refresh = useCallback(() => {
    void checkoutApi.getPrinterStatus().then(setStatus).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const alert = printerAlert(status?.observation);
  const blockMessage = printQueueBlockMessage(status?.queue);
  const resume = () => {
    setResuming(true);
    void checkoutApi.resumePrinter(actorId)
      .then(() => {
        setMessage("印刷を再開しました。キューに残っている印刷が順に始まります。");
        refresh();
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "印刷を再開できませんでした"))
      .finally(() => setResuming(false));
  };
  return (
    <section className="admin-panel printer-queue-panel">
      <h2>プリンター・印刷キュー</h2>
      {alert && <p className="printer-alert" role="alert">{alert.message}</p>}
      {blockMessage ? (
        <>
          <p className="printer-queue-blocked" role="alert">{blockMessage}</p>
          <button type="button" disabled={resuming} onClick={resume}>印刷を再開</button>
        </>
      ) : (
        <p>{status ? `印刷キューは動作しています（待ち ${status.queue.waitingJobs} 件）。` : "プリンター状態を取得中…"}</p>
      )}
      {message && <p className="admin-message">{message}</p>}
    </section>
  );
}
