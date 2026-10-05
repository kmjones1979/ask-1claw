import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { agentModel } from "@/lib/model";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { tools } from "@/lib/tools";

// A full Amazon checkout can take a few minutes of browsing.
export const maxDuration = 600;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: agentModel(),
    instructions: SYSTEM_PROMPT(),
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: isStepCount(80),
    // No extended thinking: each browser step is simple, and latency matters on stage.
    providerOptions: { anthropic: { thinking: { type: "disabled" } } },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
