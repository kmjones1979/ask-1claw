import "server-only";
import * as laso from "./laso";
import * as oneclaw from "./oneclaw";

/**
 * Card provider for checkout. Default "laso": the agent pays Laso's x402 paywall
 * directly (signed by its 1Claw key). "oneclaw": order through 1Claw's Payment
 * Card Vault (POST /v1/agents/{id}/cards/order).
 */
const provider = () => (process.env.CARD_PROVIDER ?? "laso") as "laso" | "oneclaw";

export type FullCard = { pan: string; exp_month: number; exp_year: number; cvv?: string };

export async function order(amountUsd: number) {
  if (provider() === "oneclaw") return { ...(await oneclaw.orderCard(amountUsd.toFixed(2))), amount_usd: amountUsd.toFixed(2) };
  return laso.orderCard(amountUsd);
}

export async function waitUntilReady(cardId: string) {
  return provider() === "oneclaw" ? oneclaw.waitForCard(cardId) : laso.waitForCard(cardId);
}

export async function reveal(cardId: string): Promise<FullCard> {
  if (provider() === "oneclaw") {
    const c = await oneclaw.revealCard(cardId);
    return { pan: c.pan ?? "", exp_month: Number(c.exp_month), exp_year: Number(c.exp_year), cvv: c.cvv };
  }
  const c = await laso.revealCard(cardId);
  const year = Number(c.exp_year);
  return {
    pan: String(c.card_number).replace(/\D/g, ""),
    exp_month: Number(c.exp_month),
    exp_year: year < 100 ? 2000 + year : year,
    cvv: c.cvv ? String(c.cvv) : undefined,
  };
}
