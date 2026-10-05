import "server-only";
import { fastGoto, getBrowser, saveCookies } from "./browser";

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
    if (!(await humanCheckShowing())) {
      // Remember the clearance so the next browser launch doesn't ask again.
      const saved = await saveCookies({ force: true }).catch(() => 0);
      console.log(`[amazon] human check cleared — saved ${saved} cookies`);
      return { ok: true, url: (await page()).url() };
    }
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
          if (s.startsWith("url=")) {
            if (location.href.includes(s.slice(4))) return k;
          } else if (s.startsWith("text=")) {
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
  // Billing address = the shipping address. Amazon's header shows where orders ship ("Deliver to … City 12345");
  // we match that ZIP when Amazon asks which saved address to bill.
  const shipZip =
    process.env.CARD_BILLING_ZIP ||
    (await p
      .evaluate(() => (document.querySelector("#glow-ingress-line2")?.textContent ?? "").match(/\b\d{5}\b/)?.[0] ?? "")
      .catch(() => ""));
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
      // Use the shipping address as the billing address: pick the saved address with the shipping ZIP.
      let picked = false;
      if (shipZip) {
        picked = await f
          .evaluate((zip) => {
            const opts = Array.from(document.querySelectorAll<HTMLElement>("[role=radio], label, li, [role=button], div"))
              .filter((e) => e.children.length < 15 && e.getBoundingClientRect().width > 0 && (e.innerText ?? "").includes(zip))
              .sort((a, b) => (a.innerText?.length ?? 0) - (b.innerText?.length ?? 0));
            const el = opts[0];
            if (!el) return false;
            el.setAttribute("data-agent-target", "1");
            return true;
          }, shipZip)
          .catch(() => false);
        if (picked) {
          await frameClick(f, '[data-agent-target="1"]');
          await f.evaluate(() => document.querySelector('[data-agent-target="1"]')?.removeAttribute("data-agent-target")).catch(() => {});
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (!picked && !(await f.evaluate(() => /default|shipping/i.test(document.body.innerText)).catch(() => false))) {
        return { ok: false, steps, error: `Amazon wants a billing address but none matching the shipping ZIP ${shipZip || "(unknown)"} was offered.` };
      }
      (await frameClickText(f, "Use this address")) || (await frameClickText(f, "Continue")) || (await frameClickText(f, "Save"));
      steps.push(picked ? `billing address = shipping address (${shipZip})` : "billing address = default address");
      continue;
    }
  }
  return { ok: false, steps, error: "Timed out waiting for Amazon to confirm the card. Take a screenshot to see where it is." };
}

/**
 * On Amazon's checkout, select the card ending in last4 and confirm it.
 * The payment step (/checkout/p/…/pay) lists saved cards as radio rows
 * (name="ppw-instrumentRowSelection") with a "Use this payment method" button.
 */
export async function selectCardAtCheckout(last4: string) {
  const p = await page();
  await guardHuman();

  // From the review page, open the payment step via its own "Change" link (not the address one).
  if (!p.url().includes("/pay")) {
    const opened = await p.evaluate(() => {
      const link = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role=button]")).find((e) => {
        const label = `${e.getAttribute("aria-label") ?? ""} ${e.innerText ?? ""}`.toLowerCase();
        return e.getBoundingClientRect().width > 0 && label.includes("change") && label.includes("payment");
      });
      link?.setAttribute("data-agent-target", "1");
      return Boolean(link);
    });
    if (opened) {
      await clickSel('[data-agent-target="1"]');
      await waitForAny({ pay: "url=/pay", radios: 'input[name="ppw-instrumentRowSelection"]' }, 10_000);
    }
  }
  if (!(await waitForAny({ radios: 'input[name="ppw-instrumentRowSelection"]' }, 8_000))) {
    return { ok: false, error: "Couldn't find Amazon's card list on the payment step." };
  }

  // Mark the radio for the card ending in last4.
  const found = await p.evaluate((l4) => {
    for (const r of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ppw-instrumentRowSelection"]'))) {
      let row: HTMLElement | null = r.parentElement;
      // Walk up to the row that names the card ("… ending in 1234").
      while (row && !/ending in/i.test(row.innerText ?? "") && row !== document.body) row = row.parentElement;
      if (row && new RegExp(`ending in\\s*${l4}\\b`).test(row.innerText)) {
        r.setAttribute("data-agent-target", "1");
        return { checked: r.checked };
      }
    }
    return null;
  }, last4);
  if (!found) return { ok: false, error: `The card ending in ${last4} isn't in Amazon's saved cards. Add it first with amazon_add_1claw_card.` };
  if (!found.checked) {
    await clickSel('[data-agent-target="1"]');
    await new Promise((r) => setTimeout(r, 500));
  }
  await p.evaluate(() => document.querySelectorAll("[data-agent-target]").forEach((e) => e.removeAttribute("data-agent-target")));

  // Confirm, then wait to leave the payment step.
  if (!(await clickText("Use this payment method"))) return { ok: false, error: "No 'Use this payment method' button." };
  // Amazon shows "Setting your payment method…" before moving to the review (/spc) page.
  const left = await waitForAny({ spc: "url=/spc" }, 15_000);
  await waitForAny({ paying: "text=Paying with" }, 5_000);
  await guardHuman();
  const summary = await checkoutSummary();
  const selected = await p.evaluate(
    (l4) => new RegExp(`(ending in|Paying with[^\\n]{0,40}?)\\s*${l4}\\b`, "i").test(document.body.innerText),
    last4,
  );
  return {
    ok: Boolean(left) && selected,
    selected_last4: selected ? last4 : null,
    ...summary,
    ...(selected ? {} : { error: `Amazon isn't showing the card ending in ${last4} as the payment method.` }),
  };
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
  await waitForAny({ cart: "#sc-active-cart .sc-list-item, #sc-subtotal-amount-buybox", empty: "text=Your Amazon Cart is empty" }, 8_000);
  return p.evaluate(() => ({
    items: Array.from(document.querySelectorAll<HTMLElement>("#sc-active-cart .sc-list-item[data-asin]")).map((el) => ({
      asin: el.dataset.asin,
      title: (el.querySelector(".a-truncate-full")?.textContent || el.querySelector(".sc-product-title")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
      quantity: el.dataset.quantity,
      price: el.dataset.price,
    })),
    subtotal: document.querySelector("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox")?.textContent?.trim(),
  }));
}

