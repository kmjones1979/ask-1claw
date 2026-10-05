// Speech-to-text via ElevenLabs Scribe. Accepts a recorded audio blob as multipart form data.
export async function POST(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return new Response("ELEVENLABS_API_KEY not set", { status: 500 });

  const incoming = await req.formData();
  const audio = incoming.get("audio");
  if (!(audio instanceof Blob)) return new Response("missing audio", { status: 400 });

  const form = new FormData();
  form.append("file", audio, "speech.webm");
  form.append("model_id", process.env.ELEVENLABS_STT_MODEL_ID ?? "scribe_v1");
  form.append("language_code", "en");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!res.ok) return new Response(await res.text(), { status: res.status });
  const data = (await res.json()) as { text?: string };
  return Response.json({ text: (data.text ?? "").trim() });
}
