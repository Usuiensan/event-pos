import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lanEnabled, serverHost } from "./lan.mjs";

describe("LAN公開（既定で有効）", () => {
  it("未指定では有効で、待ち受けは0.0.0.0", () => {
    assert.equal(lanEnabled({}, ["node", "start.mjs"]), true);
    assert.equal(serverHost({}, ["node", "start.mjs"]), "0.0.0.0");
  });

  it("EVENT_POS_LAN=1/trueでも有効", () => {
    assert.equal(lanEnabled({ EVENT_POS_LAN: "1" }, []), true);
    assert.equal(lanEnabled({ EVENT_POS_LAN: "true" }, []), true);
    assert.equal(lanEnabled({ EVENT_POS_LAN: "TRUE" }, []), true);
    assert.equal(serverHost({ EVENT_POS_LAN: "1" }, []), "0.0.0.0");
  });

  it("EVENT_POS_LAN=0/falseで無効になり、待ち受けは127.0.0.1", () => {
    assert.equal(lanEnabled({ EVENT_POS_LAN: "0" }, []), false);
    assert.equal(lanEnabled({ EVENT_POS_LAN: "false" }, []), false);
    assert.equal(lanEnabled({ EVENT_POS_LAN: "FALSE" }, []), false);
    assert.equal(serverHost({ EVENT_POS_LAN: "0" }, []), "127.0.0.1");
  });

  it("EVENT_POS_LANのその他の値では既定どおり有効", () => {
    assert.equal(lanEnabled({ EVENT_POS_LAN: "yes" }, []), true);
  });

  it("引数 --lan でも有効になる", () => {
    assert.equal(lanEnabled({}, ["node", "start.mjs", "--lan"]), true);
    assert.equal(serverHost({}, ["node", "start.mjs", "--lan"]), "0.0.0.0");
  });

  it("引数 --no-lan で無効になる", () => {
    assert.equal(lanEnabled({}, ["node", "start.mjs", "--no-lan"]), false);
    assert.equal(serverHost({}, ["node", "start.mjs", "--no-lan"]), "127.0.0.1");
  });

  it("無効化の指定は有効化の指定より優先される", () => {
    assert.equal(lanEnabled({ EVENT_POS_LAN: "1" }, ["node", "start.mjs", "--no-lan"]), false);
    assert.equal(lanEnabled({ EVENT_POS_LAN: "0" }, ["node", "start.mjs", "--lan"]), false);
    assert.equal(lanEnabled({ EVENT_POS_LAN: "false" }, ["node", "start.mjs", "--lan"]), false);
  });
});
