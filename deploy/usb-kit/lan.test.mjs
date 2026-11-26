import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lanEnabled, serverHost } from "./lan.mjs";

describe("LAN公開オプション", () => {
  it("未指定では無効で、待ち受けは127.0.0.1", () => {
    assert.equal(lanEnabled({}, ["node", "start.mjs"]), false);
    assert.equal(serverHost({}, ["node", "start.mjs"]), "127.0.0.1");
  });

  it("EVENT_POS_LAN=1/trueで有効になり、待ち受けは0.0.0.0", () => {
    assert.equal(lanEnabled({ EVENT_POS_LAN: "1" }, []), true);
    assert.equal(lanEnabled({ EVENT_POS_LAN: "true" }, []), true);
    assert.equal(lanEnabled({ EVENT_POS_LAN: "TRUE" }, []), true);
    assert.equal(serverHost({ EVENT_POS_LAN: "1" }, []), "0.0.0.0");
  });

  it("EVENT_POS_LAN=0/その他の値では無効", () => {
    assert.equal(lanEnabled({ EVENT_POS_LAN: "0" }, []), false);
    assert.equal(lanEnabled({ EVENT_POS_LAN: "yes" }, []), false);
    assert.equal(serverHost({ EVENT_POS_LAN: "0" }, []), "127.0.0.1");
  });

  it("引数 --lan でも有効になる", () => {
    assert.equal(lanEnabled({}, ["node", "start.mjs", "--lan"]), true);
    assert.equal(serverHost({}, ["node", "start.mjs", "--lan"]), "0.0.0.0");
  });
});
