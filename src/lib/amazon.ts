import "server-only";
import { fastGoto, getBrowser } from "./browser";

/**
 * Amazon-specific macros. Each one replaces a dozen generic snapshot/click round
 * trips with a single server-side step, which is what makes the demo fast.
 * They only use Runtime.evaluate + Input events, so they pass the bridge's CDP gate.
 */

const AMZ = "https://www.amazon.com";

async function page() {
  return (await getBrowser()).page;
}

/**
 * Amazon sometimes interposes an "I am human" / CAPTCHA page. We never solve it
 * automatically — the agent asks the person at the keyboard to tick it, then
 * calls waitForHuman().
 */
const HUMAN_CHECK_ERROR =
  "HUMAN_CHECK: Amazon is showing an 'I am human' check. Ask the user (one short sentence) to tick the box in the browser window, then call amazon_wait_for_human and retry this step.";

async function humanCheckShowing() {
  const p = await page();
  return p
    .evaluate(
      () =>
        Boolean(document.querySelector("form[action*='validateCaptcha'], #captchacharacters")) ||
        /check the box to continue|i am human|enter the characters you see/i.test(document.body?.innerText.slice(0, 3000) ?? ""),
    )
    .catch(() => false);
}

async function guardHuman() {
  if (await humanCheckShowing()) throw new Error(HUMAN_CHECK_ERROR);
}

export async function waitForHuman(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await humanCheckShowing())) return { ok: true, url: (await page()).url() };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, error: "The human check is still showing." };
}

async function goto(url: string) {
  const p = await fastGoto(url);
  await guardHuman();
  return p;
}

/** Wait until any selector matches (or text appears). Returns the matching key, or null on timeout. */
async function waitForAny(selectors: Record<string, string>, timeout = 12_000) {
  const p = await page();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = await p
      .evaluate((sels: Record<string, string>) => {
        for (const [k, s] of Object.entries(sels)) {
          if (s.startsWith("text=")) {
            if (document.body?.innerText.toLowerCase().includes(s.slice(5).toLowerCase())) return k;
          } else if (document.querySelector(s)) return k;
        }
        return null;
      }, selectors)
      .catch(() => null);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Real mouse click on the first visible element matching a selector. */
async function clickSel(selector: string) {
  const p = await page();
  const pt = await p.evaluate((s) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(s)).find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  if (!pt) return false;
  await new Promise((r) => setTimeout(r, 150));
  await p.mouse.click(pt.x, pt.y, { delay: 30 });
  return true;
}

/** Click the first visible clickable element (in the main page) whose text contains `text`. */
async function clickText(text: string) {
  const p = await page();
  const pt = await p.evaluate((t) => {
    const want = t.toLowerCase();
    const els = Array.from(
      document.querySelectorAll<HTMLElement>("a, button, input[type=submit], .a-button-text, [role=button], [role=link], label"),
    );
    const el = els.find((e) => {
      const r = e.getBoundingClientRect();
      const label = (e.innerText || (e as HTMLInputElement).value || e.getAttribute("aria-label") || "").toLowerCase();
      return r.width > 0 && r.height > 0 && label.includes(want);
    });
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text);
  console.log(`[amazon] clickText "${text}" ->`, pt);
  if (!pt) return false;
  await new Promise((r) => setTimeout(r, 150));
  await p.mouse.click(pt.x, pt.y, { delay: 30 });
  return true;
}

// ── Amazon's secure payment iframe (apx-security.amazon.com) ────────────────
// The card form lives in a cross-origin iframe. Puppeteer can evaluate inside it
// through the bridge, but its inputs are React-controlled, so we focus them with
// real mouse clicks (iframe offset + element offset) and type real keystrokes.

async function apxFrame(timeout = 15_000, needSelector = "input") {
  const p = await page();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const f of p.frames()) {
      if (!f.url().includes("apx-security.amazon.com")) continue;
      const ok = await f.evaluate((s) => Boolean(document.querySelector(s)), needSelector).catch(() => false);
      if (ok) return f;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

type Frame = NonNullable<Awaited<ReturnType<typeof apxFrame>>>;

/** Absolute viewport point for an element inside the apx iframe. */
async function framePoint(frame: Frame, selector: string) {
  const p = await page();
  const inner = await frame.evaluate((s) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(s)).find((e) => e.getBoundingClientRect().width > 0);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  if (!inner) return null;
  const frameName = await frame.evaluate(() => window.name).catch(() => "");
  const offset = await p.evaluate((name) => {
    const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"));
    const el =
      iframes.find((f) => name && f.name === name) ??
      iframes.find((f) => f.name.startsWith("ApxSecureIframe") && f.getBoundingClientRect().width > 0);
    const r = el?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y } : { x: 0, y: 0 };
  }, frameName);
  return { x: offset.x + inner.x, y: offset.y + inner.y };
}

async function frameClick(frame: Frame, selector: string) {
  const pt = await framePoint(frame, selector);
  if (!pt) return false;
  await (await page()).mouse.click(pt.x, pt.y, { delay: 30 });
  return true;
}

/** Click a clickable inside the frame by its visible text. */
async function frameClickText(frame: Frame, text: string) {
  const marked = await frame.evaluate((t) => {
    const want = t.toLowerCase();
    const el = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button], a, input[type=submit], label, [role=radio]")).find(
      (e) => e.getBoundingClientRect().width > 0 && (e.innerText || (e as HTMLInputElement).value || "").toLowerCase().includes(want),
    );
    if (!el) return false;
    el.setAttribute("data-agent-target", "1");
    return true;
  }, text);
  if (!marked) return false;
  const ok = await frameClick(frame, '[data-agent-target="1"]');
  await frame.evaluate(() => document.querySelector('[data-agent-target="1"]')?.removeAttribute("data-agent-target")).catch(() => {});
  return ok;
}

