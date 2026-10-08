import "server-only";

/**
 * Bowmark (https://bowmark.ai) — hosted, typed functions for live websites.
 *
 * Used ONLY for public, read-only discovery (Amazon product search). It runs in
 * Bowmark's own browsers, so searching doesn't load pages in the user's signed-in
 * session (fewer bot checks there). Anything signed-in or payment-related — cart,
 * card, checkout — stays on 1Claw browser-bridge. Bowmark sees only the query text.
 */

const API = "https://api.bowmark.ai/v1";

export function enabled() {
  return Boolean(process.env.BOWMARK_API_KEY);
}

async function run<T>(script: string, timeoutMs = 20_000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.BOWMARK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ script }),
      signal: ctl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
    if (!res.ok || !body.ok) throw new Error(`Bowmark run failed (${res.status}): ${body.error ?? "unknown"}`);
    return body.result as T;
  } finally {
    clearTimeout(t);
  }
}

type BowmarkProduct = { asin?: string; title?: string; price?: number | null; rating?: number | null; ratingCount?: number | null; sponsored?: boolean };

/** Amazon search via Bowmark, shaped like our bridge search results. */
export async function amazonSearch(query: string, limit = 8) {
  const r = await run<{ products?: BowmarkProduct[] }>(
    `return await bowmark.providers.amazon.searchProducts({ keywords: ${JSON.stringify(query)} });`,
  );
  return (r.products ?? [])
    .filter((p) => p.asin && p.title && typeof p.price === "number" && !p.sponsored)
    .slice(0, limit)
    .map((p) => ({
      asin: p.asin!,
      title: p.title!.slice(0, 120),
      price: `$${p.price!.toFixed(2)}`,
      rating: p.rating != null ? String(p.rating) : undefined,
      reviews: p.ratingCount != null ? `(${p.ratingCount})` : undefined,
    }));
}
