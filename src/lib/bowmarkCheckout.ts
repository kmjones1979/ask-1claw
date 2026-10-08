import "server-only";
import * as agent from "./bowmarkAgent";
import * as cards from "./cards";

/**
 * EXPERIMENTAL full checkout on Bowmark's hosted browser agent (EXPERIMENT_BOWMARK_CHECKOUT=true).
 *
 * Measured against the browser-bridge pipeline on the same product (2026-10-08):
 *   product page → cart → checkout (sign-in wall): Bowmark 109.3s vs browser-bridge 9.1s.
 * It also needs a human to sign in at the watch link on every run, and the card details go to
 * Bowmark's agent in plain text (mitigated by using a single-use Laso card loaded for this order
 * only). Kept for comparison; buy_product remains the demo path.
 */
type Update = { done: boolean; stage: string; [k: string]: unknown };

export async function* buyViaBowmark(asin: string, expectedPriceUsd: number): AsyncGenerator<Update, void, unknown> {
  const t0 = Date.now();
  // The total isn't known before Bowmark reaches checkout, so load the card with headroom for
  // tax/shipping (an unspent remainder stays usable at other US merchants).
  const amount = Math.min(Number(process.env.CARD_MAX_USD ?? 50), Math.ceil(expectedPriceUsd * 1.15 + 1));
  yield { done: false, stage: "card", label: `Getting a $${amount} single-use card` };
  const card = (await cards.order(amount)) as { card_id: string };
  const ready = (await cards.waitUntilReady(card.card_id)) as { status?: string };
  if (ready.status !== "ready") {
    yield { done: true, ok: false, stage: "card", error: "Card isn't ready." };
    return;
  }
  const c = await cards.reveal(card.card_id);

  const task =
    `On www.amazon.com, buy one unit of https://www.amazon.com/dp/${asin}. Add it to the cart and check out, ` +
    `shipping to the account's default address. Pay with a NEW credit card: number ${c.pan}, expiry ` +
    `${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year).slice(-2)}, name "${process.env.CARD_HOLDER_NAME ?? ""}"` +
    `${c.cvv ? `, CVV ${c.cvv}` : ""}. Use the default billing address. Do NOT make this card the default payment method. ` +
    `Only place the order if the order total is at most $${amount.toFixed(2)}. Report the result.`;

  for await (const e of agent.runAgent(task, {
    deadlineMs: 6 * 60_000,
    outputSchema: {
      type: "object",
      properties: {
        orderPlaced: { type: "boolean" },
        orderTotal: { type: "string" },
        deliveryDate: { type: "string" },
        note: { type: "string" },
      },
      required: ["orderPlaced"],
    },
  })) {
    if (e.phase === "needs_input") {
      yield { done: false, stage: "sign_in", label: "Sign in at Bowmark's watch link", watchUrl: e.watchUrl };
    } else if (e.phase === "running" || e.phase === "started") {
      yield { done: false, stage: "bowmark", label: `Bowmark agent working (${Math.round(e.ms / 1000)}s)`, watchUrl: e.watchUrl };
    } else {
      const result = (e.result ?? {}) as { orderPlaced?: boolean };
      yield {
        done: true,
        ok: e.phase === "done" && Boolean(result.orderPlaced),
        stage: e.phase,
        seconds: Math.round((Date.now() - t0) / 1000),
        card_last4: c.pan.slice(-4),
        result: e.result,
      };
      return;
    }
  }
}
