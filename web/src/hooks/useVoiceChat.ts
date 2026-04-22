"use client";

import { useState, useRef, useCallback } from "react";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type VoiceStatus =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

export function useVoiceChat(token: string | null, robotName = "ARIA", voiceId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string>("");

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ── Start recording ──────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunks.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.current.push(e.data);
      };
      mediaRecorder.current = recorder;
      recorder.start(100); // collect in 100ms chunks
      setStatus("recording");
    } catch (e) {
      setError("Microphone access denied. Please allow microphone in your browser.");
      setStatus("error");
    }
  }, []);

  // ── Stop recording → full pipeline ───────────────────────────────────────
  const stopRecording = useCallback(() => {
    const recorder = mediaRecorder.current;
    if (!recorder || recorder.state === "inactive") return;

    recorder.onstop = async () => {
      // stop all mic tracks
      recorder.stream.getTracks().forEach((t) => t.stop());

      const blob = new Blob(audioChunks.current, { type: recorder.mimeType });
      if (blob.size < 500) {
        setStatus("idle");
        return;
      }

      // 1. Transcribe
      setStatus("transcribing");
      let transcript = "";
      try {
        const form = new FormData();
        form.append("file", blob, "audio.webm");
        const res = await fetch(`${API}/voice/transcribe`, { method: "POST", body: form });
        if (!res.ok) throw new Error(await res.text());
        ({ text: transcript } = await res.json());
        if (!transcript) { setStatus("idle"); return; }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Transcription failed");
        setStatus("error");
        return;
      }

      const userMsg: ChatMessage = { id: Date.now().toString(), role: "user", text: transcript };
      setMessages((prev) => [...prev, userMsg]);

      // 2. Agent
      setStatus("thinking");
      let answer = "";
      try {
        const res = await fetch(`${API}/agent/query`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ question: transcript, robot_name: robotName }),
        });
        if (!res.ok) throw new Error(await res.text());
        ({ answer } = await res.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Agent failed");
        setStatus("error");
        return;
      }

      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        text: answer,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // 3. Speak
      setStatus("speaking");
      try {
        const res = await fetch(`${API}/voice/speak`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: answer, voice_id: voiceId }),
        });
        if (!res.ok) throw new Error(await res.text());
        const audioBlob = await res.blob();
        const url = URL.createObjectURL(audioBlob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setStatus("idle");
        };
        await audio.play();
      } catch (e) {
        // TTS failed — still show transcript but don't block
        setError("Could not play audio response.");
        setStatus("idle");
      }
    };

    recorder.stop();
  }, [token, robotName, voiceId]);

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setStatus("idle");
  }, []);

  return { messages, status, error, startRecording, stopRecording, stopSpeaking };
}
