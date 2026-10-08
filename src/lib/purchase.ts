import "server-only";
import * as amazon from "./amazon";
import * as cards from "./cards";

/**
 * One-call purchase pipeline (the "fast path"). Runs the whole checkout server-side
 * in a single tool call instead of ~10 model round trips:
 *
 *   cart → checkout total → Laso card (reuse or buy, within the daily limit) →
 *   add card to Amazon → select it → verify "Paying with … last4" → place order
 *
 * Every safety gate of the step-by-step tools still applies. It is resumable: if a
 * step fails (e.g. Amazon's human check), calling it again skips what's done — the
 * item already in the cart isn't re-added and an unspent card is reused, not re-bought.
 */

export type Progress = { done: false; stage: string; label: string };
export type Outcome = { done: true; ok: boolean; stage: string } & Record<string, unknown>;

const step = (stage: string, label: string): Progress => ({ done: false, stage, label });
const fail = (stage: string, error: string, extra: Record<string, unknown> = {}): Outcome => ({ done: true, ok: false, stage, error, ...extra });

/** Places the order only if the review page pays with `last4` and the total matches the card. */
export async function guardedPlaceOrder(last4: string) {
  const review = await amazon.reviewState();
  if (!new RegExp(`\\b${last4}\\b`).test(review.paying)) {
    return { ok: false, error: `Refused: the order would be paid with "${review.paying || "an unknown method"}", not the card ending in ${last4}.` };
  }
  const shipTo = amazon.shipToMatch();
  if (shipTo && !review.delivering.toLowerCase().includes(shipTo.toLowerCase())) {
    return { ok: false, error: "Refused: the delivery address isn't the demo address." };
  }
  const summary = await amazon.checkoutSummary();
  const cardTotal = amazon.lastCheckoutTotal();
  if (cardTotal && summary.order_total_usd && Math.abs(summary.order_total_usd - cardTotal) > 0.005) {
    return { ok: false, error: `Refused: order total $${summary.order_total_usd} differs from the card amount $${cardTotal}.` };
  }
  const again = await amazon.reviewState();
  if (!new RegExp(`\\b${last4}\\b`).test(again.paying)) return { ok: false, error: "Refused: payment method changed before placing." };
  return amazon.placeOrder();
}

export async function* buyProduct(asin: string): AsyncGenerator<Progress | Outcome> {
  let stage = "cart";
  try {
    // 1. Cart — exactly this one item.
    yield step(stage, "Adding to cart");
    const cart = await amazon.viewCart();
    const others = cart.items.filter((i) => i.asin !== asin);
    if (others.length) return yield fail(stage, `The cart already has other items (${others.length}). Ask the user to empty it first.`);
    if (!cart.items.some((i) => i.asin === asin)) {
      const added = await amazon.addToCart(asin);
      if (!added.ok) return yield fail(stage, String(added.error ?? "Couldn't add to cart"));
    }

    // 2. Checkout — the total decides the card amount.
    stage = "checkout";
    yield step(stage, "Checking out");
    const co = await amazon.goToCheckout();
    if (!co.ok) return yield fail(stage, String((co as { error?: string }).error ?? "Couldn't reach checkout"));
    const total = amazon.lastCheckoutTotal();
    if (!total) return yield fail(stage, "Couldn't read the order total.");
    if (total < 5) return yield fail(stage, `Order total $${total.toFixed(2)} is below Laso's $5 card minimum.`);
    const maxCard = Number(process.env.CARD_MAX_USD ?? 50);
    if (total > maxCard) return yield fail(stage, `Order total $${total.toFixed(2)} exceeds the $${maxCard} card limit.`);

    // 3. Card — reuse an unspent one, else buy one for exactly the total (daily limit enforced inside).
    stage = "card";
    yield step(stage, `Getting a $${total.toFixed(2)} card with USDC`);
    const card = (await cards.order(total)) as { card_id: string; reused?: boolean };
    stage = "card_ready";
    yield step(stage, card.reused ? "Reusing an unspent card" : "Waiting for the card");
    const ready = (await cards.waitUntilReady(card.card_id)) as { status?: string };
    if (ready.status !== "ready") return yield fail(stage, `Card isn't ready (status ${ready.status ?? "unknown"}).`, { card_id: card.card_id });
    const full = await cards.reveal(card.card_id);
    const last4 = full.pan.slice(-4);

    // 4. Add the card to Amazon (skipped if already saved).
    stage = "add_card";
    yield step(stage, "Adding the card to Amazon");
    const name = process.env.CARD_HOLDER_NAME ?? "";
    if (!name) return yield fail(stage, "CARD_HOLDER_NAME is not set.");
    const added = await amazon.addCard({
      pan: full.pan,
      mm: String(full.exp_month).padStart(2, "0"),
      yy: String(full.exp_year).slice(-2),
      name,
      cvv: full.cvv,
    });
    if (!added.ok) return yield fail(stage, String((added as { error?: string }).error ?? "Couldn't add the card"), { card_last4: last4 });

    // 5. Back to checkout, select the card, and confirm the total didn't move.
    stage = "select";
    yield step(stage, "Selecting the card");
    const co2 = await amazon.goToCheckout();
    if (!co2.ok) return yield fail(stage, String((co2 as { error?: string }).error ?? "Couldn't return to checkout"));
    const total2 = amazon.lastCheckoutTotal();
    if (!total2 || Math.abs(total2 - total) > 0.005) return yield fail(stage, `The total changed from $${total.toFixed(2)} to $${total2?.toFixed(2)}.`);
    const sel = await amazon.selectCardAtCheckout(last4);
    if (!sel.ok) return yield fail(stage, String(sel.error ?? `Couldn't select the card ending in ${last4}`), { card_last4: last4 });

    // 6. Place the order behind the hard gate.
    stage = "place";
    yield step(stage, "Placing the order");
    const placed = (await guardedPlaceOrder(last4)) as Record<string, unknown>;
    if (!placed.ok) return yield fail(stage, String(placed.error ?? "Order wasn't placed"), { card_last4: last4 });

    return yield {
      done: true,
      ok: true,
      stage: "done",
      total_usd: total,
      card_last4: last4,
      card_reused: Boolean(card.reused),
      delivery: placed.delivery,
      confirmation: placed.text,
    };
  } catch (err) {
    return yield fail(stage, err instanceof Error ? err.message : String(err));
  }
}
