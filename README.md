# optcg-data-limitless

A static, versioned JSON catalog of One Piece Card Game **cards and prices**, scraped from
[Limitless TCG](https://onepiece.limitlesstcg.com/cards) in a single crawl and served over
jsDelivr. Drop-in data source for the portfolio's OPTCG Collection app.

This is the **single-source** successor to `optcg-data` (which combined Bandai's cardlist via
vegapull for card data with a separate Limitless scrape for prices). Because card ids **and**
prices now come from the same place, there is nothing to map — the entire price-mapping layer
(printmap, price-map pins, set guardrail, unmapped/fix tooling) is gone.

## Organisation

Mirrors Limitless's own taxonomy: products grouped into **Booster Packs**, **Starter Decks**,
and **Promos** (its Products + Promos pages). Each card's `set` is its base product; alt arts
and reprints live under the same base set, exactly as Limitless groups them.

## Data layout

```
data/
  products.json              # raw Limitless taxonomy (category, code, name, release, count, slug)
  packs.json                 # [{ code, name, category, releaseDate, cardCount, listedCount, slug }]
  cards/<CODE>.json          # cards in a product (base + alt arts/reprints)
  index/cards_by_id.json     # every card by id
  prices/summary.json        # { cards: { id: { eur, usd, d7, d30 } } }
  prices/history.json        # rolling 120-day EUR history
overrides/
  custom-prints.json         # hand-curated prints Limitless lacks (rarely needed)
```

Card schema: `id, set, name, rarity, category, colors, cost, power, counter, block,
attributes, types, effect, trigger, image`.

## Pipeline

```bash
npm run taxonomy   # just the product list (2 fetches)
npm run build      # full crawl: taxonomy → per-product cards → each card's data + variants + price
```

`scripts/build.mjs`:
1. Scrapes `/cards` and `/cards/promos` for the product taxonomy.
2. Enumerates each product's base cards.
3. Fetches each card page for the full card data + its current price, and resolves alt
   arts / reprints via the version pages (their ids come from Limitless's image filenames).
4. Writes the data layout above and appends today's prices to the rolling history.

A daily GitHub Action (`.github/workflows/crawl.yml`, plus manual dispatch) runs the crawl,
commits `data/`, and purges the jsDelivr edge cache. Limitless throttles the Actions IP, so
the crawl runs at concurrency 2 with backoff (~30 min).
