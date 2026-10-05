// One-time setup: opens a browser through 1Claw browser-bridge, lets you sign in to
// Amazon by hand, then saves the session cookies so the agent starts signed in.
//   npm run amazon-login
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { MockVaultDriver, startBridge } from "@1claw/browser-bridge";
import puppeteer from "puppeteer-core";

const chrome =
  process.env.ONECLAW_BRIDGE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const out = process.env.AMAZON_SESSION_FILE ?? ".amazon-session.json";

const bridge = await startBridge({
  executablePath: chrome,
  backend: new MockVaultDriver({ bindings: [] }),
  host: "127.0.0.1",
  args: ["--window-size=1280,980", "--disable-blink-features=AutomationControlled"],
});
const browser = await puppeteer.connect({ browserWSEndpoint: bridge.url, defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://www.amazon.com/gp/sign-in.html", { waitUntil: "domcontentloaded" }).catch(() => {});

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question(
  "\nSign in to Amazon in the browser window (complete any 2FA), make sure a shipping address is saved,\nthen press Enter here to save the session… ",
);
rl.close();

const cdp = await page.createCDPSession();
const { cookies } = await cdp.send("Network.getCookies", {
  urls: ["https://www.amazon.com", "https://amazon.com", "https://www.amazon.com/gp/buy"],
});
writeFileSync(out, JSON.stringify(cookies, null, 2), { mode: 0o600 });
console.log(`Saved ${cookies.length} cookies to ${out}`);
await browser.disconnect().catch(() => {});
await bridge.close();
process.exit(0);
