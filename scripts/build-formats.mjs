#!/usr/bin/env node
// Publishes data/formats.json: the current ban list from Bandai plus the
// Standard rotation cutoff derived from the catalog's block numbers.
//
//   node scripts/build-formats.mjs
//
// On any parse or validation failure this exits non-zero WITHOUT writing, so a
// bad run leaves the last good file in place. An empty ban list would quietly
// declare every deck legal, which is worse than a stale one.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFormats } from "./formats.mjs";
import { parseRestrictions, validateRestrictions } from "./restrictions.mjs";

const PAGE = "https://en.onepiece-cardgame.com/rules/restriction/";
const UA = "optcg-data-limitless (research)";
const OUT = process.env.OUT_DIR ?? "data";
const OVERRIDES = join("overrides", "formats.json");

const baseNumber = (id) => id.replace(/_[prc]\d+$/, "");

// Overrides are hand-edited on Windows, where editors happily save a UTF-8 BOM
// that JSON.parse then rejects. Strip it rather than fail on a file that looks
// perfectly fine in the editor.
const readJson = (path) => JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));

function readCatalog() {
  const cards = readJson(join(OUT, "index", "cards_by_id.json"));
  const numbers = new Set();
  let maxBlock = 0;
  for (const [id, card] of Object.entries(cards)) {
    numbers.add(baseNumber(id));
    if (typeof card.block === "number" && card.block > maxBlock) {
      maxBlock = card.block;
    }
  }
  if (maxBlock === 0) {
    throw new Error("catalog has no block numbers — cannot derive the rotation cutoff");
  }
  return { numbers, maxBlock };
}

function readOverride() {
  if (!existsSync(OVERRIDES)) {
    return undefined;
  }
  const parsed = readJson(OVERRIDES);
  return typeof parsed.standardMinBlock === "number" ? parsed.standardMinBlock : undefined;
}

async function main() {
  const { numbers, maxBlock } = readCatalog();

  const res = await fetch(PAGE, { headers: { "user-agent": UA } });
  if (!res.ok) {
    throw new Error(`${PAGE} -> HTTP ${res.status}`);
  }
  const restrictions = parseRestrictions(await res.text());

  const errors = validateRestrictions(restrictions, (id) => numbers.has(id));
  if (errors.length > 0) {
    throw new Error(`restriction list rejected:\n  ${errors.join("\n  ")}`);
  }

  const formats = buildFormats({
    updatedAt: new Date().toISOString().slice(0, 10),
    maxBlock,
    override: readOverride(),
    restrictions,
  });

  writeFileSync(join(OUT, "formats.json"), `${JSON.stringify(formats, null, 2)}\n`);
  console.log(
    `formats.json: standard >= block ${formats.standardMinBlock} (${formats.cutoffSource}), ` +
      `${formats.banned.length} banned, ${formats.restricted.length} restricted, ` +
      `${formats.bannedPairs.length} pairs`,
  );
}

main().catch((err) => {
  console.error(`build-formats failed, keeping the previous file: ${err.message}`);
  process.exitCode = 1;
});
