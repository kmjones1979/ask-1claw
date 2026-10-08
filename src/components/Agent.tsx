"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecorder, useSpeaker } from "@/lib/voice";

type Mode = "chat" | "portrait";

export default function Agent() {
  const [mode, setMode] = useState<Mode>("portrait");
  const [voiceOn, setVoiceOn] = useState(true);
  const [input, setInput] = useState("");
  const speaker = useSpeaker(voiceOn);
  const spoken = useRef(new Set<string>());

  const { messages, sendMessage, status, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const busy = status === "submitted" || status === "streaming";

  // Launch the agent's browser (signed in to Amazon) as soon as the page opens.
  useEffect(() => {
    void fetch("/api/warmup", { method: "POST" }).catch(() => {});
  }, []);

  // Speak each text part once it has finished streaming, so the agent narrates
  // progress ("checking my wallet…") during long multi-step purchases.
  useEffect(() => {
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      m.parts.forEach((p, i) => {
        if (p.type !== "text") return;
        const key = `${m.id}:${i}`;
        const done = p.state === "done" || (!busy && p.state !== "streaming");
        if (done && !spoken.current.has(key) && p.text.trim()) {
          spoken.current.add(key);
          speaker.speak(p.text);
        }
      });
    }
  }, [messages, busy, speaker]);

  const send = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      speaker.stop();
      void sendMessage({ text });
    },
    [sendMessage, speaker],
  );

  const recorder = useRecorder(send);

  // Space bar = push-to-talk (hold), handy on stage with a clicker/keyboard.
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) =>
      (e.target as HTMLElement)?.tagName === "INPUT" ||
      (e.target as HTMLElement)?.tagName === "TEXTAREA";
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping(e)) return;
      e.preventDefault();
      speaker.stop();
      void recorder.start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e)) return;
      e.preventDefault();
      recorder.stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [recorder, speaker]);

  const state = recorder.recording
    ? "listening"
    : recorder.transcribing
      ? "transcribing"
      : speaker.speaking
        ? "speaking"
        : busy
          ? "working"
          : "idle";

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");

  return (
    <div className="relative flex h-dvh w-full flex-col overflow-hidden bg-background text-white">
      <header className="z-20 flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-medium tracking-wide text-white/80">
          <span className="inline-block h-2 w-2 rounded-full bg-claw-red shadow-[0_0_10px] shadow-claw-red" />
          Ask Max
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setVoiceOn((v) => !v)}
            className="rounded-full border border-claw-border px-3 py-1.5 text-xs text-white/80 hover:bg-claw-card-2"
          >
            {voiceOn ? "🔊 Voice on" : "🔇 Voice off"}
          </button>
          <div className="flex rounded-full border border-claw-border p-0.5 text-xs">
            {(["portrait", "chat"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1 capitalize ${
                  mode === m ? "bg-claw-red text-white" : "text-claw-muted hover:text-white"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </header>

      {mode === "portrait" ? (
        <Portrait
          state={state}
          level={speaker.level}
          caption={textOf(lastAssistant)}
          heard={textOf(lastUser)}
          steps={lastAssistant ? toolSteps(lastAssistant) : []}
          onMic={() => {
            speaker.stop();
            recorder.toggle();
          }}
        />
      ) : (
        <Chat
          messages={messages}
          busy={busy}
          state={state}
          input={input}
          setInput={setInput}
          onSend={() => {
            send(input);
            setInput("");
          }}
          onStop={stop}
          onMic={() => {
            speaker.stop();
            recorder.toggle();
          }}
        />
      )}

      <a
        href="https://1claw.co"
        target="_blank"
        rel="noreferrer"
        className={`fixed bottom-4 right-5 z-30 items-center gap-2.5 opacity-80 transition hover:opacity-100 ${
          mode === "chat" ? "hidden lg:flex" : "flex"
        }`}
      >
        <span className="text-[11px] uppercase tracking-[0.18em] text-claw-muted">Powered by</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/1claw-logo.svg" alt="1Claw" className="h-6 w-auto" />
      </a>
    </div>
  );
}

type AgentState = "idle" | "listening" | "transcribing" | "working" | "speaking";

const STATE_LABEL: Record<AgentState, string> = {
  idle: "Tap the mic or hold space to talk",
  listening: "Listening…",
  transcribing: "Got it…",
  working: "Working on it…",
  speaking: "",
};

function Portrait(props: {
  state: AgentState;
  level: number;
  caption: string;
  heard: string;
  steps: Step[];
  onMic: () => void;
}) {
  const { state, level, caption, heard, steps, onMic } = props;
  // Only render the portrait once we know public/agent.png exists (avoids a broken-image flash).
  const [hasPortrait, setHasPortrait] = useState(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setHasPortrait(true);
    img.src = "/agent.jpg";
  }, []);
  const scale = 1 + level * 0.25;
  const ring =
    state === "listening"
      ? "shadow-claw-red/60"
      : state === "working"
        ? "shadow-claw-red-deep/50"
        : state === "speaking"
          ? "shadow-claw-red/80"
          : "shadow-claw-red-low/30";

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center gap-8 px-4 pb-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(223,23,26,0.14),transparent_60%)]" />

      <div className="relative">
        <div
          className={`relative aspect-[3/4] h-[52dvh] max-h-[640px] overflow-hidden rounded-[2.5rem] border border-claw-border shadow-[0_0_120px] transition-shadow duration-500 ${ring} ${
            state === "working" ? "animate-pulse" : ""
          }`}
          style={{ transform: `scale(${scale})`, transition: "transform 80ms linear" }}
        >
          {/* Drop your agent portrait at public/agent.jpg. */}
          {hasPortrait && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/agent.jpg" alt="Agent" className="h-full w-full object-cover" />
          )}
          <div className="absolute inset-0 -z-10 bg-gradient-to-b from-claw-red/35 via-claw-red-low/20 to-claw-black" />
          <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/80 to-transparent" />
        </div>
      </div>

      <div className="z-10 flex min-h-[7rem] max-w-3xl flex-col items-center gap-3 text-center">
        {heard && <p className="text-sm text-claw-muted-2">“{heard}”</p>}
        {steps.length > 0 && state !== "idle" && (
          <ul className="flex flex-wrap justify-center gap-2">
            {steps.map((s, i) => (
              <li
                key={i}
                className={`rounded-full border px-3 py-1 text-xs ${
                  s.status === "done"
                    ? "border-claw-ok/30 bg-claw-ok/10 text-claw-ok"
                    : s.status === "error"
                      ? "border-claw-red-soft/30 bg-claw-red-soft/10 text-claw-red-soft"
                      : "border-claw-red/40 bg-claw-red/10 text-white"
                }`}
              >
                {s.status === "running" ? "⏳ " : s.status === "done" ? "✓ " : "✕ "}
                {s.label}
              </li>
            ))}
          </ul>
        )}
        <p className="line-clamp-4 text-xl leading-relaxed text-white md:text-2xl">
          {state === "speaking" || state === "idle" ? caption : STATE_LABEL[state]}
        </p>
        {state === "idle" && !caption && <p className="text-sm text-claw-muted-2">{STATE_LABEL.idle}</p>}
      </div>

      <MicButton state={state} onClick={onMic} big />
    </main>
  );
}

