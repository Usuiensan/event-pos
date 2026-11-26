import { checkoutApi } from "./checkout-api.js";
import { demoCatalog } from "./demo-catalog.js";

// DBに実イベントのカタログがあれば、そのうち最も新しく更新されたものを対象イベントとする。
// 無ければデモイベントにフォールバックする（トレーニング環境はデモのみが投入される）。
// レジ起動時のカタログ読込と管理画面は、この解決を通して対象イベントを決める。
// 一覧の取得に失敗した場合は例外をそのまま伝播させる。失敗を「実イベント無し」と
// 区別せずデモで起動すると本番DBにデモのセッションができるため、呼び出し側で
// エラー表示とリトライを行う。
export async function resolveActiveEventId(): Promise<string> {
  const { events } = await checkoutApi.getEvents();
  return events.find((event) => event.eventId !== demoCatalog.eventId)?.eventId ?? demoCatalog.eventId;
}
