#!/usr/bin/env node
// Test pipeline: build the catalog + prices entirely from Limitless TCG,
// organised exactly as Limitless organises it (Products grouped by category,
// then Promos). No vegapull, no Bandai cardlist.
//
//   node scripts/build.mjs --taxonomy   # just the product list (2 fetches)
//   node scripts/build.mjs --only <slug,slug>   # those products' cards
//   node scripts/build.mjs              # full crawl (heavy)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HISTORY_DAYS = 120;

const SITE = "https://onepiece.limitlesstcg.com";
const UA = "optcg-data-limitless (research)";
const DELAY_MS = 300;
const OUT = process.env.OUT_DIR ?? "data";

// --- HTML helpers ---
const decode = (s) =>
  (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&[a-z]+;/g, " ");
const strip = (s) =>
  decode((s || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
const grab = (s, re) => (s.match(re) || [])[1] || "";
const numOf = (s) => {
  const m = (s || "").replace(/,/g, "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
};
// Limitless links each EUR price to the exact Cardmarket product page. Keep that
// URL (minus tracking params) so the app can deep-link a printing; drop anything
// that is not a Cardmarket link.
const cmUrl = (href) => {
  const base = (href || "").split("?")[0];
  return base.includes("cardmarket.com") ? base : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
function parseDate(s) {
  const m = (s || "").trim().match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})/);
  return m ? `20${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}` : null;
}

async function get(path) {
  const backoffs = [0, 2000, 6000];
  let last = 0;
  for (const wait of backoffs) {
    await sleep(wait || DELAY_MS);
    const res = await fetch(`${SITE}${path}`, { headers: { "user-agent": UA } });
    if (res.ok) return res.text();
    last = res.status;
    if (res.status === 404) break;
  }
  throw new Error(`${path} -> HTTP ${last}`);
}

// --- Taxonomy: Products (grouped by category) + Promos ---
async function scrapeProducts() {
  const html = await get("/cards");
  const table = grab(html, /<table class="data-table sets-table striped">([\s\S]*?)<\/table>/);
  const out = [];
  let category = null;
  for (const row of table.split(/<tr/).slice(1)) {
    const sub = grab(row, /class="sub-heading"[^>]*>([\s\S]*?)<\/th>/);
    if (sub) {
      category = strip(sub);
      continue;
    }
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 4) continue;
    out.push({
      category,
      code: strip(cells[0]),
      name: strip(cells[1]),
      releaseDate: parseDate(strip(cells[2])),
      cardCount: numOf(strip(cells[3])),
      slug: grab(cells[0], /href="\/cards\/([^"]+)"/),
    });
  }
  return out;
}

async function scrapePromos() {
  const html = await get("/cards/promos");
  const out = [];
  for (const m of html.matchAll(
    /<tr data-name="([^"]*)" data-release="([^"]*)" data-cards="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g,
  )) {
    out.push({
      category: "Promos",
      code: null,
      name: decode(m[1]),
      releaseDate: m[2] || null,
      cardCount: Number(m[3]),
      slug: grab(m[4], /href="\/cards\/([^"]+)"/),
    });
  }
  return out;
}

