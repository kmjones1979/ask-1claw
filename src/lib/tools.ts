import "server-only";
import { tool } from "ai";
import { z } from "zod";
import * as browser from "./browser";
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

async function safe<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const tools = {
  // ── 1Claw: onchain wallet + cards ────────────────────────────────────────
  get_wallet_balance: tool({
    description: "Get the agent's USDC balance on Base from its 1Claw wallet.",
    inputSchema: z.object({}),
    execute: () => safe(() => oneclaw.getUsdcBalance()),
  }),

  issue_card: tool({
    description:
      "Buy a prepaid virtual card from Laso Finance through 1Claw, paid with the agent's USDC on Base (x402). " +
      "Returns a masked card (id, status, last4). May require human approval in the 1Claw app. " +
      "Order enough to cover the item, tax and shipping with a small buffer.",
    inputSchema: z.object({
      amount_usd: z.string().describe('Amount to load, e.g. "30.00"'),
    }),
    execute: ({ amount_usd }) =>
      safe(async () => {
        if (Number(amount_usd) > MAX_CARD_USD) {
          return { ok: false, error: `Amount exceeds the $${MAX_CARD_USD} demo limit.` };
        }
        return oneclaw.orderCard(Number(amount_usd).toFixed(2));
      }),
  }),

  wait_for_card: tool({
    description:
      "Wait until an ordered card is approved and ready to use (polls up to ~4 minutes). Returns masked card status.",
    inputSchema: z.object({ card_id: z.string() }),
    execute: ({ card_id }) => safe(() => oneclaw.waitForCard(card_id)),
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
        const card = await oneclaw.revealCard(card_id);
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
      }),
  }),

  // ── Browser (via 1Claw browser-bridge) ───────────────────────────────────
  browser_navigate: tool({
    description: "Open a URL in the agent's browser. Returns a page snapshot (indexed elements + text).",
    inputSchema: z.object({ url: z.string() }),
    execute: ({ url }) => safe(() => browser.navigate(url)),
  }),

  browser_snapshot: tool({
    description: "Re-read the current page: URL, title, indexed interactive elements, and visible text.",
    inputSchema: z.object({}),
    execute: () => safe(() => browser.snapshot()),
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
    execute: (input) => safe(() => browser.click(input)),
  }),

  browser_type: tool({
    description: "Type text into a field (clicks it first if index or x/y given). Set submit to press Enter after.",
    inputSchema: z.object({
      text: z.string(),
      submit: z.boolean().optional(),
      ...locator,
    }),
    execute: ({ text, ...opts }) => safe(() => browser.typeText(text, opts)),
  }),

  browser_select: tool({
    description: "Choose an option in a <select> dropdown by snapshot index.",
    inputSchema: z.object({ index: z.number().int(), option: z.string() }),
    execute: ({ index, option }) => safe(() => browser.selectOption(index, option)),
  }),

  browser_press_key: tool({
    description: 'Press a keyboard key, e.g. "Enter", "Tab", "Escape".',
    inputSchema: z.object({ key: z.string() }),
    execute: ({ key }) => safe(() => browser.pressKey(key)),
  }),

  browser_scroll: tool({
    description: "Scroll the page vertically by a number of pixels (negative scrolls up).",
    inputSchema: z.object({ dy: z.number() }),
    execute: ({ dy }) => safe(() => browser.scroll(dy)),
  }),
};
