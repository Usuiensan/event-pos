import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { drawerEnabled } from "./drawer.mjs";

describe("ドロアー駆動（既定で無効）", () => {
  it("未指定では無効", () => {
    assert.equal(drawerEnabled({}, ["node", "start.mjs"]), false);
  });

  it("DRAWER_ENABLED=1/trueで有効", () => {
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "1" }, []), true);
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "true" }, []), true);
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "TRUE" }, []), true);
  });

  it("DRAWER_ENABLED=0/falseで無効", () => {
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "0" }, []), false);
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "false" }, []), false);
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "FALSE" }, []), false);
  });

  it("DRAWER_ENABLEDのその他の値では既定どおり無効", () => {
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "yes" }, []), false);
  });

  it("引数 --drawer で有効になる", () => {
    assert.equal(drawerEnabled({}, ["node", "start.mjs", "--drawer"]), true);
  });

  it("引数 --no-drawer で無効になる", () => {
    assert.equal(drawerEnabled({}, ["node", "start.mjs", "--no-drawer"]), false);
  });

  it("無効化の指定は有効化の指定より優先される", () => {
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "1" }, ["node", "start.mjs", "--no-drawer"]), false);
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "0" }, ["node", "start.mjs", "--drawer"]), false);
    assert.equal(drawerEnabled({ DRAWER_ENABLED: "false" }, ["node", "start.mjs", "--drawer"]), false);
  });
});
