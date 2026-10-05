import "server-only";
import { createClient, type CardRevealResponse, type CardResponse } from "@1claw/sdk";

const BASE_URL = process.env.ONECLAW_API_URL ?? "https://api.1claw.co";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function agentId() {
  const id = process.env.ONECLAW_AGENT_ID;
  if (!id) throw new Error("ONECLAW_AGENT_ID is not set");
  return id;
}

/** Client authenticated as the agent (ocv_ key) — this is who spends the USDC. */
let agentClient: ReturnType<typeof createClient> | undefined;
export function oneclaw() {
  const apiKey = process.env.ONECLAW_AGENT_API_KEY;
  if (!apiKey) throw new Error("ONECLAW_AGENT_API_KEY is not set");
  return (agentClient ??= createClient({ baseUrl: BASE_URL, agentId: agentId(), apiKey }));
}

function unwrap<T>(r: { data?: T | null; error?: unknown }, what: string): T {
  if (r.error || !r.data) {
    const e = r.error as { detail?: string; message?: string; title?: string } | undefined;
    throw new Error(`${what} failed: ${e?.detail ?? e?.message ?? e?.title ?? JSON.stringify(r.error)}`);
  }
  return r.data;
}

export async function getUsdcBalance() {
  const client = oneclaw();
  // The signing-key balance endpoint takes a chain name; try "base" first, then the EVM family name.
  for (const chain of ["base", "ethereum"]) {
    const r = await client.signingKeys.getBalance(agentId(), chain, [USDC_BASE]);
    if (r.error || !r.data) continue;
    const t = r.data.tokens?.find((x) => x.contract_address.toLowerCase() === USDC_BASE.toLowerCase());
    if (!t) continue;
    const usdc = Number(t.balance) / 10 ** (t.decimals ?? 6);
    return { chain: "base", address: r.data.address, usdc: usdc.toFixed(2) };
  }
  // Fallback: portfolio view across all wallets the agent can see.
  const p = unwrap(await client.portfolio.get({ chains: "base", include_tokens: true }), "portfolio");
  return { chain: "base", portfolio: p };
}

export function maskCard(c: CardResponse) {
  return {
    card_id: c.id,
    status: c.status,
    brand: c.brand,
    last4: c.last4,
    balance: c.balance ?? c.order_amount_usd,
    approval_id: c.approval_id,
  };
}

export async function orderCard(amountUsd: string) {
  const r = await oneclaw().cards.order(agentId(), { kind: "prepaid", amount_usd: amountUsd, country: "US" });
  return maskCard(unwrap(r, "card order"));
}

/**
 * Polls until the card is ready (or terminal). Covers the human-approval step:
 * an order with card_require_approval sits in `awaiting_approval` until someone
 * approves it in the 1Claw app.
 */
export async function waitForCard(cardId: string, timeoutMs = 240_000) {
  const client = oneclaw();
  const deadline = Date.now() + timeoutMs;
  let card = unwrap(await client.cards.get(cardId), "card status");
  while (["awaiting_approval", "ordering", "pending"].includes(card.status) || !card.last4) {
    if (["rejected", "voided", "expired", "orphaned_payment", "depleted"].includes(card.status)) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 4000));
    if (card.status === "pending") await client.cards.refresh(cardId).catch(() => {});
    card = unwrap(await client.cards.get(cardId), "card status");
  }
  return maskCard(card);
}

/** Full card details. Server-side only — never return this to the model or the browser client. */
export async function revealCard(cardId: string): Promise<CardRevealResponse> {
  return unwrap(await oneclaw().cards.reveal(cardId), "card reveal");
}

/** Billing details to pair with the card (Laso prepaid cards don't carry an address). */
export function billingProfile() {
  return {
    name: process.env.CARD_HOLDER_NAME ?? "",
    zip: process.env.CARD_BILLING_ZIP ?? "",
  };
}
