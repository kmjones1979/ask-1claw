import "server-only";
import { tool } from "ai";
import { z } from "zod";
import * as amazon from "./amazon";
import * as browser from "./browser";
import * as cards from "./cards";
import * as laso from "./laso";
import * as purchase from "./purchase";
import { wrapExternalContent } from "./promptSecurity";
import * as oneclaw from "./oneclaw";

const MAX_CARD_USD = Number(process.env.CARD_MAX_USD ?? 50);

const locator = {
  index: z.number().int().optional().describe("Element index from the latest snapshot"),
  x: z.number().optional().describe("Viewport x coordinate from the latest screenshot (use for elements inside iframes)"),
  y: z.number().optional().describe("Viewport y coordinate from the latest screenshot"),
};

const asImage = (output: { image: string; note?: string }) => ({
  type: "content" as const,
  value: [
    ...(output.note ? [{ type: "text" as const, text: output.note }] : []),
    {
      type: "file" as const,
      filename: "screenshot.jpg",
      mediaType: "image/jpeg",
      data: { type: "data" as const, data: output.image },
    },
  ],
});

/**
 * Address privacy: strip street addresses, ZIP+4s and phone numbers from everything a
 * tool returns, so the user's address never reaches the model, the transcript or the voice.
 */
const STREET =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'#-]+\s+){0,6}(?:ST|STREET|AVE|AVENUE|CT|COURT|RD|ROAD|BLVD|BOULEVARD|DR|DRIVE|LN|LANE|WAY|PL|PLACE|PKWY|PARKWAY|HWY|HIGHWAY|CIR|CIRCLE|TER|TERRACE|SQ|LOOP|TRL|TRAIL)\b\.?[^\n]*/gi;
const CITY_STATE_ZIP = /\b[A-Za-z][A-Za-z .'-]{1,30},\s*[A-Z]{2},?\s+\d{5}(?:-\d{4})?\b/g;
const ZIP4 = /\b\d{5}-\d{4}\b/g;
// Amazon's header: "Deliver to Kevin\nWillis 77318" (city + ZIP).
const DELIVER_TO = /(Deliver(?:ing)? to[^\n]*\n\s*)[A-Za-z][A-Za-z .'-]{1,30}\s+\d{5}(?:-\d{4})?/g;
const CITY_ZIP = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s\d{5}(?:-\d{4})?\b(?!\s*(?:mAh|mm|pcs|count|pack))/g;
const PHONE = /(?:Phone(?: number)?:?\s*)?‪?\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}‬?/g;

function redactText(t: string) {
  return t
    .replace(DELIVER_TO, "$1[address hidden]")
    .replace(STREET, "[address hidden]")
    .replace(CITY_STATE_ZIP, "[address hidden]")
    .replace(ZIP4, "[zip hidden]")
    .replace(CITY_ZIP, "[address hidden]")
    .replace(PHONE, "[phone hidden]");
}

function redact<T>(v: T): T {
  if (typeof v === "string") return redactText(v) as T;
  if (Array.isArray(v)) return v.map(redact) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) =>
        // Screenshots stay as-is (binary); everything textual is scrubbed.
        k === "image" ? [k, x] : [k, redact(x)],
      ),
    ) as T;
  }
  return v;
}

/** Page-sourced text goes to the model wrapped as untrusted external content. */
function wrapSnapshot<T extends { text?: string; elements?: string }>(snap: T): T {
  return {
    ...snap,
    ...(typeof snap.text === "string" ? { text: wrapExternalContent(snap.text, "page-text") } : {}),
    ...(typeof snap.elements === "string" ? { elements: wrapExternalContent(snap.elements, "page-elements") } : {}),
  };
}
function wrapConfirmation<T>(r: T): T {
  const o = r as Record<string, unknown>;
  for (const k of ["text", "confirmation"]) {
    if (typeof o?.[k] === "string") o[k] = wrapExternalContent(o[k] as string, "order-confirmation");
  }
  return r;
}

