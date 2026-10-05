// Text-to-speech via ElevenLabs. Streams MP3 audio back to the browser.
export async function POST(req: Request) {
  const { text } = (await req.json()) as { text: string };
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return new Response("ELEVENLABS_API_KEY not set", { status: 500 });

  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "QMJTqaMXmGnG8TCm8WQG"; // "Clyde" - vintage radio announcer
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5",
        voice_settings: { stability: 0.45, similarity_boost: 0.8 },
      }),
    },
  );
  if (!res.ok || !res.body) {
    return new Response(await res.text(), { status: res.status });
  }
  return new Response(res.body, { headers: { "Content-Type": "audio/mpeg" } });
}
