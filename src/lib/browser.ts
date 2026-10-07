import "server-only";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { MockVaultDriver, startBridge, type BridgeHandle } from "@1claw/browser-bridge";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";

/**
 * Browser automation through 1Claw's browser-bridge: Chromium is launched by the
 * bridge and every CDP command we send passes its allowlist gate. Puppeteer's
 * element-handle APIs (page.click / page.type) need DOM.resolveNode, which the
 * gate refuses, so everything here is built from Runtime.evaluate + Input events.
 */

type Session = { bridge: BridgeHandle; browser: Browser; page: Page; cdp: CDPSession };
const g = globalThis as { __bridge?: Promise<Session> };

const VIEWPORT = { width: 1280, height: 860 };
export const SESSION_FILE = process.env.AMAZON_SESSION_FILE ?? ".amazon-session.json";

export function chromePath() {
  return (
    process.env.ONECLAW_BRIDGE_CHROME ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  );
}

export async function launchBridgeSession(opts: { headless?: boolean } = {}): Promise<Session> {
  const headless = opts.headless ?? process.env.BROWSER_HEADLESS === "true";
  const bridge = await startBridge({
    executablePath: chromePath(),
    // No vault-backed login fills are needed for this flow — the Amazon session
    // comes from saved cookies and the card is typed by our own server tool.
    backend: new MockVaultDriver({ bindings: [] }),
    host: "127.0.0.1",
    args: [
      ...(headless ? ["--headless=new"] : []),
      `--window-size=${VIEWPORT.width},${VIEWPORT.height + 120}`,
      "--disable-blink-features=AutomationControlled",
      // Keep the agent's tab fully live when the window is behind others or
      // minimised (macOS marks occluded windows hidden and stops routing input).
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  });
  const browser = await puppeteer.connect({ browserWSEndpoint: bridge.url, defaultViewport: null });
  const { page, cdp } = await openTab(browser);
  return { bridge, browser, page, cdp };
}

async function openTab(browser: Browser) {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp
    .send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
    .catch(() => {});
  return { page, cdp };
}

/**
 * Returns a live session, healing it if needed: if the agent's tab was closed
 * (window closed by hand, or a checkout flow replaced it) a fresh tab is opened in
 * the same browser context (so the Amazon cookies carry over); if Chromium itself
 * is gone, the bridge is relaunched.
 */
export async function getBrowser(): Promise<Session> {
  return getBrowserInner(0);
}

async function relaunch(s: Session | undefined, why: string) {
  console.warn(`[browser] ${why} — relaunching the browser`);
  g.__bridge = undefined;
  await s?.browser.disconnect().catch(() => {});
  await s?.bridge.close().catch(() => {});
}

async function getBrowserInner(attempt: number): Promise<Session> {
  let s = await (g.__bridge ??= (async () => {
    const fresh = await launchBridgeSession();
    await restoreCookies(fresh.cdp);
    // If Chromium or the bridge socket goes away (sleep, crash, network drop),
    // forget this session so the next call starts a fresh one.
    fresh.browser.once("disconnected", () => {
      if (g.__bridge) console.warn("[browser] disconnected from Chromium");
      g.__bridge = undefined;
    });
    return fresh;
  })().catch((err) => {
    g.__bridge = undefined;
    throw err;
  }));

  try {
    if (!s.browser.connected) throw new Error("Chromium disconnected");
    if (s.page.isClosed()) {
      console.warn("[browser] agent tab was closed — opening a new one");
      s = Object.assign(s, await openTab(s.browser));
    }
    // Liveness probe at the CDP level (independent of page navigation — page.evaluate
    // would throw "Execution context was destroyed" mid-navigation on a healthy browser).
    await Promise.race([
      s.cdp.send("Page.getFrameTree"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("browser not responding")), 8_000)),
    ]).catch((err: Error) => {
      // Navigation/context churn means the browser is alive and busy, not dead.
      if (/context was destroyed|navigat|detached frame|Cannot find context/i.test(err.message)) return;
      throw err;
    });
    return s;
  } catch (err) {
    if (attempt >= 1) throw err;
    await relaunch(s, `browser unreachable (${err instanceof Error ? err.message : String(err)})`);
    return getBrowserInner(attempt + 1);
  }
}

const AMAZON_COOKIE_URLS = ["https://www.amazon.com", "https://amazon.com", "https://www.amazon.com/gp/buy", "https://www.amazon.com/ap/"];
let lastCookieSave = 0;

/**
 * Writes the browser's current Amazon cookies back to the session file, so a
 * human-check clearance (and refreshed login cookies) survive browser restarts —
 * the same way a normal browser remembers you. Throttled unless forced.
 */