/** Runs a tool with a hard timeout so a stuck page can never hang the agent, and logs timing. */
async function safe<T>(fn: () => Promise<T>, name = "tool", timeoutMs = 60_000) {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return redact(await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[tool] ${name} failed: ${error}`);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
    // Keep the saved Amazon session fresh (throttled) so clearances and logins persist.
    if (name.startsWith("amazon_")) void browser.saveCookies().catch(() => {});
    console.log(`[tool] ${name} ${Date.now() - started}ms`);
  }
}

export const tools = {
  // ── 1Claw: onchain wallet + cards ────────────────────────────────────────
  get_wallet_balance: tool({
    description: "Get the agent's USDC balance on Base from its 1Claw wallet, plus its daily spending limit and how much is left today.",
    inputSchema: z.object({}),
    execute: () => safe(async () => ({ ...(await oneclaw.getUsdcBalance()), daily_limit: laso.spendStatus() }), "get_wallet_balance"),
  }),

  issue_card: tool({
    description:
      "Buy a prepaid virtual card from Laso Finance, paid with the agent's USDC on Base over x402 (signed by its 1Claw key), " +
      "for EXACTLY the order total shown at Amazon checkout. Call amazon_checkout first — the amount is taken from it, not chosen by you. " +
      "Returns a masked card (id, status, last4). If it fails, do not retry more than once.",
    inputSchema: z.object({}),
    execute: () =>
      safe(async () => {
        const total = amazon.lastCheckoutTotal();
        if (!total) return { ok: false, error: "No checkout total yet. Call amazon_checkout first so the card matches the order total." };
        if (total < 5) return { ok: false, error: `Order total $${total.toFixed(2)} is below Laso's $5 card minimum.` };
        if (total > MAX_CARD_USD) return { ok: false, error: `Order total $${total.toFixed(2)} exceeds the $${MAX_CARD_USD} card limit.` };
        return cards.order(total);
      }, "issue_card"),
  }),

  wait_for_card: tool({
    description:
      "Wait until an ordered card is approved and ready to use (polls up to ~4 minutes). Returns masked card status.",
    inputSchema: z.object({ card_id: z.string() }),
    execute: ({ card_id }) => safe(() => cards.waitUntilReady(card_id), "wait_for_card", 300_000),
  }),

  fill_payment_card: tool({
    description:
      "Securely type the 1Claw card's details into a checkout form. You never see the card number — just say where each field is. " +
      "Use element indexes for normal fields, or x/y from a screenshot for fields inside a payment iframe.",
    inputSchema: z.object({
      card_id: z.string(),
      fields: z
        .array(
          z.object({
            field: z.enum(["number", "cvv", "name", "exp_month", "exp_year", "exp_mm_yy", "zip"]),
            is_select: z.boolean().optional().describe("True if the field is a <select> dropdown (index required)"),
            ...locator,
          }),
        )
        .min(1),
    }),
    execute: ({ card_id, fields }) =>
      safe(async () => {
        const card = await cards.reveal(card_id);
        const billing = oneclaw.billingProfile();
        const mm = String(card.exp_month ?? "").padStart(2, "0");
        const yyyy = String(card.exp_year ?? "");
        const values: Record<string, string> = {
          number: card.pan ?? "",
          cvv: card.cvv ?? "",
          name: billing.name,
          exp_month: mm,
          exp_year: yyyy,
          exp_mm_yy: `${mm}/${yyyy.slice(-2)}`,
          zip: billing.zip,
        };
        const missing = fields.filter((f) => !values[f.field]).map((f) => f.field);
        if (missing.length) return { ok: false, error: `No value available for: ${missing.join(", ")}` };
        const r = await browser.typeSecrets(
          fields.map((f) => ({ value: values[f.field], index: f.index, x: f.x, y: f.y, isSelect: f.is_select })),
        );
        return { ...r, filled: fields.map((f) => f.field), card_last4: card.pan?.slice(-4) };
      }, "fill_payment_card"),
  }),

  // ── Fast path: two calls for the whole purchase ────────────────────────
  find_product: tool({
    description:
      "Search Amazon and return the top few non-sponsored products (asin, title, price, rating). Use this first, then pick one and call buy_product.",
    inputSchema: z.object({ query: z.string() }),
    execute: ({ query }) =>
      safe(async () => {
        const r = await amazon.search(query);
        return { results: r.results.slice(0, 6) };
      }, "find_product"),
  }),

  buy_product: tool({
    description:
      "Buy one product end to end in a single call: add to cart, read the checkout total, get a Laso card for exactly that total " +
      "(reusing an unspent one; daily USDC limit enforced), add it to Amazon, select it, verify the payment line, and place the order. " +
      "Returns the delivery estimate. Safe to call again after fixing a problem (e.g. a human check) — it resumes without double-buying.",
    inputSchema: z.object({ asin: z.string().describe("ASIN from find_product") }),
    execute: async function* ({ asin }) {
      const started = Date.now();
      let last = "";
      try {
        for await (const update of purchase.buyProduct(asin)) {
          last = update.stage;
          if (!update.done) console.log(`[buy_product] ${update.stage}: ${update.label}`);
          yield redact(update.done ? wrapConfirmation(update) : update);
        }
      } finally {
        console.log(`[tool] buy_product ${Date.now() - started}ms (last stage: ${last})`);
        void browser.saveCookies().catch(() => {});
      }
    },
  }),

  // ── Amazon fast path (one call per checkout stage) ──────────────────────
  amazon_search: tool({
    description: "Search Amazon. Returns the top non-sponsored results (asin, title, price, rating) and who is signed in.",
    inputSchema: z.object({ query: z.string() }),
    execute: ({ query }) => safe(() => amazon.search(query), "amazon_search"),
  }),

  amazon_add_to_cart: tool({
    description: "Open a product by ASIN and add it to the cart (declines protection-plan upsells).",
    inputSchema: z.object({ asin: z.string() }),
    execute: ({ asin }) => safe(() => amazon.addToCart(asin), "amazon_add_to_cart"),
  }),

  amazon_add_1claw_card: tool({
    description:
      "Add the 1Claw card (from issue_card / wait_for_card) to the Amazon account as a payment method, in one step. " +
      "The card number is fetched and typed server-side — you never see it. Call this after the card is ready and BEFORE amazon_checkout. Returns last4.",
    inputSchema: z.object({ card_id: z.string() }),
    execute: ({ card_id }) =>
      safe(async () => {
        const card = await cards.reveal(card_id);
        if (!card.pan || !card.exp_month || !card.exp_year) return { ok: false, error: "Card details aren't available yet." };
        const name = oneclaw.billingProfile().name;
        if (!name) return { ok: false, error: "CARD_HOLDER_NAME is not set in .env." };
        return amazon.addCard({
          pan: card.pan,
          mm: String(card.exp_month).padStart(2, "0"),
          yy: String(card.exp_year).slice(-2),
          name,
          cvv: card.cvv,
        });
      }, "amazon_add_1claw_card", 90_000),
  }),

  amazon_select_card: tool({
    description: "On the checkout page, select the card ending in last4 as the payment method. Returns the updated checkout summary.",
    inputSchema: z.object({ last4: z.string().length(4) }),
    execute: ({ last4 }) => safe(() => amazon.selectCardAtCheckout(last4), "amazon_select_card"),
  }),

  amazon_wait_for_human: tool({
    description:
      "After asking the user to tick Amazon's 'I am human' check in the browser, wait (up to 2 minutes) until it's cleared.",
    inputSchema: z.object({}),
    execute: () => safe(() => amazon.waitForHuman(), "amazon_wait_for_human", 130_000),
  }),

  amazon_checkout: tool({
    description:
      "Go from the cart to the checkout page. Returns cart items, shipping address, current payment method, order total and delivery estimate.",
    inputSchema: z.object({}),
    execute: () => safe(() => amazon.goToCheckout(), "amazon_checkout"),
  }),

  amazon_checkout_summary: tool({
    description: "Re-read the checkout page summary (address, payment, total, delivery) after changing something.",
    inputSchema: z.object({}),
    execute: () => safe(() => amazon.checkoutSummary(), "amazon_checkout_summary"),
  }),

  amazon_place_order: tool({
    description:
      "Click 'Place your order' and return the confirmation (delivery estimate, order number). " +
      "Hard-refuses unless the review page's 'Paying with' line shows the card ending in last4 and the total equals the card amount.",
    inputSchema: z.object({ last4: z.string().length(4).describe("Last 4 of the Laso/1Claw card selected for this order") }),
    execute: ({ last4 }) => safe(async () => wrapConfirmation(await purchase.guardedPlaceOrder(last4)), "amazon_place_order"),
  }),

  // ── Browser (via 1Claw browser-bridge) ───────────────────────────────────
  browser_navigate: tool({
    description: "Open a URL in the agent's browser. Returns a page snapshot (indexed elements + text).",
    inputSchema: z.object({ url: z.string() }),
    execute: ({ url }) => safe(async () => wrapSnapshot(await browser.navigate(url)), "browser_navigate"),
  }),

  browser_snapshot: tool({
    description: "Re-read the current page: URL, title, indexed interactive elements, and visible text.",
    inputSchema: z.object({}),
    execute: () => safe(async () => wrapSnapshot(await browser.snapshot()), "browser_snapshot"),
  }),

  browser_screenshot: tool({
    description:
      "Take a screenshot of the viewport (1280x860). Use when the snapshot isn't enough, e.g. to locate fields inside iframes for x/y clicks.",
    inputSchema: z.object({}),
    execute: async () => ({ image: await browser.screenshot() }),
    toModelOutput: ({ output }) => asImage(output),
  }),

  browser_click: tool({
    description: "Click an element by snapshot index, or at x/y viewport coordinates.",
    inputSchema: z.object(locator),
    execute: (input) => safe(() => browser.click(input), "browser_click"),
  }),

  browser_type: tool({
    description: "Type text into a field (clicks it first if index or x/y given). Set submit to press Enter after.",
    inputSchema: z.object({
      text: z.string(),
      submit: z.boolean().optional(),
      ...locator,
    }),
    execute: ({ text, ...opts }) => safe(() => browser.typeText(text, opts), "browser_type"),
  }),

  browser_select: tool({
    description: "Choose an option in a <select> dropdown by snapshot index.",
    inputSchema: z.object({ index: z.number().int(), option: z.string() }),
    execute: ({ index, option }) => safe(() => browser.selectOption(index, option), "browser_select"),
  }),

  browser_press_key: tool({
    description: 'Press a keyboard key, e.g. "Enter", "Tab", "Escape".',
    inputSchema: z.object({ key: z.string() }),
    execute: ({ key }) => safe(() => browser.pressKey(key), "browser_press_key"),
  }),

  browser_scroll: tool({
    description: "Scroll the page vertically by a number of pixels (negative scrolls up).",
    inputSchema: z.object({ dy: z.number() }),
    execute: ({ dy }) => safe(() => browser.scroll(dy), "browser_scroll"),
  }),
};
