// Bandai's banned/restricted list, parsed from the official rules page.
// https://en.onepiece-cardgame.com/rules/restriction/
//
// The page carries the card numbers twice: once in whichever announcement is
// newest, and once under "Cards with Active Restrictions", which is the
// cumulative truth. Only the cumulative section is parsed — the notice repeats
// the same headings and would otherwise contribute one update's cards as if
// they were the whole list.
const SECTION = "Cards with Active Restrictions";

// Every listed card links to the cardlist with the exact number in freewords,
// which is a far steadier anchor than the human-readable link text.
const NUMBER = /freewords=([A-Z]{1,2}\d{2}-\d{3}|P-\d{3})/g;

function activeSection(html) {
  const at = html.indexOf(SECTION);
  if (at === -1) {
    throw new Error(`restriction page: no "${SECTION}" section`);
  }
  const afterHeading = html.indexOf("</h3>", at);
  const rest = html.slice(afterHeading === -1 ? at : afterHeading);
  const nextHeading = rest.indexOf("<h3");
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function underHeading(section, title) {
  const heads = [...section.matchAll(/<h4>([^<]*)<\/h4>/g)];
  const i = heads.findIndex((head) => head[1].trim() === title);
  if (i === -1) {
    throw new Error(`restriction page: no "${title}" heading`);
  }
  const from = heads[i].index + heads[i][0].length;
  const to = i + 1 < heads.length ? heads[i + 1].index : section.length;
  return section.slice(from, to);
}

// One group per list, because a banned pair is a list of exactly two cards and
// the pairing is expressed only by which list a card sits in.
function groups(slice) {
  return [...slice.matchAll(/<ul>([\s\S]*?)<\/ul>/g)].map((list) =>
    [...list[1].matchAll(NUMBER)].map((match) => match[1]),
  );
}

export function parseRestrictions(html) {
  const section = activeSection(html);
  return {
    banned: groups(underHeading(section, "Banned Cards")).flat(),
    restricted: groups(underHeading(section, "Restricted Cards")).flat(),
    bannedPairs: groups(underHeading(section, "Banned Pair Cards")),
  };
}

/** Returns a list of problems; empty means the parse can be trusted. */
export function validateRestrictions(parsed, isKnownCard) {
  const errors = [];
  // An empty list is the failure that would silently declare every deck legal,
  // so it is treated as a broken parse rather than as "nothing is banned".
  if (parsed.banned.length === 0) {
    errors.push("no banned cards parsed — the page shape probably changed");
  }
  for (const pair of parsed.bannedPairs) {
    if (pair.length !== 2) {
      errors.push(`banned pair is not two cards: ${pair.join(", ") || "(empty)"}`);
    }
  }
  for (const id of [...parsed.banned, ...parsed.restricted, ...parsed.bannedPairs.flat()]) {
    if (!isKnownCard(id)) {
      errors.push(`unknown card number: ${id}`);
    }
  }
  return errors;
}