async function frameType(frame: Frame, selector: string, value: string) {
  const p = await page();
  if (!(await frameClick(frame, selector))) return false;
  await p.keyboard.down("Meta");
  await p.keyboard.press("KeyA");
  await p.keyboard.up("Meta");
  await p.keyboard.press("Backspace");
  await p.keyboard.type(value, { delay: 30 });
  return true;
}

export type CardDetails = { pan: string; mm: string; yy: string; name: string; cvv?: string; zip?: string };

/**
 * Adds a card through Your Payments → Add a payment method → Add a credit or debit card.
 * Doing it in the wallet (before checkout) is the most predictable path; at checkout
 * the agent then just selects the card ending in last4.
 */
export async function addCard(card: CardDetails, opts: { submit?: boolean } = {}) {
  // Added as an ordinary saved card — never set as the default payment method.
  const p = await goto(`${AMZ}/cpe/yourpayments/wallet`);
  const steps: string[] = [];
  if (!(await waitForAny({ add: "text=Add a payment method" }, 12_000))) return { ok: false, error: "Wallet page didn't load." };
  if (!(await clickTextUntil("Add a payment method", { cc: "text=Add a credit or debit card" })))
    return { ok: false, steps, error: "Couldn't open 'Add a payment method'." };
  steps.push("opened add payment method");
  if (!(await clickTextUntil("Add a credit or debit card", { frame: "iframe[name^='ApxSecureIframe']" })))
    return { ok: false, steps, error: "Couldn't open the card form." };
  steps.push("opened card form");

  const frame = await apxFrame(15_000, 'input[autocomplete="cc-number"]');
  if (!frame) return { ok: false, steps, error: "Card form iframe didn't appear." };

  if (!(await frameType(frame, 'input[autocomplete="cc-number"]', card.pan))) return { ok: false, steps, error: "Card number field not found." };
  if (!(await frameType(frame, 'input[autocomplete="cc-exp"]', `${card.mm}${card.yy}`))) return { ok: false, steps, error: "Expiration field not found." };
  if (!(await frameType(frame, 'input[autocomplete="name"], input[placeholder="Name on card"]', card.name))) return { ok: false, steps, error: "Name field not found." };
  steps.push("filled number, expiration, name");

  // Verify the form took the values (only lengths/last4 — never return the number).
  const check = await frame.evaluate(() => {
    const v = (s: string) => (document.querySelector<HTMLInputElement>(s)?.value ?? "").replace(/\D/g, "");
    return { numberDigits: v('input[autocomplete="cc-number"]').length, last4: v('input[autocomplete="cc-number"]').slice(-4), exp: (document.querySelector<HTMLInputElement>('input[autocomplete="cc-exp"]')?.value ?? "") };
  });
  if (opts.submit === false) return { ok: true, steps, check, submitted: false };

  await frameClickText(frame, "Add and continue");
  steps.push("submitted card");

  // Follow-up steps vary: billing address choice, CVV confirmation, or straight to success.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const f = (await apxFrame(1_500)) ?? frame;
    const state = await f
      .evaluate(() => {
        const t = document.body?.innerText ?? "";
        return {
          text: t.slice(0, 600),
          address: /billing address|use this address|select an address/i.test(t),
          cvv: Boolean(document.querySelector('input[autocomplete="cc-csc"]')),
          error: (document.querySelector('[role="alert"], .a-alert-error')?.textContent ?? "").trim(),
        };
      })
      .catch(() => null);
    const added = await p
      .evaluate((last4) => new RegExp(`ending in\\s*(?:•+\\s*)?${last4}`).test(document.body.innerText), card.pan.slice(-4))
      .catch(() => false);
    if (added && !state?.address && !state?.cvv) return { ok: true, steps, last4: card.pan.slice(-4) };
    if (state?.error) return { ok: false, steps, error: `Amazon: ${state.error.slice(0, 200)}` };
    if (state?.cvv && card.cvv) {
      await frameType(f, 'input[autocomplete="cc-csc"]', card.cvv);
      steps.push("entered CVV");
      await frameClickText(f, "Continue");
      continue;
    }
    // Never make the 1Claw card the account default — it's only selected for this order.
    await f
      .evaluate(() => {
        for (const box of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
          const label = (box.closest("label")?.innerText ?? box.parentElement?.innerText ?? "").toLowerCase();
          if (box.checked && /default/.test(label)) box.click();
        }
      })
      .catch(() => {});
    if (state?.address) {
      // Prefer the saved address (first option), then confirm.
      (await frameClickText(f, "Use this address")) || (await frameClickText(f, "Continue")) || (await frameClickText(f, "Save"));
      steps.push("chose billing address");
      continue;
    }
  }
  return { ok: false, steps, error: "Timed out waiting for Amazon to confirm the card. Take a screenshot to see where it is." };
}

