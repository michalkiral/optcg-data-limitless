import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseRestrictions, validateRestrictions } from "./restrictions.mjs";

const html = readFileSync(join(import.meta.dirname, "fixtures", "restriction.html"), "utf8");

test("reads the cumulative banned list, not the dated notice", () => {
  const { banned } = parseRestrictions(html);
  assert.deepEqual(banned.slice().sort(), [
    "OP03-040",
    "OP06-047",
    "OP06-086",
    "OP06-116",
    "ST10-001",
  ]);
});

test("an empty Restricted section is empty, not an error", () => {
  assert.deepEqual(parseRestrictions(html).restricted, []);
});

test("keeps each banned pair as its own two-card group", () => {
  const { bannedPairs } = parseRestrictions(html);
  assert.equal(bannedPairs.length, 3);
  assert.ok(bannedPairs.every((pair) => pair.length === 2));
  assert.deepEqual(
    bannedPairs.map((pair) => pair.join("+")).sort(),
    ["OP07-115+EB04-058", "OP11-040+OP08-069", "OP11-040+OP11-067"].sort(),
  );
});

test("throws when the cumulative section is gone", () => {
  assert.throws(() => parseRestrictions("<p>nothing here</p>"), /Active Restrictions/);
});

test("throws when a heading it needs is gone", () => {
  // replaceAll, not replace: the dated notice above the cumulative section has
  // a heading of the same name, and swapping only that one leaves the section
  // this parser actually reads intact.
  const trimmed = html.replaceAll("Banned Pair Cards", "Something Else");
  assert.throws(() => parseRestrictions(trimmed), /Banned Pair Cards/);
});

const knowsEverything = () => true;

test("valid input produces no errors", () => {
  assert.deepEqual(validateRestrictions(parseRestrictions(html), knowsEverything), []);
});

test("an empty banned list is an error, because that is the dangerous failure", () => {
  const errors = validateRestrictions(
    { banned: [], restricted: [], bannedPairs: [] },
    knowsEverything,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no banned cards/);
});

test("a pair that is not two cards is an error", () => {
  const errors = validateRestrictions(
    { banned: ["OP03-040"], restricted: [], bannedPairs: [["OP11-040"]] },
    knowsEverything,
  );
  assert.match(errors[0], /OP11-040/);
});

test("a card number the catalog does not know is an error", () => {
  const errors = validateRestrictions(
    { banned: ["ZZ99-999"], restricted: [], bannedPairs: [] },
    (id) => id !== "ZZ99-999",
  );
  assert.match(errors[0], /ZZ99-999/);
});