export async function saveCookies(opts: { force?: boolean } = {}) {
  if (!g.__bridge) return 0; // no browser running
  if (!opts.force && Date.now() - lastCookieSave < 30_000) return 0;
  const { cdp } = await getBrowser();
  const { cookies } = (await cdp.send("Network.getCookies", { urls: AMAZON_COOKIE_URLS })) as { cookies: unknown[] };
  if (!cookies?.length) return 0;
  const tmp = `${SESSION_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(cookies, null, 2), { mode: 0o600 });
  renameSync(tmp, SESSION_FILE);
  lastCookieSave = Date.now();
  return cookies.length;
}

async function restoreCookies(cdp: CDPSession) {
  if (!existsSync(SESSION_FILE)) return 0;
  const cookies = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Array<Record<string, unknown>>;
  let n = 0;
  for (const c of cookies) {
    const { name, value, domain, path, secure, httpOnly, sameSite, expires } = c;
    await cdp
      .send("Network.setCookie", {
        name,
        value,
        domain,
        path,
        secure,
        httpOnly,
        ...(sameSite ? { sameSite } : {}),
        ...(typeof expires === "number" && expires > 0 ? { expires } : {}),
      } as never)
      .then(() => n++)
      .catch(() => {});
  }
  return n;
}

async function settle(page: Page, ms = 400) {
  // Poll rather than waitForFunction: it relies on events the bridge doesn't forward.
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (done) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Navigate without waiting on Puppeteer's lifecycle events, which don't arrive
 * through the bridge proxy (page.goto would always sit out its full timeout).
 * Sends Page.navigate directly, then polls until the old document is gone and
 * the new one has parsed.
 */
export async function fastGoto(url: string, timeoutMs = 20_000) {
  const { page, cdp } = await getBrowser();
  await page.evaluate(() => ((window as unknown as { __agentOld?: boolean }).__agentOld = true)).catch(() => {});
  await cdp.send("Page.navigate", { url });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(
        () => !(window as unknown as { __agentOld?: boolean }).__agentOld && document.readyState !== "loading",
      )
      .catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return page;
}

export async function navigate(url: string) {
  const page = await fastGoto(url);
  await settle(page);
  return snapshot();
}

/**
 * Labels visible interactive elements with [index] and returns them with the page text,
 * so the model can act by index. Cross-origin iframes (e.g. card forms) aren't
 * reachable this way; the screenshot + x/y clicks cover those.
 */
export async function snapshot() {
  const { page } = await getBrowser();
  const data = await page.evaluate(() => {
    const sel =
      'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=radio], [role=checkbox], [role=option], [contenteditable=true], iframe';
    const out: string[] = [];
    let i = 0;
    document.querySelectorAll("[data-agent-idx]").forEach((el) => el.removeAttribute("data-agent-idx"));
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < 0 || r.top > window.innerHeight * 1.5) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
      el.setAttribute("data-agent-idx", String(i));
      const tag = el.tagName.toLowerCase();
      const input = el as HTMLInputElement;
      const label =
        el.getAttribute("aria-label") ||
        (tag === "input" || tag === "textarea" ? input.placeholder || input.name || input.id : "") ||
        el.getAttribute("title") ||
        (el.innerText || input.value || "").replace(/\s+/g, " ").trim();
      const type = tag === "input" ? `input[${input.type}]` : tag;
      const extra =
        tag === "iframe"
          ? ` src=${(el as HTMLIFrameElement).src.slice(0, 80)} at(${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)})`
          : "";
      out.push(`[${i}] ${type} "${label.slice(0, 90)}"${extra}${r.top > window.innerHeight ? " (below fold)" : ""}`);
      if (++i >= 90) break;
    }
    const text = document.body.innerText.replace(/\n{3,}/g, "\n\n").slice(0, 3500);
    return { url: location.href, title: document.title, elements: out.join("\n"), text };
  });
  return data;
}

export async function screenshot(): Promise<string> {
  const { cdp } = await getBrowser();
  const { data } = (await cdp.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 55,
    clip: { x: 0, y: 0, ...VIEWPORT, scale: 1 },
  })) as { data: string };
  return data;
}

async function centerOf(index: number) {
  const { page } = await getBrowser();
  return page.evaluate((idx) => {
    const el = document.querySelector<HTMLElement>(`[data-agent-idx="${idx}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, index);
}

/**
 * Purchase buttons may only be pressed by amazon_place_order, which first checks
 * the payment card and total. Generic clicks/keys that would buy are refused.
 */
