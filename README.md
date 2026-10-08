# Ask Max

A voice agent for a live stage demo. You ask Max, out loud:

> "Can you buy me a pack of Pokemon cards on Amazon?"

Max then buys it with no human payment step:

1. Finds a pack on Amazon.
2. Gets a prepaid card from Laso Finance, paid in USDC on Base and signed by his 1Claw-held key.
3. Checks out on Amazon in a real, signed-in browser driven through 1Claw browser-bridge.
4. Tells you, in his ElevenLabs voice, when it will arrive.

On the `integration/fast-path-pilo` branch, the purchase runs as a single server-side step, product search goes through Bowmark, Amazon re-logins are filled from a vault by browser-bridge, and page text is treated as untrusted. All of these are described below.

---

## Contents

- [How it works](#how-it-works)
- [The purchase, step by step](#the-purchase-step-by-step)
- [Components](#components)
- [Safety and security](#safety-and-security)
- [Setup](#setup)
- [Running the demo](#running-the-demo)
- [Configuration reference](#configuration-reference)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Third-party code](#third-party-code)

---

## How it works

```
 you (voice) ──► ElevenLabs STT ──► Next.js /api/chat ──► Claude (via 1Claw Shroud, token-billed)
                                         │
                                         ├─ find_product ──► Bowmark (public Amazon search, hosted)
                                         │                     └─ fallback: browser-bridge
                                         │
                                         └─ buy_product (one server-side pipeline)
                                               ├─ Amazon cart / checkout ──► 1Claw browser-bridge ──► Chrome
                                               │                              (gated CDP, your signed-in session)
                                               ├─ Laso card ──► x402 payment, EIP-3009 signed by 1Claw
                                               │                (agent's key never leaves 1Claw)
                                               ├─ Amazon re-login ──► browser-bridge request_fill from an
                                               │                       encrypted vault (password never seen)
                                               └─ place order (hard-gated)
 Max's reply ◄── ElevenLabs TTS ◄────────┘
```

- **Voice in and out:** ElevenLabs. Speech-to-text uses Scribe; text-to-speech uses the Max voice.
- **Brain:** Claude Sonnet 5, called through **1Claw Shroud**, so token usage is billed to the 1Claw org (LLM Token Billing). No Anthropic key is needed.
- **Money:** the agent's own **USDC on Base**. The private key is held by 1Claw; the app only ever asks 1Claw to sign.
- **Browser:** **1Claw browser-bridge** launches Chrome and passes every DevTools (CDP) command through an allowlist gate. Max acts in your signed-in Amazon session, inside that gate.

## The purchase, step by step

`buy_product(asin)` runs the whole checkout in one tool call. It streams its progress to the UI as preliminary tool results.

| # | Stage | What happens |
|---|---|---|
| 1 | **Cart** | Makes sure the cart holds exactly this item. It refuses if other items are present and doesn't re-add the item if it's already there. |
| 2 | **Checkout** | Submits the cart's checkout form and reads the **order total** after tax and shipping. Refuses if checkout pulled in items from another cart, such as Amazon Haul. |
| 3 | **Card** | **Reuses** an unspent Laso card whose balance covers the total; otherwise buys one for **exactly the total**. The daily USDC limit is checked first. |
| 4 | **Card ready** | Polls Laso until the card is issued, usually 7–20 s. |
| 5 | **Add card** | Adds the card in Amazon's *Your Payments* by typing into Amazon's secure card iframe. The card is **never** set as the account default. Skipped if the card is already saved. |
| 6 | **Select** | Back at checkout, selects the card ending in its last 4 digits, then verifies the review page reads **"Paying with … ####"**. Re-selects if Amazon falls back to the default card. |
| 7 | **Place** | **Hard gate:** the order is placed only if the "Paying with" line shows that card and the total equals the card amount. Returns the delivery estimate. |

**Resuming:** if a stage fails, for example on Amazon's "I am human" check, Max asks you to fix it and calls `buy_product` again. It picks up where it left off, without adding the item twice or buying a second card.

**Fallback:** step-by-step tools (`amazon_add_to_cart`, `amazon_checkout`, `issue_card`, `amazon_select_card`, `amazon_place_order`, plus generic `browser_*` tools) remain available if the fast path fails partway.

**Speed:** a full purchase used to take about 10 model round trips. With `find_product` plus `buy_product`, it's about 3: search, buy, then speak.

## Components

### 1Claw

- **Agent identity:** a dedicated 1Claw agent with its own key (`ocv_…`). The app authenticates as that agent.
- **Signing key:** an EVM key held by 1Claw, never exported, that owns the USDC on Base. It signs the EIP-3009 `TransferWithAuthorization` for Laso through `agents.sign`, as `typed_data`. Base USDC must be on the agent's `eip712_domain_allowlist`; every other contract is denied.
- **Shroud:** the LLM proxy at `shroud.1claw.co`, with org LLM Token Billing.
- **Card vault (optional):** `CARD_PROVIDER=oneclaw` orders cards through 1Claw's Payment Card Vault instead of paying Laso directly.
- **browser-bridge:** [`@1claw/browser-bridge`](https://github.com/1clawAI/browser-bridge).
  - It launches Chrome over a pipe and exposes a token-protected local CDP WebSocket.
  - Every command is allowlisted. Element-handle APIs such as `DOM.resolveNode` are refused, so all actions are built from `Runtime.evaluate` and real input events.
  - Its **LocalVaultDriver** (an AES-256-GCM vault file) holds the Amazon password, which the bridge fills itself via `request_fill`.

### Laso Finance (direct x402)

The flow is `GET https://laso.finance/get-card?amount=<total>`:
1. Laso answers with an x402 v2 challenge on `eip155:8453`.
2. The [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) client signs the payment through a signer that forwards to 1Claw.
3. Laso issues a non-reloadable US prepaid card for exactly that amount, with no fee.
4. Card details come from `GET /get-card-data` just in time, and are never stored. Laso tokens refresh automatically when they expire.

### Amazon automation

The hand-written steps live in `src/lib/amazon.ts`: search, cart, checkout, address and billing pickers, the card iframe, payment selection, the review gate and the confirmation. They are built on `src/lib/browser.ts`, which works within the bridge's gate:
- `fastGoto` navigates through `Page.navigate`, because Puppeteer's lifecycle events don't pass through the proxy.
- The browser relaunches itself if it disconnects.
- Clicks go through the mouse at element coordinates.

### Bowmark (public search only)

[Bowmark](https://bowmark.ai) runs typed functions on live sites in its own hosted browsers.
- `find_product` uses `bowmark.providers.amazon.searchProducts` (`POST /v1/run`).
- Searching therefore doesn't load pages in your signed-in session, which means fewer bot checks. Bowmark sees only the query text.
- If Bowmark fails or isn't configured, search falls back to the bridge.
- Bowmark is **not** used for cart, card or checkout. Its sessions are its own, and the demo's security model keeps those steps in your gated browser.

### Ideas adapted from Mozilla pilo

- **Page reader (accessibility tree).** `browser_snapshot` returns a compact YAML accessibility tree with `[ref=E12]` handles, built from pilo's Playwright-derived aria-tree code (vendored in `vendor/pilo-ariaTree`).
  - The code is bundled into `src/lib/ariaTree.generated.ts` by `npm run build:aria`.
  - It's injected as a `Runtime.evaluate` expression, which avoids `new Function`, so it's CSP-safe and allowed by the gate.
  - It's rooted at the main content (results, product, cart or checkout), and password and card values are masked.
- **Prompt-injection wrapper.** Page-sourced text reaches the model inside line-prefixed `<EXTERNAL-CONTENT>` tags, and the system prompt treats it as data.

### Voice and UI

- **Next.js App Router with AI SDK 7.**
- **Portrait mode:** a full-screen avatar that glows with the audio level, live captions, and step chips that show `buy_product`'s current stage.
- **Chat mode:** a standard chat view.
- **Push-to-talk:** hold **Space**.
- **Pre-flight badge** in the header: **Ready ✓**, or **N issue(s)** with details on hover. It's backed by `/api/ready`.

## Safety and security

**Money guardrails**
- **Daily USDC limit** (`DAILY_USDC_LIMIT`): a rolling 24-hour cap on USDC spent buying cards, enforced before any payment. Card purchases are serialized, so two orders can't both slip under it.
- **Per-card cap** (`CARD_MAX_USD`) and Laso's $5 minimum.
- **Exact total:** the card amount always comes from the checkout page; the model never chooses it.
- **The x402 client only pays** Laso's known Base payTo, in Base USDC, for the expected amount. Its own `spendControls` cap applies too.
- **1Claw-side controls:** an `eip712_domain_allowlist` restricted to Base USDC; for the 1Claw card path, `card_payto_allowlist`, `card_daily_limit_usd` and `card_max_order_usd`.

**Never the wrong card**
- **Only one path places orders.** Only `buy_product` and `amazon_place_order` can, and both go through `guardedPlaceOrder`, which checks the review page's own "Paying with … ####" line.
- **Generic clicks can't buy.** `browser_click` refuses "Place your order", "Buy Now" and similar buttons, and Enter or submit is refused on checkout pages.
- **No default-card changes.** "Default to this payment method" boxes are unticked, and "Buy Now" (which uses the default card) is never used.

**Secrets never reach the model**
- **Card numbers** go server-side straight into Amazon's form. Tools return only the last 4 digits.
- **The Amazon password** lives in the encrypted vault and is typed by browser-bridge. Before typing, the bridge checks the tab, frame and form-action origins against `www.amazon.com` and re-checks that the page hasn't navigated.
- **API keys** stay in `.env`, which git ignores. Agent keys live in 1Claw.

**Privacy and untrusted content**
- **Address redaction:** every tool result is scrubbed of street addresses, city/ZIP and phone numbers before the model sees it. Max is instructed never to say an address and refers to "your default address".
- **Page text** is wrapped as untrusted `EXTERNAL-CONTENT` (see above).

**Bot checks**
- **Amazon's "I am human" check is never solved automatically.** Max asks you to tick it, and once cleared, the clearance cookie is saved so it persists across restarts.

## Setup

**Requirements:** macOS with Google Chrome, Node 24 or later, and a US Amazon account with a default shipping address.

### 1. Install and configure

```bash
npm install
cp .env.example .env    # fill it in — see the Configuration reference below
```

### 2. Create and configure the 1Claw agent

Create an agent in the 1Claw dashboard, or with the SDK using your personal `1ck_` key.

| Setting | Value |
|---|---|
| `shroud_enabled` | `true`, plus **LLM Token Billing** enabled for the org |
| `intents_api_enabled` | `true`, with an EVM signing key provisioned |
| `eip712_domain_allowlist` | `[{"verifying_contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}]` (Base USDC) |
| Cards, only for `CARD_PROVIDER=oneclaw` | `cards_enabled`, `card_reveal_enabled`, `card_payto_allowlist: ["0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37"]` (Laso, Base), plus limits |

Fund the agent's signing-key address with USDC on Base. Put `ONECLAW_AGENT_ID` and `ONECLAW_AGENT_API_KEY` in `.env`.

### 3. Sign in to Amazon once

```bash
npm run amazon-login
```

1. A browser opens through browser-bridge.
2. Sign in, ticking "Keep me signed in".
3. Press Enter in the terminal. The cookies are saved to `.amazon-session.json` (git-ignored, mode 600) and restored on every launch.

### 4. Store the Amazon password in the bridge vault

This lets Amazon's periodic "re-enter your password" step be filled automatically. Create the vault once:

```bash
mkdir -p ~/.1claw && chmod 700 ~/.1claw
# put ONECLAW_BRIDGE_VAULT and ONECLAW_BRIDGE_VAULT_PASSPHRASE in .env first
export ONECLAW_SUPPRESS_DEPRECATION=1 ONECLAW_BRIDGE_VAULT_PASSPHRASE="$(grep '^ONECLAW_BRIDGE_VAULT_PASSPHRASE=' .env | cut -d= -f2-)"
node node_modules/@1claw/browser-bridge/bin/1claw-vault.mjs init ~/.1claw/ask-1claw-vault.json
```

Then add the password. It's prompted without echoing, so it never lands on screen or in a file:

```bash
read -rs "P?Amazon password: " && echo && printf '%s' "$P" | \
  node node_modules/@1claw/browser-bridge/bin/1claw-vault.mjs add ~/.1claw/ask-1claw-vault.json \
  --id amazon --url https://www.amazon.com/ap/signin --hosts www.amazon.com; unset P
```

### 5. Optional: Bowmark

Get a key at https://bowmark.ai/dashboard/keys and set `BOWMARK_API_KEY` in `.env`. Without it, search uses the bridge.

### 6. Run

```bash
npm run dev    # → http://localhost:3000
```

The page warms up Max's browser and runs the pre-flight check. Look for **Ready ✓** in the header.

## Running the demo

**Before going on stage**
- Wait for **Ready ✓**. Hover over it if it shows issues.
- Make sure your main cart and your **Amazon Haul** cart are empty. Pre-flight checks the main cart only.
- Keep the laptop awake and online, and keep Max's Chrome window somewhere you can reach.
- **Don't edit code while it runs.** Hot reload can leave old and new browser code fighting over Chrome. Restart `npm run dev` after changes.
- **Don't rehearse right before going on.** A rehearsal fills the cart and can place a real order.

**On stage**
1. Portrait mode, hold **Space**: "Can you buy me a pack of Pokemon cards on Amazon?"
2. Max searches, picks a pack, says what he's buying, and runs `buy_product`. The step chips show each stage.
3. If Amazon shows "I am human", Max asks you to tick it, then continues.
4. Max confirms the purchase and the delivery day, and says "your default address" rather than the address itself.

## Configuration reference

| Variable | Purpose |
|---|---|
| `ONECLAW_API_KEY` | Personal `1ck_` key, used only by setup scripts and agent configuration. |
| `ONECLAW_AGENT_ID`, `ONECLAW_AGENT_API_KEY` | The agent identity: wallet, signing and Shroud billing. |
| `LLM_MODEL` | Default `claude-sonnet-5`, via Shroud. `ANTHROPIC_API_KEY` bypasses Shroud. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Voice. The default voice is Max (`Gfpl8Yo74Is0W6cPUWWT`). |
| `CARD_PROVIDER` | `laso` (direct x402, default) or `oneclaw` (1Claw card vault). |
| `CARD_MAX_USD` | Per-card cap. Default 50. |
| `DAILY_USDC_LIMIT` | Rolling 24-hour USDC cap for card purchases. Default 20. |
| `CARD_HOLDER_NAME` | Name typed on Amazon's card form. |
| `SHIP_TO_MATCH` | Optional. Text of a saved Amazon address to ship and bill to. Empty means the account default. |
| `CARD_BILLING_ZIP` | Optional ZIP used to pick the billing address. Empty means the shipping address. |
| `ONECLAW_BRIDGE_CHROME` | Chrome path. Defaults to `/Applications/Google Chrome.app/...`. |
| `BROWSER_HEADLESS` | `false` keeps Max's browser visible. |
| `ONECLAW_BRIDGE_VAULT`, `ONECLAW_BRIDGE_VAULT_PASSPHRASE` | The encrypted credential vault for Amazon re-login. |
| `BOWMARK_API_KEY` | Optional. Public product search through Bowmark. |
| `AGENT_NAME` | Max's name in the prompt. |

## Project layout

```
src/app/page.tsx                 → <Agent/> UI
src/components/Agent.tsx         Portrait/Chat UI, push-to-talk, step chips, pre-flight badge
src/lib/voice.ts                 ElevenLabs TTS queue + recorder (client)
src/app/api/chat/route.ts        Agent loop (AI SDK streamText, tools, no extended thinking)
src/app/api/tts|stt/route.ts     ElevenLabs proxies
src/app/api/warmup/route.ts      Launch Max's browser on page load
src/app/api/ready/route.ts       Pre-flight readiness check
src/lib/prompt.ts                System prompt (persona, fast path, safety, privacy)
src/lib/model.ts                 Claude via 1Claw Shroud
src/lib/tools.ts                 All tools, timeouts, address redaction, untrusted-content wrapping
src/lib/purchase.ts              buy_product pipeline + guardedPlaceOrder
src/lib/amazon.ts                Amazon flows (search, cart, checkout, card iframe, payment, re-auth)
src/lib/browser.ts               browser-bridge session, self-healing, vault fill, aria snapshot
src/lib/laso.ts                  Laso x402 (1Claw-signed), card polling/reveal, token refresh, daily limit
src/lib/cards.ts                 Card provider switch (laso | oneclaw), reuse
src/lib/oneclaw.ts               1Claw SDK: balance, 1Claw card vault
src/lib/bowmark.ts               Bowmark search
src/lib/promptSecurity.ts        EXTERNAL-CONTENT wrapper (adapted from pilo)
src/lib/ariaTree.generated.ts    Bundled aria-tree script (generated)
vendor/pilo-ariaTree/            Vendored pilo aria-tree sources (Apache-2.0)
scripts/amazon-login.mjs         One-time Amazon sign-in → cookies
scripts/build-aria.mjs           Bundle the aria tree (npm run build:aria)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "I am human" check | Tick it in Max's browser. The clearance is saved. Caused by bursts of page loads. |
| `SIGN_IN_REQUIRED` | The vault fill failed or Amazon wants a code or passkey. Sign in by hand in Max's window. Check that pre-flight shows "Password vault ✓". |
| Stuck on "Working on it…" | Restart `npm run dev`, especially after code edits. |
| Browser unreachable after sleep or network loss | It relaunches by itself on the next step. |
| `DAILY_LIMIT` | Over the rolling 24-hour USDC cap. Raise `DAILY_USDC_LIMIT` or wait. |
| `settlement_failed` from Laso | The wallet can't cover the amount. Fund USDC on Base. |
| "Cart has other items" or "Checkout contains N items" | Empty your main and Amazon Haul carts. |
| Max's voice silent | Check the macOS output device. Virtual audio drivers such as Loom's can capture it. |

## Known limitations

- **Amazon's UI changes** break selectors. The flows are tuned to the current checkout (`/checkout/p/…/pay`, `/spc`) and the `apx-security` card iframe.
- **Prepaid cards** may be declined by some merchants. Laso lists Amazon as accepted.
- **Amazon re-auth** can ask for a code or passkey instead of a password; the vault only fills passwords.
- **The bridge's generation counter** isn't exposed, so the app mirrors it and tries nearby values. A stale guess aborts before anything is typed.
- **US only:** Laso `/get-card` cards are for US merchants.

## Third-party code

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- The aria-tree reader and prompt-injection wrapper are adapted from **Mozilla pilo** (Apache-2.0). pilo's aria tree is derived from **Microsoft Playwright** (Apache-2.0).
- Uses 1Claw browser-bridge (Apache-2.0), the x402 client libraries, Vercel AI SDK, Next.js and Puppeteer.