/**
 * On the checkout page, select the card ending in last4 as the payment method.
 * The payment selector may be in the main page or in an apx iframe.
 */
export async function selectCardAtCheckout(last4: string) {
  const p = await page();
  await guardHuman();
  // Open the payment chooser if it's collapsed.
  (await clickText("Change payment method")) || (await clickText("Change")) ;
  await new Promise((r) => setTimeout(r, 1500));

  const pattern = `ending in`;
  const inMain = await p.evaluate(
    (l4, pat) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>("label, [role=radio], .pmts-instrument-selector, li, div"))
        .filter((e) => e.children.length < 12 && e.getBoundingClientRect().width > 0)
        .find((e) => e.innerText?.includes(pat) && e.innerText.includes(l4));
      if (!el) return false;
      el.setAttribute("data-agent-target", "1");
      return true;
    },
    last4,
    pattern,
  );
  if (inMain) {
    await clickSel('[data-agent-target="1"]');
  } else {
    const f = await apxFrame(5_000);
    if (!f) return { ok: false, error: `Couldn't find the card ending in ${last4} on the checkout page.` };
    const found = await f.evaluate(
      (l4) => {
        const el = Array.from(document.querySelectorAll<HTMLElement>("label, [role=radio], [role=button], li, div"))
          .filter((e) => e.children.length < 12 && e.getBoundingClientRect().width > 0)
          .find((e) => e.innerText?.includes(l4));
        if (!el) return false;
        el.setAttribute("data-agent-target", "1");
        return true;
      },
      last4,
    );
    if (!found) return { ok: false, error: `Couldn't find the card ending in ${last4} in the payment selector.` };
    await frameClick(f, '[data-agent-target="1"]');
    await new Promise((r) => setTimeout(r, 800));
    await frameClickText(f, "Use this payment method");
  }
  await new Promise((r) => setTimeout(r, 800));
  (await clickText("Use this payment method")) || (await clickText("Continue"));
  await new Promise((r) => setTimeout(r, 2000));
  return { ok: true, ...(await checkoutSummary()) };
}