const PURCHASE_LABEL = /place (your )?order|buy now|submit order|complete purchase|pay now|confirm purchase/i;

async function wouldPurchase(page: Page, pt: { x: number; y: number }) {
  return page
    .evaluate(
      (x, y, re) => {
        let el = document.elementFromPoint(x, y) as HTMLElement | null;
        for (let i = 0; el && i < 6; i++, el = el.parentElement) {
          const label = `${el.innerText ?? ""} ${(el as HTMLInputElement).value ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("name") ?? ""} ${el.id}`;
          if (label.length < 200 && new RegExp(re, "i").test(label)) return true;
          if (/placeYourOrder|submitOrderButton|buy-now-button|turbo-checkout/i.test(`${el.id} ${el.getAttribute("name") ?? ""}`)) return true;
        }
        return false;
      },
      pt.x,
      pt.y,
      PURCHASE_LABEL.source,
    )
    .catch(() => false);
}

async function onCheckoutReview(page: Page) {
  return /\/checkout\/|\/gp\/buy\//.test(page.url()) && !page.url().includes("/thankyou");
}

export async function click(target: { index?: number; x?: number; y?: number }) {
  const { page } = await getBrowser();
  let pt: { x: number; y: number } | null = null;
  if (typeof target.index === "number") {
    pt = await centerOf(target.index);
    if (!pt) return { ok: false, error: `No element [${target.index}] — take a new snapshot.` };
    await new Promise((r) => setTimeout(r, 120));
  } else if (typeof target.x === "number" && typeof target.y === "number") {
    pt = { x: target.x, y: target.y };
  } else {
    return { ok: false, error: "Provide index or x/y." };
  }
  if (await wouldPurchase(page, pt)) {
    return { ok: false, error: "Refused: that button places an order. Only amazon_place_order may do that (it verifies the card first)." };
  }
  await page.mouse.click(pt.x, pt.y, { delay: 40 });
  await settle(page, 600);
  return { ok: true, url: page.url() };
}

export async function typeText(text: string, opts: { index?: number; x?: number; y?: number; clear?: boolean; submit?: boolean }) {
  const { page } = await getBrowser();
  if (opts.index !== undefined || opts.x !== undefined) {
    const r = await click(opts);
    if (!r.ok) return r;
  }
  if (opts.clear !== false) {
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Meta");
    await page.keyboard.press("Backspace");
  }
  await page.keyboard.type(text, { delay: 25 });
  if (opts.submit && (await onCheckoutReview(page))) {
    return { ok: false, error: "Refused: submitting on checkout could place the order. Use amazon_place_order." };
  }
  if (opts.submit) {
    await page.keyboard.press("Enter");
    await settle(page, 600);
  }
  return { ok: true, url: page.url() };
}

export async function selectOption(index: number, option: string) {
  const { page } = await getBrowser();
  return page.evaluate(
    (idx, opt) => {
      const el = document.querySelector<HTMLSelectElement>(`[data-agent-idx="${idx}"]`);
      if (!el || el.tagName !== "SELECT") return { ok: false, error: "Not a <select>" };
      const match = Array.from(el.options).find(
        (o) => o.value === opt || o.text.trim().toLowerCase() === opt.toLowerCase(),
      );
      if (!match) return { ok: false, error: `Options: ${Array.from(el.options).map((o) => o.text.trim()).join(", ")}` };
      el.value = match.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    },
    index,
    option,
  );
}

export async function pressKey(key: string) {
  const { page } = await getBrowser();
  if (/^(Enter|NumpadEnter| )$/.test(key) && (await onCheckoutReview(page))) {
    return { ok: false, error: "Refused: pressing Enter on checkout could place the order. Use amazon_place_order." };
  }
  await page.keyboard.press(key as never);
  await settle(page, 300);
  return { ok: true };
}

export async function scroll(dy: number) {
  const { page } = await getBrowser();
  await page.mouse.wheel({ deltaY: dy });
  await new Promise((r) => setTimeout(r, 600));
  return { ok: true };
}

/**
 * Types secret values into fields located by the model (index or x/y), without
 * the values ever passing through the model. Used for card entry.
 */
export async function typeSecrets(
  steps: Array<{ value: string; index?: number; x?: number; y?: number; isSelect?: boolean }>,
) {
  const { page } = await getBrowser();
  for (const s of steps) {
    if (s.isSelect && s.index !== undefined) {
      await selectOption(s.index, s.value);
      continue;
    }
    const r = await click(s);
    if (!r.ok) return r;
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Meta");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(s.value, { delay: 35 });
  }
  return { ok: true };
}
