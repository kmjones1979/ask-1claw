"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Sequential TTS queue backed by /api/tts (ElevenLabs).
 * Text is spoken in the order it's enqueued; `speaking` is true while audio plays.
 */
export function useSpeaker(enabled: boolean) {
  const queue = useRef<string[]>([]);
  const playing = useRef(false);
  const current = useRef<HTMLAudioElement | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const ctxRef = useRef<AudioContext | null>(null);

  const playNext = useCallback(async () => {
    if (playing.current) return;
    const text = queue.current.shift();
    if (!text) {
      setSpeaking(false);
      return;
    }
    playing.current = true;
    setSpeaking(true);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await res.text());
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      current.current = audio;

      // Drive the avatar's "talking" glow from the audio amplitude.
      let raf = 0;
      try {
        ctxRef.current ??= new AudioContext();
        const ctx = ctxRef.current;
        const src = ctx.createMediaElementSource(audio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(buf);
          setLevel(buf.reduce((a, b) => a + b, 0) / buf.length / 255);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // analyser is cosmetic; ignore failures
      }

      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
      cancelAnimationFrame(raf);
      setLevel(0);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("TTS failed", err);
    } finally {
      current.current = null;
      playing.current = false;
      void playNext();
    }
  }, []);

  const speak = useCallback(
    (text: string) => {
      const clean = stripForSpeech(text);
      if (!enabled || !clean) return;
      queue.current.push(clean);
      void playNext();
    },
    [enabled, playNext],
  );

  const stop = useCallback(() => {
    queue.current = [];
    current.current?.pause();
    current.current = null;
    playing.current = false;
    setSpeaking(false);
    setLevel(0);
  }, []);

  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);

  return { speak, stop, speaking, level };
}

/** Push-to-talk recorder that transcribes via /api/stt (ElevenLabs Scribe). */
export function useRecorder(onTranscript: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const start = useCallback(async () => {
    if (recorder.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    chunks.current = [];
    mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      setRecording(false);
      const blob = new Blob(chunks.current, { type: mr.mimeType });
      if (blob.size < 2000) return; // accidental tap
      setTranscribing(true);
      try {
        const form = new FormData();
        form.append("audio", blob);
        const res = await fetch("/api/stt", { method: "POST", body: form });
        if (!res.ok) throw new Error(await res.text());
        const { text } = (await res.json()) as { text: string };
        if (text) onTranscript(text);
      } catch (err) {
        console.error("STT failed", err);
      } finally {
        setTranscribing(false);
      }
    };
    recorder.current = mr;
    mr.start();
    setRecording(true);
  }, [onTranscript]);

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const toggle = useCallback(() => {
    if (recorder.current) stop();
    else void start();
  }, [start, stop]);

  return { recording, transcribing, start, stop, toggle };
}

function stripForSpeech(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_#`>]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .trim();
}
