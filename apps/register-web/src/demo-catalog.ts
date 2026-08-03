import type { EventCatalog, ProductDefinition } from "@event-pos/contracts";

type DemoGroup = { id: string; label: string; color: string; taxRate: number; ageCheck?: "18"; items: Array<readonly [string, number]> };

const groups: DemoGroup[] = [
  { id: "vegetables", label: "野菜", color: "#dcfce7", taxRate: 8, items: [["キャベツ",198],["レタス",178],["白菜 1/4",128],["ほうれん草",158],["小松菜",138],["ブロッコリー",198],["大根",168],["にんじん 3本",198],["玉ねぎ 3個",238],["じゃがいも 1袋",298],["長ねぎ 2本",198],["きゅうり 3本",228],["トマト 4個",398],["ミニトマト",298],["なす 5本",258],["ピーマン 1袋",158],["かぼちゃ 1/4",198],["もやし",39],["しめじ",98],["しいたけ",258]] },
  { id: "fruit", label: "青果", color: "#fef9c3", taxRate: 8, items: [["ふじりんご",158],["王林りんご",178],["みかん 1袋",498],["バナナ 1房",198],["いちご 1パック",598],["シャインマスカット",1580],["巨峰",980],["桃 2個",698],["梨 2個",598],["柿 3個",398],["キウイ 4個",398],["グレープフルーツ",198],["オレンジ 3個",398],["レモン 3個",298],["パイナップル",498],["すいか 1/8",398],["メロン",1280],["ブルーベリー",398],["アボカド",158],["カットフルーツ",398]] },
  { id: "fish", label: "鮮魚", color: "#cffafe", taxRate: 8, items: [["生鮭切身 2切",498],["塩さば 2枚",398],["あじ開き 2枚",358],["さんま 2尾",498],["ぶり切身 2切",598],["まぐろ赤身",798],["サーモン刺身",698],["刺身盛合せ",1280],["真鯛刺身",780],["かつおたたき",598],["いか刺身",498],["たこ刺身",598],["むきえび",498],["しらす干し",298],["明太子",598],["あさり",398],["しじみ",298],["ほたて貝柱",798],["銀だら西京漬",698],["海鮮丼セット",980]] },
  { id: "meat", label: "精肉", color: "#fee2e2", taxRate: 8, items: [["国産牛切落し",980],["牛ももステーキ",1280],["牛焼肉用",1180],["豚ロース薄切り",498],["豚バラ薄切り",458],["豚こま切れ",398],["豚ひき肉",358],["鶏もも肉",398],["鶏むね肉",298],["鶏ささみ",358],["手羽先",398],["合挽き肉",458],["ラム焼肉用",798],["ロースハム",398],["ベーコン",358],["あらびきウインナー",398],["生ハンバーグ",498],["味付け焼肉",698],["焼鳥セット",598],["ローストビーフ",980]] },
  { id: "deli", label: "惣菜", color: "#ffedd5", taxRate: 8, items: [["鶏の唐揚げ",398],["コロッケ 2個",198],["メンチカツ 2個",298],["とんかつ",498],["エビフライ 3本",498],["春巻 4本",398],["焼き餃子",398],["だし巻き玉子",298],["ポテトサラダ",258],["マカロニサラダ",258],["きんぴらごぼう",198],["ひじき煮",198],["筑前煮",398],["肉じゃが",398],["麻婆豆腐",398],["焼きそば",398],["ナポリタン",398],["おにぎりセット",298],["幕の内弁当",598],["海苔弁当",398]] },
  { id: "gift", label: "ギフト", color: "#f3e8ff", taxRate: 10, items: [["焼菓子詰合せ",1200],["クッキー缶",1800],["フィナンシェセット",1500],["羊羹詰合せ",2000],["煎餅詰合せ",1600],["チョコレートギフト",2200],["紅茶セット",1800],["コーヒーギフト",2500],["ジュース詰合せ",2000],["ジャムセット",1800],["はちみつセット",2800],["調味料セット",2500],["海苔詰合せ",3000],["乾麺セット",2200],["フルーツゼリー",1800],["タオルギフト",2000],["ハンドソープセット",1500],["カタログギフトA",3300],["カタログギフトB",5500],["ギフト包装",200]] },
  { id: "books", label: "本", color: "#dbeafe", taxRate: 10, items: [["新刊 小説A",800],["新刊 小説B",1000],["新刊 漫画A",700],["新刊 漫画B",900],["既刊 小説1",600],["既刊 小説2",600],["既刊 漫画1",500],["既刊 漫画2",500],["総集編 上巻",1500],["総集編 下巻",1500],["設定資料集",1200],["イラスト集",1000],["写真集",1800],["評論誌",800],["合同誌",1200],["コピー本",300],["お試し冊子",100],["ポストカードブック",700],["特装版",2500],["新刊2冊セット",1600]] },
  { id: "adult", label: "成人向", color: "#fbcfe8", taxRate: 10, ageCheck: "18", items: [["R18新刊 小説A",1000],["R18新刊 小説B",1200],["R18新刊 漫画A",800],["R18新刊 漫画B",1000],["R18既刊 小説1",800],["R18既刊 小説2",800],["R18既刊 漫画1",700],["R18既刊 漫画2",700],["R18総集編 上巻",1800],["R18総集編 下巻",1800],["R18イラスト集A",1200],["R18イラスト集B",1500],["R18写真集",2000],["R18合同誌",1500],["R18コピー本",400],["R18特装版",2800],["R18新刊セットA",1800],["R18新刊セットB",2000],["R18既刊セット",2400],["R18全巻セット",5000]] },
];

let sequence = 1;
const products: ProductDefinition[] = groups.flatMap((group) => group.items.map(([name, priceInclTax]) => {
  const number = String(sequence++).padStart(7, "0");
  return { productCode: `T${number}`, name, priceInclTax, taxRate: group.taxRate, taxCategory: group.taxRate === 8 ? "inclusive_8" : "inclusive_10", saleState: "on_sale", internalToken: `P1TEST${number}`, tabId: group.id, displayColor: group.color, ...(group.ageCheck ? { ageCheck: group.ageCheck } : {}) };
}));

export const demoCatalog: EventCatalog = {
  eventId: "demo-event-large",
  customerWelcome: { message: "いらっしゃいませ\n新刊・既刊を頒布しています", circleName: "event-pos テストサークル", space: "東A-01a" },
  products,
  quickEntries: [{ id: "book-pair", label: "新刊 小説A+B", components: [{ productCode: "T0000121", quantity: 1 }, { productCode: "T0000122", quantity: 1 }], tabId: "books" }, { id: "adult-new", label: "R18新刊 小説A", productCode: "T0000141", quantity: 1, tabId: "adult" }],
  staffMembers: [{ responsibleNumber: "001", displayName: "テスト管理者", role: "admin", permissions: ["catalog_import", "refund", "reprint"] }, { responsibleNumber: "002", displayName: "売り子A", role: "operator", permissions: [] }],
  productTabs: groups.map(({ id, label, color }) => ({ id, label, color })),
  autoDiscountRules: [{ id: "book-pair-discount", label: "新刊小説2冊値引き", requiredProducts: [{ productCode: "T0000121", quantity: 1 }, { productCode: "T0000122", quantity: 1 }], discountYen: 100, priority: 10 }],
};
