import "server-only";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { agentId, oneclaw } from "./oneclaw";

/**
 * Direct Laso Finance integration: we pay Laso's x402 paywall ourselves, but the
 * EIP-3009 USDC authorization is signed by the agent's 1Claw-held signing key
 * (the private key never leaves 1Claw). Laso then issues a prepaid card that we
 * read back with the Bearer token from the paid response.
 */

const LASO = "https://laso.finance";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** Laso's Base payTo, confirmed from its own 402 challenge. Payments anywhere else are refused. */
const LASO_PAYTO = "0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37";
const SESSION_FILE = ".laso-session.json";

type LasoSession = { id_token: string; refresh_token?: string; user_id?: string; cards: Record<string, { amount: number; at: number }> };
const g = globalThis as { __laso?: LasoSession };

function session(): LasoSession | undefined {
  if (!g.__laso && existsSync(SESSION_FILE)) g.__laso = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  return g.__laso;
}
function saveSession(s: LasoSession) {
  g.__laso = s;
  writeFileSync(SESSION_FILE, JSON.stringify(s), { mode: 0o600 });
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

let signerAddress: `0x${string}` | undefined;
async function agentAddress() {
  if (signerAddress) return signerAddress;
  const r = await oneclaw().signingKeys.getBalance(agentId(), "base", []);
  if (!r.data?.address) throw new Error("Couldn't read the agent's Base address from 1Claw");
  return (signerAddress = r.data.address as `0x${string}`);
}

/** An x402 EVM signer whose signTypedData is performed by 1Claw. */
async function oneclawSigner() {
  const address = await agentAddress();
  return {
    address,
    async signTypedData(td: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) {
      const types = { ...td.types };
      if (!("EIP712Domain" in types)) {
        const d = td.domain;
        types.EIP712Domain = [
          d.name !== undefined && { name: "name", type: "string" },
          d.version !== undefined && { name: "version", type: "string" },
          d.chainId !== undefined && { name: "chainId", type: "uint256" },
          d.verifyingContract !== undefined && { name: "verifyingContract", type: "address" },
        ].filter(Boolean);
      }
      const r = await oneclaw().agents.sign(agentId(), {
        intent_type: "typed_data",
        chain: "base",
        typed_data: json({ domain: td.domain, types, primaryType: td.primaryType, message: td.message }),
      });
      if (r.error || !r.data?.signature) {
        const e = r.error as { detail?: string; message?: string } | undefined;
        throw new Error(`1Claw signing failed: ${e?.detail ?? e?.message ?? JSON.stringify(r.error)}`);
      }
      return r.data.signature as `0x${string}`;
    },
  };
}

/** Orders a USA prepaid card for exactly `amountUsd`, paid in USDC on Base. */
export async function orderCard(amountUsd: number) {
  const amount = amountUsd.toFixed(2);
  const expectedAtomic = BigInt(Math.round(amountUsd * 1e6));
  const signer = await oneclawSigner();

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(signer as never) }],
    // x402's own spend cap, as a second guard behind the exact-amount check below.
    spendControls: { maxAmountPerPayment: `$${process.env.CARD_MAX_USD ?? 50}` },
    // Only ever pay Laso, on Base, in USDC, for the amount we asked for.
    paymentRequirementsSelector: (_v: number, accepts: Array<Record<string, unknown>>) => {
      const req = accepts.find((a) => a.network === "eip155:8453");
      if (!req) throw new Error("Laso offered no Base payment option");
      const amt = BigInt(String(req.amount ?? req.maxAmountRequired));
      if (String(req.payTo).toLowerCase() !== LASO_PAYTO) throw new Error(`Unexpected payTo ${req.payTo}`);
      if (String(req.asset).toLowerCase() !== BASE_USDC) throw new Error(`Unexpected asset ${req.asset}`);
      if (amt > expectedAtomic + BigInt(50_000)) throw new Error(`Laso asked for ${Number(amt) / 1e6} USDC, expected ${amount}`);
      return req;
    },
  } as never);

  const res = await fetchWithPayment(`${LASO}/get-card?amount=${amount}&format=json`, { method: "GET" });
  const body = (await res.json().catch(() => ({}))) as {
    auth?: { id_token: string; refresh_token?: string };
    user_id?: string;
    card?: { card_id: string; usd_amount: number; status: string };
    errorReason?: string;
    errorMessage?: string;
    error?: string;
    detail?: string;
  };
  if (!res.ok || !body.card) {
    throw new Error(`Laso card order failed (${res.status}): ${body.errorReason ?? ""} ${body.errorMessage ?? body.error ?? body.detail ?? ""}`.trim());
  }
  const prev = session();
  saveSession({
    id_token: body.auth?.id_token ?? prev?.id_token ?? "",
    refresh_token: body.auth?.refresh_token ?? prev?.refresh_token,
    user_id: body.user_id ?? prev?.user_id,
    cards: { ...(prev?.cards ?? {}), [body.card.card_id]: { amount: amountUsd, at: Date.now() } },
  });
  return { card_id: body.card.card_id, status: body.card.status, amount_usd: amount, paid_from: signer.address };
}

export type LasoCardDetails = {
  card_number: string;
  exp_month: string | number;
  exp_year: string | number;
  cvv: string;
  available_balance?: number;
  billing_address?: Record<string, string>;
};

async function getCardData(cardId: string) {
  const s = session();
  if (!s?.id_token) throw new Error("No Laso session — order a card first.");
  const res = await fetch(`${LASO}/get-card-data?card_id=${encodeURIComponent(cardId)}`, {
    headers: { Authorization: `Bearer ${s.id_token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { status?: string; card_details?: LasoCardDetails; error?: string };
  if (!res.ok) throw new Error(`Laso get-card-data failed (${res.status}): ${body.error ?? ""}`);
  return body;
}

/** Polls until the card is ready (Laso: typically 7–10s). Returns masked status only. */
export async function waitForCard(cardId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<typeof getCardData>> | undefined;
  while (Date.now() < deadline) {
    last = await getCardData(cardId);
    if (last.status === "ready" && last.card_details?.card_number) {
      return {
        card_id: cardId,
        status: "ready",
        last4: last.card_details.card_number.slice(-4),
        balance: last.card_details.available_balance,
      };
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return { card_id: cardId, status: last?.status ?? "unknown", error: "Card not ready yet." };
}

/** Full card details. Server-side only — never return this to the model or the browser client. */
export async function revealCard(cardId: string) {
  const d = await getCardData(cardId);
  if (d.status !== "ready" || !d.card_details) throw new Error(`Card isn't ready (status ${d.status}).`);
  return d.card_details;
}