// --- Card page parsing (data + base price), proven in the spike ---
function parsePrice(text) {
  const v = Number.parseFloat((text || "").replace(/[^0-9.,]/g, "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

function parseCard(html) {
  const text = grab(html, /<div class="card-text">([\s\S]*?)<div class="card-legality"/);
  const typeLine = grab(text, /card-text-type">([\s\S]*?)<\/p>/);
  const powerSec = grab(text, /<p class="card-text-section">([\s\S]*?)<\/p>/);
  const colorRaw = strip(grab(typeLine, /data-tooltip="Color">([\s\S]*?)<\/span>/));
  const attrRaw = strip(grab(powerSec, /data-tooltip="Attribute">([\s\S]*?)<\/span>/));
  const typeRaw = strip(grab(text, /data-tooltip="Type">([\s\S]*?)<\/span>/));
  const costM = typeLine.match(/([\d,]+)\s*(?:Cost|Life)/i);
  const powerM = powerSec.match(/([\d,]+)\s*Power/i);
  const counterM = powerSec.match(/\+?([\d,]+)\s*Counter/i);

  const body = text.replace(/<div class="card-text-section card-text-artist">[\s\S]*?<\/div>/, "");
  let full = "";
  for (const m of body.matchAll(/<div class="card-text-section">([\s\S]*?)<\/div>/g)) {
    if (!/data-tooltip|card-text-title/.test(m[1])) {
      full = strip(m[1]);
      break;
    }
  }
  // Split [Trigger] out of the rules text, as our schema keeps it separate.
  const trig = full.match(/\[Trigger\][\s\S]*/i);
  const trigger = trig ? strip(trig[0]) : null;
  const effect = trigger ? strip(full.slice(0, full.toLowerCase().indexOf("[trigger]"))) : full;

  const spans = [
    ...grab(html, /prints-current-details">([\s\S]*?)<\/div>/).matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g),
  ].map((m) => strip(m[1]));

  // Base price: the page's current print row.
  const cur = grab(html, /<tr\s+class="current"\s*>([\s\S]*?)<\/tr>/);
  return {
    name: strip(grab(text, /card-text-name"><a[^>]*>([\s\S]*?)<\/a>/)),
    rarity: spans[1] || null,
    category: strip(grab(typeLine, /data-tooltip="Category">([\s\S]*?)<\/span>/)),
    colors: colorRaw ? colorRaw.split("/").map((x) => x.trim()).filter(Boolean) : [],
    cost: costM ? Number(costM[1].replace(/,/g, "")) : null,
    power: powerM ? numOf(powerM[1]) : null,
    counter: counterM ? numOf(counterM[1]) : null,
    block: numOf(strip(grab(html, /regulation-mark">([\s\S]*?)<\/div>/))),
    attributes: attrRaw ? attrRaw.split("/").map((x) => x.trim()).filter(Boolean) : [],
    types: typeRaw ? typeRaw.split("/").map((x) => x.trim()).filter(Boolean) : [],
    effect: effect && effect !== "-" ? effect : "",
    trigger,
    image: grab(html, /(https:\/\/limitlesstcg[^"' ]*\/one-piece\/[^"' ]*_EN\.webp)/) || null,
    eur: parsePrice(grab(cur, /card-price eur"[^>]*>([^<]*)</)),
    usd: parsePrice(grab(cur, /card-price usd"[^>]*>([^<]*)</)),
    cm: cmUrl(grab(cur, /card-price eur"\s+href="([^"]*)"/)),
  };
}

// --- Variant resolution (alt arts / reprints) via version pages ---
// Limitless lists every printing in the base page's versions table; each links
// to ?v=N whose image filename carries the printing's id and set folder. Ids
// come from Limitless, so there is nothing to map.
function parsePrintsTable(html) {
  const table = (html.match(/<table class="card-prints-versions"[\s\S]*?<\/table>/) || [])[0];
  if (!table) return [];
  const rows = [];
  for (const chunk of table.split(/<tr\b/).slice(1)) {
    if (/<th[\s>]/.test(chunk)) continue;
    const eur = grab(chunk, /class="card-price eur"\s+href="[^"]*"[^>]*>\s*([^<]*)</);
    const usd = grab(chunk, /class="card-price usd"\s+href="[^"]*"[^>]*>\s*([^<]*)</);
    const cm = cmUrl(grab(chunk, /class="card-price eur"\s+href="([^"]*)"/));
    const v = grab(chunk, /href="\/cards\/[^"]*\?v=(\d+)"/);
    rows.push({ v: v ? Number(v) : null, eur: parsePrice(eur), usd: parsePrice(usd), cm });
  }
  return rows;
}

function versionPrintId(html, baseId) {
  const esc = baseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return grab(html, new RegExp(`/one-piece/[^/]+/(${esc}(?:_[a-z0-9]+)?)_[A-Z]{2}\\.webp`)) || null;
}
const setFromImage = (html, id) =>
  grab(html, new RegExp(`/one-piece/([^/]+)/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_`)) || null;

async function resolveVariants(baseId, baseHtml, baseCard) {
  const out = [];
  for (const row of parsePrintsTable(baseHtml).filter((r) => r.v !== null)) {
    let vp;
    try {
      vp = await get(`/cards/${encodeURIComponent(baseId)}?v=${row.v}`);
    } catch {
      continue;
    }
    const id = versionPrintId(vp, baseId);
    if (!id || id === baseId) continue;
    const spans = [
      ...grab(vp, /prints-current-details">([\s\S]*?)<\/div>/).matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g),
    ].map((m) => strip(m[1]));
    out.push({
      ...baseCard,
      id,
      set: setFromImage(vp, id),
      rarity: spans[1] || baseCard.rarity,
      image: grab(vp, /(https:\/\/limitlesstcg[^"' ]*\/one-piece\/[^"' ]*_EN\.webp)/) || baseCard.image,
      eur: row.eur,
      usd: row.usd,
      cm: row.cm,
    });
  }
  return out;
}

// Read each printing's id from its thumbnail image filename, so we catch both
// base links (/cards/OP16-001) and version links (/cards/OP10-111?v=4 → the
// promo alt art OP10-111_p4). The href alone misses the latter.
async function enumerateCards(slug) {
  const html = await get(`/cards/${slug}`);
  const ids = [];
  for (const m of html.matchAll(
    /class="card shadow" src="[^"]*\/one-piece\/[^/]+\/([A-Za-z0-9-]+(?:_[a-z0-9]+)?)_[A-Z]{2}\.webp"/g,
  ))
    ids.push(m[1]);
  return [...new Set(ids)];
}

const setOfImage = (url) => (url || "").match(/\/one-piece\/([^/]+)\//)?.[1] ?? null;

const basePrintId = (id) => id.replace(/_[prc]\d+$/, "");

// Shared writer. Each printing is canonical in the set that DEBUTED it (the
// earliest-released product whose page lists its thumbnail). Every OTHER product
// listing the same id reprinted it — we mint a distinct `${id}_r${n}` clone in
// that set with no own price, so the app's `_r` fallback inherits the base
// print's price. This makes each reprint individually trackable and every set's
// count match the thumbnails Limitless shows (e.g. OP09-078 → OP09, plus
// OP09-078_r1 in PRB02 and OP09-078_r2 in ST26). Numbering is deterministic (by
// release date, then set code) so a card's reprint ids stay stable across
// crawls. Ids no product lists (in-set alt arts reachable only via a base card's
// version pages) fall back to their image folder.
function writeOutputs(byId, products, membersByKey) {
  // Drop reprints minted by a previous run so they regenerate from current
  // membership (keeps --rebuild idempotent; Limitless never emits _rN ids).
  for (const id of Object.keys(byId)) if (/_r\d+$/.test(id)) delete byId[id];

  const rankOf = new Map(); // set key -> release date (undated sorts last)
  for (const p of products)
    rankOf.set(p.code || p.slug, p.releaseDate ? Date.parse(p.releaseDate) : Number.POSITIVE_INFINITY);
  const rank = (key) => rankOf.get(key) ?? Number.POSITIVE_INFINITY;

  // id -> set keys that list it, debut first (release date, then code tiebreak).
  const listedBy = new Map();
  for (const p of products) {
    const key = p.code || p.slug;
    for (const id of membersByKey.get(key) ?? []) {
      const arr = listedBy.get(id) ?? [];
      if (!arr.includes(key)) arr.push(key);
      listedBy.set(id, arr);
    }
  }
  for (const arr of listedBy.values())
    arr.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));

  // Canonical set per existing id: its debut, else its image folder.
  for (const c of Object.values(byId)) {
    const fallback = setOfImage((byId[basePrintId(c.id)] ?? c).image);
    c.set = listedBy.get(c.id)?.[0] ?? fallback ?? c.set;
  }
  // Mint a reprint clone for every non-debut set that lists an id.
  for (const [id, listers] of listedBy) {
    const base = byId[id];
    if (!base) continue;
    listers.slice(1).forEach((set, i) => {
      const rid = `${id}_r${i + 1}`;
      if (!byId[rid]) byId[rid] = { ...base, id: rid, set };
    });
  }
  const bySet = {};
  for (const c of Object.values(byId)) (bySet[c.set] ??= []).push(c);

  rmSync(join(OUT, "cards"), { recursive: true, force: true });
  mkdirSync(join(OUT, "cards"), { recursive: true });
  mkdirSync(join(OUT, "index"), { recursive: true });
  const packs = [];
  for (const p of products) {
    const key = p.code || p.slug;
    const cards = bySet[key] ?? [];
    if (!cards.length) continue;
    writeFileSync(join(OUT, "cards", `${key}.json`), `${JSON.stringify(cards, null, 2)}\n`);
    packs.push({
      code: key,
      name: p.name,
      category: p.category,
      releaseDate: p.releaseDate,
      cardCount: cards.length,
      listedCount: p.cardCount,
      slug: p.slug,
    });
  }
  // Sets with cards but no Limitless product (e.g. bare promos "P").
  const covered = new Set(packs.map((p) => p.code));
  for (const [set, cards] of Object.entries(bySet)) {
    if (covered.has(set)) continue;
    writeFileSync(join(OUT, "cards", `${set}.json`), `${JSON.stringify(cards, null, 2)}\n`);
    packs.push({ code: set, name: set, category: "Other", releaseDate: null, cardCount: cards.length, listedCount: null, slug: null });
  }
  writeFileSync(join(OUT, "index", "cards_by_id.json"), `${JSON.stringify(byId)}\n`);
  writeFileSync(join(OUT, "packs.json"), `${JSON.stringify(packs, null, 2)}\n`);
  return packs.length;
}

// Rebuild files from an existing crawl without re-fetching every card: reuse the
// index for card data, re-enumerate every product for membership (cheap).
async function rebuild() {
  const byId = JSON.parse(readFileSync(join(OUT, "index", "cards_by_id.json"), "utf8"));
  const products = [...(await scrapeProducts()), ...(await scrapePromos())];
  const membersByKey = new Map();
  for (const p of products) {
    if (p.slug) membersByKey.set(p.code || p.slug, await enumerateCards(p.slug));
  }
  const n = writeOutputs(byId, products, membersByKey);
  console.log(`rebuilt: ${n} product files, ${Object.keys(byId).length} cards`);
}

// Write only when the content actually differs from what is on disk. Lets the
// 12-hourly crawl re-run within a day without churning the price files: a new
// day always appends a history column (so every day is logged), but a same-day
// re-run with no price change leaves history.json/summary.json byte-identical
// and produces no commit.
function writeIfChanged(path, content) {
  const next = `${content}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === next) {
    return false;
  }
  writeFileSync(path, next);
  return true;
}

// Rolling 120-day EUR history + d7/d30, mirroring the original prices pipeline.
function buildPriceOutputs(prices) {
  const today = new Date().toISOString().slice(0, 10);
  const path = join(OUT, "prices", "history.json");
  const history = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { dates: [], cards: {} };
  const ids = new Set([...Object.keys(history.cards), ...Object.keys(prices)]);
  const last = history.dates.length - 1;
  if (history.dates[last] === today) {
    for (const id of ids) {
      const s = history.cards[id] ?? new Array(history.dates.length).fill(null);
      while (s.length < history.dates.length) s.push(null);
      s[last] = prices[id]?.eur ?? null;
      history.cards[id] = s;
    }
  } else {
    history.dates.push(today);
    for (const id of ids) {
      const s = history.cards[id] ?? new Array(history.dates.length - 1).fill(null);
      while (s.length < history.dates.length - 1) s.push(null);
      s.push(prices[id]?.eur ?? null);
      history.cards[id] = s;
    }
    const cutoff = Date.parse(today) - HISTORY_DAYS * 86400000;
    let drop = 0;
    while (drop < history.dates.length - 1 && Date.parse(history.dates[drop]) < cutoff) drop++;
    if (drop > 0) {
      history.dates = history.dates.slice(drop);
      for (const id of Object.keys(history.cards)) history.cards[id] = history.cards[id].slice(drop);
    }
  }
  const pct = (t, p) => (t == null || p == null || p === 0 ? null : Math.round(((t - p) / p) * 1000) / 10);
  const agoIdx = (d) => {
    const tgt = Date.parse(today) - d * 86400000;
    for (let j = history.dates.length - 1; j >= 0; j--)
      if (Date.parse(history.dates[j]) <= tgt) return j;
    return -1;
  };
  const i7 = agoIdx(7);
  const i30 = agoIdx(30);
  const cards = {};
  for (const [id, p] of Object.entries(prices)) {
    const s = history.cards[id] ?? [];
    cards[id] = {
      eur: p.eur,
      usd: p.usd,
      d7: i7 >= 0 ? pct(p.eur, s[i7] ?? null) : null,
      d30: i30 >= 0 ? pct(p.eur, s[i30] ?? null) : null,
      ...(p.cm ? { cm: p.cm } : {}),
    };
  }
  const historyChanged = writeIfChanged(path, JSON.stringify(history));
  const summaryChanged = writeIfChanged(
    join(OUT, "prices", "summary.json"),
    JSON.stringify({
      updatedAt: today,
      source: "limitlesstcg.com",
      cardCount: Object.keys(cards).length,
      cards,
    }),
  );
  if (!historyChanged && !summaryChanged) {
    console.log("prices: no change since the last crawl — files left untouched");
  }
}

async function main() {
  if (process.argv.includes("--reprice")) {
    const s = JSON.parse(readFileSync(join(OUT, "prices", "summary.json"), "utf8"));
    buildPriceOutputs(s.cards);
    console.log("repriced: rebuilt history.json + d7/d30 summary from existing prices");
    return;
  }
  if (process.argv.includes("--rebuild")) {
    await rebuild();
    return;
  }

  const cardArg = process.argv.indexOf("--card");
  if (cardArg !== -1) {
    const id = process.argv[cardArg + 1];
    const html = await get(`/cards/${encodeURIComponent(id)}`);
    const base = parseCard(html);
    console.log("BASE", JSON.stringify({ id, ...base }, null, 1));
    const variants = await resolveVariants(id, html, base);
    console.log(`\nVARIANTS (${variants.length}):`);
    for (const v of variants)
      console.log(`  ${v.id}  set=${v.set}  rarity=${v.rarity}  eur=${v.eur}`);
    return;
  }

  mkdirSync(OUT, { recursive: true });
  const products = [...(await scrapeProducts()), ...(await scrapePromos())];
  writeFileSync(join(OUT, "products.json"), `${JSON.stringify(products, null, 2)}\n`);
  console.log(`taxonomy: ${products.length} products`);
  if (process.argv.includes("--taxonomy")) return;

  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg !== -1 ? new Set(process.argv[onlyArg + 1].split(",")) : null;
  const targets = products.filter((p) => p.slug && (!only || only.has(p.slug)));

  // Enumerate each product's membership (base + variant ids from image names).
  // Crawl only base pages; resolveVariants expands their alt arts/reprints.
  const membersByKey = new Map();
  const baseIds = new Set();
  for (const p of targets) {
    const key = p.code || p.slug;
    const ids = await enumerateCards(p.slug);
    membersByKey.set(key, ids);
    for (const id of ids) baseIds.add(basePrintId(id));
    console.log(`  ${key}: ${ids.length} cards`);
  }

  const queue = [...baseIds];
  console.log(`crawling ${queue.length} base cards...`);
  const byId = {};
  const prices = {};
  let done = 0;
  let failed = 0;
  let variantCount = 0;
  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      try {
        const html = await get(`/cards/${encodeURIComponent(id)}`);
        const { eur, usd, cm, ...card } = parseCard(html);
        byId[id] = { id, set: setOfImage(card.image), ...card };
        if (eur != null || usd != null || cm) prices[id] = { eur, usd, cm };
        for (const v of await resolveVariants(id, html, card)) {
          const { eur: ve, usd: vu, cm: vcm, id: vid, ...vcard } = v;
          if (byId[vid]) continue;
          byId[vid] = { id: vid, ...vcard };
          variantCount++;
          if (ve != null || vu != null || vcm) prices[vid] = { eur: ve, usd: vu, cm: vcm };
        }
      } catch {
        failed++;
      }
      if (++done % 200 === 0)
        console.log(`  ${done}/${baseIds.size} base (failed ${failed}, ${variantCount} variants)`);
    }
  }
  await Promise.all([worker(), worker()]);

  mkdirSync(join(OUT, "prices"), { recursive: true });
  const n = writeOutputs(byId, products, membersByKey);
  buildPriceOutputs(prices);
  console.log(
    `DONE: ${Object.keys(byId).length} cards, ${Object.keys(prices).length} priced, ${failed} failed, ${n} products`,
  );
}

main();