function Chat(props: {
  messages: UIMessage[];
  busy: boolean;
  state: AgentState;
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onMic: () => void;
}) {
  const { messages, busy, state, input, setInput, onSend, onStop, onMic } = props;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden px-4">
      <div className="flex-1 space-y-4 overflow-y-auto py-4">
        {messages.length === 0 && (
          <p className="mt-20 text-center text-claw-muted-2">
            Ask me anything — I can pay for things onchain with 1Claw.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
            <div
              className={`max-w-[85%] space-y-2 rounded-2xl px-4 py-3 ${
                m.role === "user" ? "bg-claw-gradient text-white" : "border border-claw-border bg-claw-card"
              }`}
            >
              {m.parts.map((p, i) =>
                p.type === "text" ? (
                  <p key={i} className="whitespace-pre-wrap leading-relaxed">
                    {p.text}
                  </p>
                ) : null,
              )}
              {m.role === "assistant" &&
                toolSteps(m).map((s, i) => (
                  <div key={`t${i}`} className="font-mono text-xs text-claw-muted">
                    {s.status === "running" ? "⏳" : s.status === "done" ? "✓" : "✕"} {s.label}
                  </div>
                ))}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="flex items-center gap-2 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <MicButton state={state} onClick={onMic} />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 rounded-full border border-claw-border bg-claw-card px-5 py-3 outline-none focus:border-claw-red"
        />
        {busy ? (
          <button type="button" onClick={onStop} className="rounded-full border border-claw-border bg-claw-card-2 px-5 py-3">
            Stop
          </button>
        ) : (
          <button className="rounded-full bg-claw-gradient px-5 py-3 font-medium text-white">Send</button>
        )}
      </form>
    </main>
  );
}

function MicButton({ state, onClick, big }: { state: AgentState; onClick: () => void; big?: boolean }) {
  const active = state === "listening";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={active ? "Stop recording" : "Start recording"}
      className={`z-10 flex shrink-0 items-center justify-center rounded-full transition ${
        big ? "h-20 w-20 text-3xl" : "h-12 w-12 text-xl"
      } ${active ? "animate-pulse bg-claw-red shadow-[0_0_40px] shadow-claw-red/60" : "border border-claw-border bg-claw-card-2 hover:border-claw-red/60"}`}
    >
      {active ? "■" : "🎙"}
    </button>
  );
}

