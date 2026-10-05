import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";

/**
 * The LLM is reached through 1Claw Shroud so token usage is billed to the 1Claw org
 * (LLM Token Billing) — no Anthropic key needed. Set ANTHROPIC_API_KEY to bypass Shroud.
 */
export function agentModel() {
  const modelId = process.env.LLM_MODEL ?? "claude-sonnet-5";
  if (process.env.ANTHROPIC_API_KEY) return createAnthropic()(modelId);

  const agentId = process.env.ONECLAW_AGENT_ID;
  const agentKey = process.env.ONECLAW_AGENT_API_KEY;
  if (!agentId || !agentKey) throw new Error("ONECLAW_AGENT_ID and ONECLAW_AGENT_API_KEY must be set");

  return createAnthropic({
    baseURL: process.env.SHROUD_URL ?? "https://shroud.1claw.co/v1",
    authToken: agentKey,
    headers: {
      "X-Shroud-Agent-Key": `${agentId}:${agentKey}`,
      "X-Shroud-Provider": "anthropic",
    },
  })(modelId);
}
