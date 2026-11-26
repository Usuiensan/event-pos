import { checkoutApi } from "./checkout-api.js";
import { demoCatalog } from "./demo-catalog.js";

// DBに実イベントのカタログがあれば、そのうち最も新しく更新されたものを対象イベントとする。
// 無ければデモイベントにフォールバックする（トレーニング環境はデモのみが投入される）。
// レジ起動時のカタログ読込と管理画面は、この解決を通して対象イベントを決める。
export async function resolveActiveEventId(): Promise<string> {
  try {
    const { events } = await checkoutApi.getEvents();
    return events.find((event) => event.eventId !== demoCatalog.eventId)?.eventId ?? demoCatalog.eventId;
  } catch {
    return demoCatalog.eventId;
  }
}
