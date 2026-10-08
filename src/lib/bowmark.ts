import "server-only";
import { bowmark } from "@bowmark/web";

/**
 * Bowmark (https://bowmark.ai) — hosted, typed functions for live websites, via the official
 * zero-dependency client @bowmark/web (MIT). The typed surface catches argument mistakes in
 * our own process before any request is made.
 *
 * Used ONLY for public, read-only discovery (Amazon product search). It runs in Bowmark's own
 * browsers, so searching doesn't load pages in the user's signed-in session (fewer bot checks
 * there). Anything signed-in or payment-related — cart, card, checkout — stays on 1Claw
 * browser-bridge: Bowmark's sessions live on its servers and its browser agent takes only a
 * plain-text task, so a card number or login would have to leave our control. Bowmark sees only
 * the query text.
 */

export function enabled() {
  return Boolean(process.env.BOWMARK_API_KEY);
}

type Product = { asin?: string; title?: string; price?: number | null; rating?: number | null; ratingCount?: number | null; sponsored?: boolean };

/** Amazon search via Bowmark, shaped like our bridge search results. */
export async function amazonSearch(query: string, limit = 8) {
  const started = Date.now();
  const r = (await bowmark.providers.amazon.searchProducts({ keywords: query })) as {
    products?: Product[];
    warnings?: unknown[];
  };
  const warnings = r.warnings ?? [];
  console.log(`[bowmark] amazon.searchProducts ${Date.now() - started}ms, ${r.products?.length ?? 0} products${warnings.length ? `, warnings: ${JSON.stringify(warnings).slice(0, 200)}` : ""}`);
  const results = (r.products ?? [])
    .filter((p) => p.asin && p.title && typeof p.price === "number" && !p.sponsored)
    .slice(0, limit)
    .map((p) => ({
      asin: p.asin!,
      title: p.title!.slice(0, 120),
      price: `$${p.price!.toFixed(2)}`,
      rating: p.rating != null ? String(p.rating) : undefined,
      reviews: p.ratingCount != null ? `(${p.ratingCount})` : undefined,
    }));
  // A thin answer (dropped sources / nothing usable) should fall back to the bridge search.
  if (!results.length) throw new Error(`Bowmark returned no usable products${warnings.length ? " (warnings present)" : ""}`);
  return results;
}
