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

const goto = (url: string) => fastGoto(url);

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
      title: (el.querySelector(".sc-product-title, .a-truncate-full")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
      quantity: el.dataset.quantity,
      price: el.dataset.price,
    })),
    subtotal: document.querySelector("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox")?.textContent?.trim(),
  }));
}

export async function goToCheckout() {
  const cart = await viewCart();
  if (cart.items.length === 0) return { ok: false, error: "Cart is empty." };
  await clickSel('input[name="proceedToRetailCheckout"], #sc-buy-box-ptc-button input, [data-feature-id="proceed-to-checkout-action"] input');
  const p = await page();
  const where = await waitForAny(
    { checkout: "#checkout-main, #spc-orders, #subtotals, form#spc-form, text=Place your order", signin: "#ap_email, #ap_password" },
    20_000,
  );
  if (where === "signin") return { ok: false, error: "Amazon is asking to sign in again. Re-run npm run amazon-login." };
  // Skip Prime / interstitial upsells.
  await clickSel("#prime-interstitial-nothanks-button, a[href*='prime'][class*='no-thanks'], #prime-declineCTA").catch(() => false);
  return { ok: where === "checkout", cart_items: cart.items, ...(await checkoutSummary()), url: p.url() };
}

export async function checkoutSummary() {
  const p = await page();
  return p.evaluate(() => {
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
