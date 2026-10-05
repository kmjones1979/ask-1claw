# Ask 1Claw

Voice agent for a live demo: speak to it, it answers with ElevenLabs, and it pays for things
onchain through 1Claw — USDC on Base → prepaid Laso card → Amazon checkout via 1Claw browser-bridge.

## Setup
1. `cp .env.example .env` and fill it in (see comments).
2. In the 1Claw dashboard, for the agent in `ONECLAW_AGENT_ID`:
   - Shroud enabled + org **LLM Token Billing** on (the LLM is billed through Shroud).
   - Cards enabled; max order / daily limit ≥ `CARD_MAX_USD`; **agent card reveal enabled**
     (the server reveals the card to type it — the model never sees the number).
   - Card approval: on = you approve live on your phone (nice stage moment), off = fully autonomous.
   - An EVM signing key funded with USDC on Base.
3. `npm run amazon-login` — sign in to Amazon in the window that opens, then press Enter.
4. `npm run dev` → http://localhost:3000. Drop a portrait at `public/agent.png`.

## Using it
- **Portrait** (default) / **Chat** toggle top-right. Hold **Space** or tap the mic to talk.
- The agent's browser window is visible (`BROWSER_HEADLESS=false`) so the audience can watch.

## Layout
- `src/app/api/chat` — agent loop (AI SDK, Claude via 1Claw Shroud)
- `src/lib/tools.ts` — 1Claw wallet/card tools + browser tools
- `src/lib/browser.ts` — browser-bridge + puppeteer-core (CDP allowlist-safe actions)
- `src/app/api/tts`, `src/app/api/stt` — ElevenLabs
