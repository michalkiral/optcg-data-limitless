// Standard covers the newest STANDARD_BLOCKS blocks; everything older is Extra
// Regulation only. Derived from the catalog rather than hardcoded per season,
// so the April rotation needs no edit in the normal case.
export const STANDARD_BLOCKS = 4;

export function deriveCutoff(maxBlock, override) {
  if (typeof override === "number") {
    return { standardMinBlock: override, cutoffSource: "override" };
  }
  return {
    standardMinBlock: Math.max(1, maxBlock - (STANDARD_BLOCKS - 1)),
    cutoffSource: "derived",
  };
}

// Sorted output keeps the file byte-identical when nothing upstream moved, so
// the crawl workflow produces no commit and jsDelivr is not purged for nothing.
const sortPair = (pair) => [...pair].sort();

export function buildFormats({ updatedAt, maxBlock, override, restrictions }) {
  const { standardMinBlock, cutoffSource } = deriveCutoff(maxBlock, override);
  return {
    updatedAt,
    standardMinBlock,
    maxBlock,
    cutoffSource,
    banned: [...restrictions.banned].sort(),
    restricted: [...restrictions.restricted].sort(),
    bannedPairs: restrictions.bannedPairs
      .map(sortPair)
      .sort((a, b) => a.join().localeCompare(b.join())),
  };
}