/** Click by text, retrying until `next` shows up (pages often ignore clicks until their JS is ready). */
async function clickTextUntil(text: string, next: Record<string, string>, attempts = 3, waitMs = 7_000) {
  for (let i = 0; i < attempts; i++) {
    await clickText(text);
    if (await waitForAny(next, waitMs)) return true;
  }
  return false;
}

async function signedIn() {
  const p = await page();
  return p.evaluate(() => {
    const t = document.querySelector("#nav-link-accountList-nav-line-1")?.textContent ?? "";
    return !/sign in/i.test(t) && t.trim().length > 0 ? t.trim() : null;
  });
}

export async function search(query: string) {
  const p = await goto(`${AMZ}/s?k=${encodeURIComponent(query)}`);
  await waitForAny({ results: '[data-component-type="s-search-result"]', captcha: "form[action*='validateCaptcha']" });
  const user = await signedIn().catch(() => null);
  const results = await p.evaluate(() => {
    const out: Array<Record<string, unknown>> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-component-type="s-search-result"]'))) {
      const asin = el.dataset.asin;
      if (!asin) continue;
      const text = el.innerText;
      if (/\bSponsored\b/.test(text.slice(0, 200))) continue;
      const clean = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();
      // The h2 is sometimes just the brand ("Pokémon"); the image alt has the full product name.
      const h2 = clean(el.querySelector('[data-cy="title-recipe"]')?.textContent || el.querySelector("h2")?.textContent);
      const alt = clean(el.querySelector<HTMLImageElement>("img.s-image")?.alt);
      const title = h2.length >= 25 ? h2 : alt.length > h2.length ? alt : h2;
      const price = el.querySelector(".a-price:not([data-a-strike]) .a-offscreen")?.textContent?.trim();
      if (!title || !price) continue;
      out.push({
        asin,
        title: title.slice(0, 120),
        price,
        rating: el.querySelector(".a-icon-alt")?.textContent?.split(" out")[0],
        reviews: el.querySelector('[aria-label$="ratings"], a[href*="customerReviews"] span')?.textContent?.trim(),
        prime: Boolean(el.querySelector(".a-icon-prime, [aria-label*='Prime']")),
      });
      if (out.length >= 8) break;
    }
    return out;
  });
  return { signed_in_as: user, results };
}

export async function addToCart(asin: string) {
  const p = await goto(`${AMZ}/dp/${asin}`);
  const found = await waitForAny({ add: "#add-to-cart-button", unavailable: "#outOfStock, #availability .a-color-price" });
  if (found !== "add") return { ok: false, error: "No Add to Cart button — item may be unavailable or sold through other sellers." };
  const info = await p.evaluate(() => ({
    title: document.querySelector("#productTitle")?.textContent?.trim().slice(0, 120),
    price:
      document.querySelector("#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .a-price .a-offscreen")
        ?.textContent?.trim(),
  }));
  await clickSel("#add-to-cart-button");
  const after = await waitForAny(
    {
      added: "text=Added to cart",
      sheet: "#attach-warranty-pane, #attachDisplayAddBaseAlert, #sw-atc-details-single-container",
      cart: "#sw-gtc, #nav-cart-count",
    },
    10_000,
  );
  // Decline protection-plan upsells if the side sheet shows them.
  await clickSel("#attachSiNoCoverage, #attach-warranty-pane input[aria-labelledby*='noCoverage']").catch(() => false);
  return { ok: Boolean(after), ...info };
}

