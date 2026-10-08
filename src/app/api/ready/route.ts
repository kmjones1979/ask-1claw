// Pre-flight check for the demo: is everything Max needs in place right now?
import { execFileSync } from "node:child_process";
import * as amazon from "@/lib/amazon";
import * as bowmark from "@/lib/bowmark";
import { fastGoto, getBrowser } from "@/lib/browser";
import * as laso from "@/lib/laso";
import * as oneclaw from "@/lib/oneclaw";

type Check = { name: string; ok: boolean; detail: string };

function vaultHasAmazon() {
  const path = process.env.ONECLAW_BRIDGE_VAULT;
  if (!path || !process.env.ONECLAW_BRIDGE_VAULT_PASSPHRASE) return false;
  try {
    const out = execFileSync(process.execPath, ["node_modules/@1claw/browser-bridge/bin/1claw-vault.mjs", "list", path], {
      env: { ...process.env, ONECLAW_SUPPRESS_DEPRECATION: "1" },
      encoding: "utf8",
      timeout: 15_000,
    });
    return /\bamazon\b/.test(out);
  } catch {
    return false;
  }
}

export async function GET() {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  try {
    const { page, vault } = await getBrowser();
    await fastGoto("https://www.amazon.com");
    await new Promise((r) => setTimeout(r, 1200));
    const h = await page.evaluate(() => ({
      account: document.querySelector("#nav-link-accountList-nav-line-1")?.textContent?.trim() ?? "",
      human: /check the box to continue|i am human/i.test(document.body.innerText),
    }));
    add("Browser (browser-bridge)", true, "running");
    add("Amazon sign-in", /hello/i.test(h.account) && !/sign in/i.test(h.account), h.account || "not signed in");
    add("No human check", !h.human, h.human ? "tick the box in Max's browser" : "clear");
    const cart = await amazon.viewCart().catch(() => ({ items: [{}] as unknown[] }));
    await fastGoto("https://www.amazon.com");
    add("Cart empty", cart.items.length === 0, cart.items.length ? `${cart.items.length} item(s) in cart` : "empty");
    const hasEntry = vault && vaultHasAmazon();
    add("Password vault", hasEntry, hasEntry ? "Amazon re-login filled by browser-bridge" : "no Amazon entry — re-login will need you");
  } catch (err) {
    add("Browser (browser-bridge)", false, err instanceof Error ? err.message : String(err));
  }

  const wallet = await oneclaw.getUsdcBalance().catch(() => null);
  const usdc = Number((wallet as { usdc?: string } | null)?.usdc ?? NaN);
  const limit = laso.spendStatus();
  add("USDC on Base", usdc >= 12, Number.isFinite(usdc) ? `$${usdc.toFixed(2)}` : "unavailable");
  add("Daily limit", limit.remaining_usd >= 12, `$${limit.remaining_usd.toFixed(2)} of $${limit.limit_usd} left`);
  add("Bowmark search", bowmark.enabled(), bowmark.enabled() ? "enabled" : "BOWMARK_API_KEY not set (browser search used)");

  const ok = checks.every((c) => c.ok || c.name === "Bowmark search");
  return Response.json({ ok, checks, at: new Date().toISOString() });
}
