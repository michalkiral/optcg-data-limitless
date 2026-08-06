import assert from "node:assert/strict";
import test from "node:test";
import { buildFormats, deriveCutoff } from "./formats.mjs";

test("Standard is the newest four blocks", () => {
  assert.deepEqual(deriveCutoff(5, undefined), { standardMinBlock: 2, cutoffSource: "derived" });
  assert.deepEqual(deriveCutoff(6, undefined), { standardMinBlock: 3, cutoffSource: "derived" });
});

test("never derives a cutoff below the first block", () => {
  assert.equal(deriveCutoff(3, undefined).standardMinBlock, 1);
  assert.equal(deriveCutoff(1, undefined).standardMinBlock, 1);
});

test("an override wins and says so", () => {
  assert.deepEqual(deriveCutoff(5, 3), { standardMinBlock: 3, cutoffSource: "override" });
});

const restrictions = {
  banned: ["ST10-001", "OP03-040"],
  restricted: [],
  bannedPairs: [["OP11-067", "OP11-040"]],
};

test("assembles the published shape", () => {
  const out = buildFormats({ updatedAt: "2026-08-06", maxBlock: 5, restrictions });
  assert.deepEqual(out, {
    updatedAt: "2026-08-06",
    standardMinBlock: 2,
    maxBlock: 5,
    cutoffSource: "derived",
    banned: ["OP03-040", "ST10-001"],
    restricted: [],
    bannedPairs: [["OP11-040", "OP11-067"]],
  });
});

test("sorts everything so an unchanged upstream makes no commit", () => {
  const a = buildFormats({ updatedAt: "2026-08-06", maxBlock: 5, restrictions });
  const b = buildFormats({
    updatedAt: "2026-08-06",
    maxBlock: 5,
    restrictions: {
      banned: ["OP03-040", "ST10-001"],
      restricted: [],
      bannedPairs: [["OP11-040", "OP11-067"]],
    },
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