export async function viewCart() {
  const p = await goto(`${AMZ}/gp/cart/view.html`);
  await waitForAny({ cart: "#sc-active-cart, .sc-list-item", empty: "text=Your Amazon Cart is empty" });
  return p.evaluate(() => ({
    items: Array.from(document.querySelectorAll<HTMLElement>("#sc-active-cart .sc-list-item[data-asin]")).map((el) => ({
      asin: el.dataset.asin,
      title: (el.querySelector(".a-truncate-full, .sc-product-title")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
      quantity: el.dataset.quantity,
      price: el.dataset.price,
    })),
    subtotal: document.querySelector("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox")?.textContent?.trim(),
  }));
}

export async function goToCheckout() {
  const cart = await viewCart();
  if (cart.items.length === 0) return { ok: false, error: "Cart is empty." };
  await clickSel(
    'input[name="proceedToRetailCheckout"], #sc-buy-box-ptc-button input, [data-feature-id="proceed-to-checkout-action"] input, [data-feature-id="proceed-to-checkout-label"]',
  );
  const p = await page();
  await new Promise((r) => setTimeout(r, 1000));
  await guardHuman();
  const where = await waitForAny(
    { checkout: "#checkout-main, #spc-orders, #subtotals, form#spc-form, text=Place your order", signin: "#ap_email, #ap_password" },
    20_000,
  );
  if (where === "signin") return { ok: false, error: "Amazon is asking to sign in again. Re-run npm run amazon-login." };
  // Skip Prime / interstitial upsells.
  await clickSel("#prime-interstitial-nothanks-button, a[href*='prime'][class*='no-thanks'], #prime-declineCTA").catch(() => false);
  return { ok: where === "checkout", cart_items: cart.items, ...(await checkoutSummary()), url: p.url() };
}

const totals = globalThis as { __checkoutTotal?: { usd: number; at: number } };

/** The order total last read from Amazon's checkout page — the only amount a card may be ordered for. */
export function lastCheckoutTotal() {
  const t = totals.__checkoutTotal;
  return t && Date.now() - t.at < 30 * 60_000 ? t.usd : null;
}

export async function checkoutSummary() {
  const p = await page();
  const summary = await p.evaluate(() => {
    const clean = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
    const body = document.body.innerText;
    const total =
      clean(document.querySelector("#subtotals-marketplace-table .grand-total-price, .order-summary-line-definition.grand-total, [data-testid='order-summary-grand-total']")?.textContent) ||
      body.match(/Order total:?\s*\$[\d,.]+/i)?.[0];
    return {
      shipping_address: clean(document.querySelector("#deliver-to-address-text, .displayAddressDiv, #shipaddress")?.textContent).slice(0, 160),
      payment: clean(document.querySelector("#payment-information, .pmts-instrument-display-name, #checkout-paymentInformationSection")?.textContent).slice(0, 160),
      order_total: total,
      delivery: body.match(/(Arriving|Delivery|Get it)[^\n]{0,60}/i)?.[0],
    };
  });
  const usd = Number(summary.order_total?.match(/\$\s*([\d,]+\.\d{2})/)?.[1]?.replace(/,/g, ""));
  if (usd > 0) totals.__checkoutTotal = { usd, at: Date.now() };
  return { ...summary, order_total_usd: usd > 0 ? usd : null };
}

export async function placeOrder() {
  const p = await page();
  const clicked = await clickSel('input[name="placeYourOrder1"], #submitOrderButtonId input, #placeOrder, #bottomSubmitOrderButtonId input');
  if (!clicked) return { ok: false, error: "Couldn't find the Place your order button." };
  const result = await waitForAny(
    { done: "text=Order placed, thanks", done2: "text=Thank you, your order has been placed", problem: ".a-alert-error, #spc-error-message" },
    30_000,
  );
  if (result === "problem") {
    const msg = await p.evaluate(() => document.querySelector(".a-alert-error, #spc-error-message")?.textContent?.replace(/\s+/g, " ").trim());
    return { ok: false, error: msg ?? "Checkout reported a problem." };
  }
  return orderConfirmation();
}

export async function orderConfirmation() {
  const p = await page();
  return p.evaluate(() => {
    const body = document.body.innerText;
    return {
      ok: /order placed|order has been placed/i.test(body),
      delivery: body.match(/(Arriving|Delivery|Guaranteed delivery|Estimated delivery)[^\n]{0,80}/i)?.[0],
      order_number: body.match(/Order #?\s*([\d-]{10,})/i)?.[1],
      text: body.slice(0, 1200),
    };
  });
}