type Step = { label: string; status: "running" | "done" | "error" };

// Friendly labels for the tool calls the audience sees on stage.
const TOOL_LABELS: Record<string, string> = {
  get_wallet_balance: "Checking USDC balance on Base",
  find_product: "Searching Amazon",
  buy_product: "Order placed",
  issue_card: "Buying a card from Laso with USDC",
  wait_for_card: "Waiting for the card",
  fill_payment_card: "Entering card securely",
  amazon_search: "Searching Amazon",
  amazon_add_to_cart: "Adding to cart",
  amazon_checkout: "Going to checkout",
  amazon_checkout_summary: "Reviewing the order",
  amazon_place_order: "Placing the order",
  browser_navigate: "Browsing Amazon",
  browser_snapshot: "Reading the page",
  browser_screenshot: "Looking at the page",
  browser_click: "Clicking",
  browser_type: "Typing",
  browser_select: "Choosing an option",
  browser_press_key: "Typing",
  browser_scroll: "Scrolling",
};

function toolSteps(m: UIMessage): Step[] {
  const steps: Step[] = [];
  for (const p of m.parts) {
    let name: string | undefined;
    if (p.type === "dynamic-tool") name = p.toolName;
    else if (p.type.startsWith("tool-")) name = p.type.slice(5);
    if (!name || !("state" in p)) continue;
    const output = "output" in p ? (p.output as { done?: boolean; ok?: boolean; label?: string } | undefined) : undefined;
    const preliminary = "preliminary" in p && Boolean((p as { preliminary?: boolean }).preliminary);
    let status: Step["status"] =
      p.state === "output-available" ? "done" : p.state === "output-error" ? "error" : "running";
    // buy_product streams its stages as preliminary results: show the live stage.
    if (name === "buy_product" && output) {
      if (preliminary || output.done === false) status = "running";
      else if (output.ok === false) status = "error";
    }
    const label =
      name === "buy_product" && output?.label && status === "running"
        ? output.label
        : name === "buy_product" && status === "error"
          ? "Purchase stopped"
          : (TOOL_LABELS[name] ?? name.replace(/[_-]/g, " "));
    // Collapse consecutive repeats (e.g. many snapshots) into one chip.
    const prev = steps.at(-1);
    if (prev?.label === label) prev.status = status;
    else steps.push({ label, status });
  }
  return steps.slice(-6);
}

function textOf(m?: UIMessage) {
  if (!m) return "";
  const texts = m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
  return texts.at(-1) ?? "";
}
