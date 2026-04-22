"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { createBrowserClient } from "@supabase/ssr";
import { ROBOTS, type RobotDef } from "@/components/Robot";
import { useVoiceChat, type VoiceStatus } from "@/hooks/useVoiceChat";

// Keep Three.js out of SSR
const RobotSingle = dynamic(
  () => import("@/components/RobotSingle").then((m) => m.RobotSingle),
  { ssr: false, loading: () => <div className="w-full h-full bg-slate-900" /> },
);

// ── Status label ─────────────────────────────────────────────────────────────
const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle:         "Hold to speak",
  recording:    "Listening…",
  transcribing: "Transcribing…",
  thinking:     "Thinking…",
  speaking:     "Speaking…",
  error:        "Error",
};

const STATUS_COLOR: Record<VoiceStatus, string> = {
  idle:         "text-slate-400",
  recording:    "text-red-400",
  transcribing: "text-yellow-400",
  thinking:     "text-blue-400",
  speaking:     "text-green-400",
  error:        "text-red-500",
};

// ── Mic button pulse ring ─────────────────────────────────────────────────────
function MicButton({
  status,
  onPointerDown,
  onPointerUp,
}: {
  status: VoiceStatus;
  onPointerDown: () => void;
  onPointerUp: () => void;
}) {
  const isRecording = status === "recording";
  const isBusy = ["transcribing", "thinking", "speaking"].includes(status);

  return (
    <button
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}   // release if finger/cursor leaves button
      disabled={isBusy}
      className={[
        "relative w-20 h-20 rounded-full flex items-center justify-center",
        "transition-transform select-none touch-none",
        isBusy
          ? "opacity-40 cursor-not-allowed bg-slate-700"
          : isRecording
            ? "scale-110 bg-red-600 shadow-[0_0_0_8px_rgba(239,68,68,0.3)]"
            : "bg-blue-600 hover:bg-blue-500 active:scale-95",
      ].join(" ")}
      aria-label="Hold to speak"
    >
      {/* pulse ring while recording */}
      {isRecording && (
        <span className="absolute inset-0 rounded-full animate-ping bg-red-500 opacity-40" />
      )}
      {/* mic icon */}
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-white relative z-10">
        <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 16.93A8.001 8.001 0 0 1 4.07 11H6.1a5.92 5.92 0 0 0 11.8 0h2.03A8.001 8.001 0 0 1 13 17.93V20h3v2H8v-2h3v-2.07z" />
      </svg>
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ChatPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [selectedRobot, setSelectedRobot] = useState<RobotDef>(ROBOTS[0]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch Supabase session token
  useEffect(() => {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    sb.auth.getSession().then(({ data }) => {
      const t = data.session?.access_token ?? null;
      if (!t) { router.replace("/login"); return; }
      setToken(t);
    });
  }, [router]);

  const { messages, status, error, startRecording, stopRecording, stopSpeaking } =
    useVoiceChat(token, selectedRobot.name, selectedRobot.voiceId);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const isSpeaking = status === "speaking";

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 text-white flex flex-col">

      {/* ── Header ── */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <button
          onClick={() => router.push("/account")}
          className="text-slate-400 hover:text-white text-sm transition flex items-center gap-1"
        >
          ← Back
        </button>
        <span className="font-bold tracking-tight">BankBot Voice</span>
        <div className="w-16" /> {/* spacer */}
      </header>

      {/* ── Robot selector ── */}
      <div className="flex justify-center gap-3 pt-4 px-4">
        {ROBOTS.map((r) => (
          <button
            key={r.name}
            onClick={() => setSelectedRobot(r)}
            className={[
              "px-4 py-2 rounded-full text-sm font-semibold transition border",
              selectedRobot.name === r.name
                ? "border-white bg-white/10 text-white"
                : "border-slate-700 text-slate-400 hover:border-slate-500",
            ].join(" ")}
            style={selectedRobot.name === r.name ? { borderColor: r.color } : {}}
          >
            {r.name}
          </button>
        ))}
      </div>

      {/* ── 3D Robot ── */}
      <div className="flex-shrink-0 w-full h-56 relative">
        <RobotSingle robot={selectedRobot} speaking={isSpeaking} />
      </div>

      {/* ── Transcript ── */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3 max-w-xl mx-auto w-full">
        {messages.length === 0 && (
          <p className="text-center text-slate-500 text-sm mt-8">
            Hold the button below and ask anything about your account.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={[
                "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                m.role === "user"
                  ? "bg-blue-600 text-white rounded-br-sm"
                  : "bg-slate-800 text-slate-100 rounded-bl-sm",
              ].join(" ")}
            >
              {m.role === "assistant" && (
                <span
                  className="text-xs font-semibold mr-2 opacity-60"
                  style={{ color: selectedRobot.color }}
                >
                  {selectedRobot.name}
                </span>
              )}
              {m.text}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* ── Controls ── */}
      <div className="flex flex-col items-center gap-3 py-6 border-t border-slate-800 bg-slate-950/60 backdrop-blur-sm">
        {/* Status */}
        <p className={`text-sm font-medium ${STATUS_COLOR[status]}`}>
          {STATUS_LABEL[status]}
        </p>

        {error && status === "error" && (
          <p className="text-xs text-red-400 max-w-xs text-center">{error}</p>
        )}

        {/* Mic button or stop-speaking button */}
        {isSpeaking ? (
          <button
            onClick={stopSpeaking}
            className="w-20 h-20 rounded-full bg-slate-700 hover:bg-slate-600 flex items-center justify-center transition"
            aria-label="Stop speaking"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-white">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <MicButton
            status={status}
            onPointerDown={startRecording}
            onPointerUp={stopRecording}
          />
        )}

        <p className="text-xs text-slate-600">
          {isSpeaking ? "Tap to stop" : "Hold • Release to send"}
        </p>
      </div>
    </div>
  );
}