export async function goToCheckout() {
  const cart = await viewCart();
  if (cart.items.length === 0) return { ok: false, error: "Cart is empty." };
  const p = await page();
  // Submit the cart's checkout form directly — clicking its label div doesn't navigate.
  const submitted = await p.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>("#gutterCartViewForm, form[action*='/checkout/entry/cart']");
    if (!form) return false;
    form.requestSubmit();
    return true;
  });
  if (!submitted) await clickSel('input[name="proceedToRetailCheckout"], [data-feature-id="proceed-to-checkout-label"]');
  const where = await waitForAny(
    {
      checkout: "url=/checkout/p/",
      checkout2: "url=/gp/buy/",
      signin: "#ap_email, #ap_password",
      human: "form[action*='validateCaptcha']",
    },
    15_000,
  );
  if (where === "signin") return { ok: false, error: "Amazon is asking to sign in again. Re-run npm run amazon-login." };
  await guardHuman();
  // Let the checkout page render its summary (order total) before reading it.
  await waitForAny({ total: "text=Order total", place: 'input[name="placeYourOrder1"], #submitOrderButtonId, #placeOrder' }, 8_000);
  // Skip Prime / interstitial upsells.
  await clickSel("#prime-interstitial-nothanks-button, #prime-declineCTA").catch(() => false);
  const summary = await checkoutSummary();
  // Checkout can pull in items the cart page doesn't show (e.g. a separate Amazon Haul cart).
  // Only ever pay for exactly what we put in the cart.
  const expected = cart.items.reduce((n, i) => n + (Number(i.quantity) || 1), 0);
  const extra = await p.evaluate(() => {
    const body = document.body.innerText;
    return {
      count: Number(body.match(/Items\s*\((\d+)\)/i)?.[1] ?? 0),
      needsUpdates: /make updates to your items|problem with some of the items/i.test(body),
    };
  });
  if ((extra.count && extra.count !== expected) || extra.needsUpdates) {
    totals.__checkoutTotal = undefined; // never order a card for a total that includes other items
    return {
      ok: false,
      error:
        `Checkout contains ${extra.count || "extra"} items but the cart only has ${expected} — other items (likely from the Amazon Haul cart) were pulled in` +
        (extra.needsUpdates ? ", and Amazon wants changes to some items" : "") +
        ". Stop and ask the user to empty their other carts before buying.",
      cart_items: cart.items,
    };
  }
  return { ok: Boolean(where?.startsWith("checkout")), cart_items: cart.items, ...summary, url: p.url() };
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
      payment:
        clean(document.querySelector("#payment-information, .pmts-instrument-display-name, #checkout-paymentInformationSection")?.textContent).slice(0, 160) ||
        (body.match(/Paying with[^\n]{0,40}?\d{4}/i)?.[0] ??
          body.match(/(Paying with|Payment method)[\s\S]{0,160}?ending in\s*\d{4}/i)?.[0] ??
          "").replace(/\s+/g, " ").slice(-60),
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
  // Never make this order's card/address the account default.
  await p
    .evaluate(() => {
      for (const box of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
        const label = (box.closest("label")?.innerText ?? box.parentElement?.innerText ?? "").toLowerCase();
        if (box.checked && /default to this|default payment/.test(label)) box.click();
      }
    })
    .catch(() => {});
  const clicked =
    (await clickSel('input[name="placeYourOrder1"], #submitOrderButtonId input, #placeOrder, #bottomSubmitOrderButtonId input')) ||
    (await clickText("Place your order"));
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
