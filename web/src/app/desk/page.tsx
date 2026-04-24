"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { ROBOTS, type RobotDef } from "@/components/Robot";
import {
  BRANCH_INTENTS,
  getBranchIntent,
  type BranchIntent,
  type BranchIntentId,
} from "@/lib/branchDesk";

const RobotSingle = dynamic(
  () => import("@/components/RobotSingle").then((m) => m.RobotSingle),
  { ssr: false, loading: () => <div className="h-full w-full bg-slate-950" /> },
);

type DeskMessage = {
  id: string;
  role: "agent" | "customer";
  text: string;
  isAI?: boolean; // true = spoken via ElevenLabs, false/undefined = SpeechSynthesis
};

type ChatStatus = "idle" | "recording" | "transcribing" | "thinking" | "speaking";

function parseRobot(name: string | null) {
  return ROBOTS.find((robot) => robot.name === name?.toUpperCase()) ?? ROBOTS[0];
}

function buildIntroMessages(robot: RobotDef, intent?: BranchIntent): DeskMessage[] {
  const intro: DeskMessage[] = [
    {
      id: "agent-intro",
      role: "agent",
      text: robot.greeting,
    },
    {
      id: "agent-queue",
      role: "agent",
      text: "Please take a seat in front of my desk and tell me what brought you into the branch today.",
    },
  ];

  if (!intent) return intro;

  return [
    ...intro,
    {
      id: "customer-intent",
      role: "customer",
      text: intent.customerLine,
    },
    {
      id: "agent-intent",
      role: "agent",
      text: intent.agentReply,
    },
  ];
}

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

export default function DeskPage() {
  const router = useRouter();
  const [selectedRobot, setSelectedRobot] = useState<RobotDef>(ROBOTS[0]);
  const [selectedIntent, setSelectedIntent] = useState<BranchIntent | null>(null);
  const [messages, setMessages] = useState<DeskMessage[]>([]);
  const [speaking, setSpeaking] = useState(false);

  // AI chat state
  const [token, setToken] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ── Parse URL params ──────────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const robot = parseRobot(params.get("agent"));
    const intent = getBranchIntent(params.get("intent"));

    setSelectedRobot(robot);
    setSelectedIntent(intent ?? null);
    setMessages(buildIntroMessages(robot, intent));
  }, []);

  // ── Check auth session ────────────────────────────────────────────────────
  useEffect(() => {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    sb.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, []);

  // ── Speak scripted messages with browser SpeechSynthesis ──────────────────
  useEffect(() => {
    if (!messages.length || typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    // Only speak non-AI agent messages with SpeechSynthesis
    const lastAgentMessage = [...messages].reverse().find((m) => m.role === "agent" && !m.isAI);
    if (!lastAgentMessage) return;

    const utterance = new SpeechSynthesisUtterance(lastAgentMessage.text);
    utterance.rate = 1;
    utterance.pitch = selectedRobot.name === "ZED" ? 0.9 : 1.05;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);

    return () => {
      window.speechSynthesis.cancel();
      setSpeaking(false);
    };
  }, [messages, selectedRobot]);

  // ── Auto-scroll transcript ────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Desk status text ──────────────────────────────────────────────────────
  const deskStatus = useMemo(() => {
    if (chatStatus === "recording") return "Listening to you…";
    if (chatStatus === "transcribing") return "Transcribing your voice…";
    if (chatStatus === "thinking") return `${selectedRobot.name} is thinking…`;
    if (chatStatus === "speaking") return `${selectedRobot.name} is speaking…`;
    if (!selectedIntent) {
      return "Choose the reason for your visit so the desk agent can route you properly.";
    }
    return `${selectedRobot.name} is ready to help with ${selectedIntent.title.toLowerCase()}.`;
  }, [selectedIntent, selectedRobot, chatStatus]);

  // ── Play ElevenLabs TTS ───────────────────────────────────────────────────
  const playTTS = useCallback(async (text: string) => {
    setChatStatus("speaking");
    setSpeaking(true);

    try {
      const res = await fetch(`${API_URL}/voice/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice_id: selectedRobot.voiceId }),
      });

      if (!res.ok) throw new Error("TTS failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
        setChatStatus("idle");
        audioRef.current = null;
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
        setChatStatus("idle");
        audioRef.current = null;
      };

      await audio.play();
    } catch {
      // Fallback to browser SpeechSynthesis
      if ("speechSynthesis" in window) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1;
        utterance.pitch = selectedRobot.name === "ZED" ? 0.9 : 1.05;
        utterance.onend = () => { setSpeaking(false); setChatStatus("idle"); };
        utterance.onerror = () => { setSpeaking(false); setChatStatus("idle"); };
        window.speechSynthesis.speak(utterance);
      } else {
        setSpeaking(false);
        setChatStatus("idle");
      }
    }
  }, [selectedRobot]);

  // ── Send text message to AI agent ─────────────────────────────────────────
  const sendToAgent = useCallback(async (text: string) => {
    // Add user message
    setMessages((prev) => [
      ...prev,
      { id: `customer-${Date.now()}`, role: "customer", text },
    ]);

    // Call agent
    setChatStatus("thinking");

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      // Build conversation history from AI messages for multi-turn context
      const history = messages
        .filter((m) => m.isAI || m.role === "customer")
        .map((m) => ({
          role: m.role === "customer" ? "user" : "assistant",
          text: m.text,
        }));

      const res = await fetch(`${API_URL}/agent/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          question: text,
          robot_name: selectedRobot.name,
          history,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: "Something went wrong" }));
        throw new Error(body.detail ?? "Agent error");
      }

      const { answer } = await res.json();

      // Add AI response
      setMessages((prev) => [
        ...prev,
        { id: `agent-ai-${Date.now()}`, role: "agent", text: answer, isAI: true },
      ]);

      // Speak via ElevenLabs
      await playTTS(answer);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong";
      setMessages((prev) => [
        ...prev,
        { id: `agent-error-${Date.now()}`, role: "agent", text: `I'm sorry, I ran into an issue: ${msg}. Please try again.`, isAI: true },
      ]);
      setChatStatus("idle");
    }
  }, [token, selectedRobot, playTTS, messages]);

  // ── Handle text form submit ───────────────────────────────────────────────
  function handleSendText(e: React.FormEvent) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text || chatStatus !== "idle") return;
    setChatInput("");
    sendToAgent(text);
  }

  // ── Voice recording ───────────────────────────────────────────────────────
  async function handleStartRecording() {
    if (chatStatus !== "idle") return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(100);
      setChatStatus("recording");
    } catch {
      // Microphone denied — silently ignore
    }
  }

  function handleStopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    recorder.onstop = async () => {
      recorder.stream.getTracks().forEach((t) => t.stop());

      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
      if (blob.size < 500) {
        setChatStatus("idle");
        return;
      }

      // Transcribe
      setChatStatus("transcribing");
      try {
        const form = new FormData();
        form.append("file", blob, "audio.webm");
        const res = await fetch(`${API_URL}/voice/transcribe`, { method: "POST", body: form });
        if (!res.ok) throw new Error("Transcription failed");
        const { text } = await res.json();
        if (!text?.trim()) { setChatStatus("idle"); return; }

        // Send transcribed text to agent
        await sendToAgent(text.trim());
      } catch {
        setChatStatus("idle");
      }
    };

    recorder.stop();
  }

  // ── Stop current speech ───────────────────────────────────────────────────
  function stopSpeaking() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    setChatStatus("idle");
  }

  // ── Existing intent/greeting handlers ─────────────────────────────────────
  function chooseIntent(intentId: BranchIntentId) {
    const intent = getBranchIntent(intentId);
    if (!intent) return;

    setSelectedIntent(intent);
    setMessages((current) => {
      const filtered = current.filter((message) => !["customer-intent", "agent-intent"].includes(message.id));
      return [
        ...filtered,
        {
          id: "customer-intent",
          role: "customer",
          text: intent.customerLine,
        },
        {
          id: "agent-intent",
          role: "agent",
          text: intent.agentReply,
        },
      ];
    });
  }

  function repeatGreeting() {
    setMessages((current) => [
      ...current,
      {
        id: `agent-repeat-${Date.now()}`,
        role: "agent",
        text: selectedIntent?.agentReply ?? selectedRobot.greeting,
      },
    ]);
  }

  // ── Chat status visual config ─────────────────────────────────────────────
  const statusConfig: Record<ChatStatus, { color: string; pulse: boolean }> = {
    idle: { color: "text-slate-400", pulse: false },
    recording: { color: "text-red-400", pulse: true },
    transcribing: { color: "text-yellow-400", pulse: true },
    thinking: { color: "text-blue-400", pulse: true },
    speaking: { color: "text-emerald-400", pulse: true },
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#1d4ed8_0%,#0f172a_36%,#020617_100%)] text-white">
      <DisclaimerBanner />

      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5 sm:px-8">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.35em] text-sky-200/70">Branch Desk Session</p>
          <h1 className="text-2xl font-semibold tracking-tight">You are now sitting at {selectedRobot.name}&rsquo;s desk</h1>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => router.push("/")}
            className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-medium transition hover:bg-white/15"
          >
            Back to lobby
          </button>
          {speaking ? (
            <button
              onClick={stopSpeaking}
              className="rounded-full bg-red-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-400"
            >
              Stop speaking
            </button>
          ) : (
            <button
              onClick={repeatGreeting}
              className="rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-300"
            >
              Hear agent again
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-7xl gap-8 px-6 pb-10 pt-3 sm:px-8 lg:grid-cols-[0.88fr_1.12fr]">
        {/* ── Left: Robot camera view ── */}
        <section className="flex flex-col overflow-hidden rounded-[34px] border border-white/10 bg-slate-950/55 shadow-[0_30px_120px_rgba(2,6,23,0.7)]">
          <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
            <div>
              <p className="text-sm font-semibold text-white">Desk Camera View</p>
              <p className="text-xs text-slate-400">A seated agent is waiting in front of you.</p>
            </div>
            <div className={`rounded-full border px-3 py-1 text-xs font-medium ${
              chatStatus !== "idle"
                ? "border-sky-400/25 bg-sky-400/10 text-sky-100"
                : speaking
                  ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
                  : "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
            }`}>
              {chatStatus !== "idle"
                ? deskStatus
                : speaking ? "Agent speaking" : "Desk ready"}
            </div>
          </div>

          <div className="relative h-[540px] bg-[linear-gradient(180deg,rgba(15,23,42,0.45),rgba(2,6,23,0.95))]">
            <div className="absolute inset-x-0 top-0 z-10 flex justify-between px-5 pt-4 text-xs text-slate-400">
              <span>{selectedRobot.personality}</span>
              <span>{deskStatus}</span>
            </div>
            <RobotSingle robot={selectedRobot} speaking={speaking} />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950 via-slate-950/90 to-transparent px-6 pb-6 pt-16">
              <div className="rounded-3xl border border-white/10 bg-white/10 p-4 backdrop-blur">
                <p className="text-xs uppercase tracking-[0.28em] text-sky-200/70">What the visitor feels</p>
                <p className="mt-2 text-sm leading-7 text-slate-200">
                  You&rsquo;re sitting at {selectedRobot.name}&rsquo;s desk. Type or speak below to have a real conversation — the agent will respond with voice.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Right: Conversation + controls ── */}
        <section className="grid gap-6">
          {/* Intent selector */}
          <div className="rounded-[34px] border border-white/10 bg-white/8 p-6 shadow-[0_30px_80px_rgba(15,23,42,0.45)] backdrop-blur-xl">
            <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-5">
              <div>
                <p className="text-xs uppercase tracking-[0.32em] text-slate-400">Front Desk Conversation</p>
                <h2 className="mt-2 text-2xl font-semibold">Tell the desk agent why you came in today</h2>
              </div>
              <div className="rounded-3xl border border-white/10 bg-slate-950/40 px-4 py-3 text-right text-xs text-slate-300">
                <p>Agent</p>
                <p className="mt-1 text-lg font-semibold text-white">{selectedRobot.name}</p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {BRANCH_INTENTS.map((intent) => (
                <button
                  key={intent.id}
                  onClick={() => chooseIntent(intent.id)}
                  className={`rounded-3xl border p-4 text-left transition ${
                    selectedIntent?.id === intent.id
                      ? "border-sky-300/40 bg-sky-300/10"
                      : "border-white/10 bg-slate-950/30 hover:border-white/20 hover:bg-slate-950/55"
                  }`}
                >
                  <p className="text-sm font-semibold text-white">{intent.title}</p>
                  <p className="mt-1 text-sm leading-6 text-slate-400">{intent.summary}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Live transcript + chat input */}
          <div className="rounded-[34px] border border-white/10 bg-white/8 p-6 shadow-[0_30px_80px_rgba(15,23,42,0.45)] backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.32em] text-slate-400">Live Transcript</p>
                <h3 className="mt-2 text-xl font-semibold">Desk-side dialogue</h3>
              </div>
              {token ? (
                <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200">
                  Signed in — full banking access
                </span>
              ) : (
                <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1 text-xs text-amber-200">
                  General mode — sign in for account data
                </span>
              )}
            </div>

            {/* Messages */}
            <div className="mt-5 max-h-[360px] space-y-3 overflow-y-auto pr-1">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.role === "customer" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[88%] rounded-3xl px-4 py-3 text-sm leading-7 ${
                      message.role === "customer"
                        ? "bg-sky-500 text-slate-950"
                        : message.isAI
                          ? "bg-gradient-to-br from-slate-800 to-slate-900 text-slate-100 border border-sky-500/20"
                          : "bg-slate-950/55 text-slate-100"
                    }`}
                  >
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.24em] opacity-70">
                      {message.role === "customer" ? "You" : selectedRobot.name}
                      {message.isAI && <span className="ml-2 opacity-50">AI</span>}
                    </p>
                    {message.text}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Chat input area */}
            <div className="mt-5 border-t border-white/10 pt-5">
              {/* Status indicator */}
              {chatStatus !== "idle" && (
                <div className="mb-3 flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${statusConfig[chatStatus].pulse ? "animate-pulse" : ""} ${
                    chatStatus === "recording" ? "bg-red-400"
                    : chatStatus === "transcribing" ? "bg-yellow-400"
                    : chatStatus === "thinking" ? "bg-blue-400"
                    : "bg-emerald-400"
                  }`} />
                  <span className={`text-sm ${statusConfig[chatStatus].color}`}>
                    {deskStatus}
                  </span>
                </div>
              )}

              <form onSubmit={handleSendText} className="flex items-center gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={
                    chatStatus !== "idle"
                      ? "Wait for the agent to finish..."
                      : token
                        ? `Ask ${selectedRobot.name} about your account...`
                        : `Ask ${selectedRobot.name} a general question...`
                  }
                  disabled={chatStatus !== "idle"}
                  className="flex-1 rounded-2xl border border-white/15 bg-slate-950/50 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-sky-300/40 focus:outline-none disabled:opacity-50 transition"
                />

                {/* Mic button */}
                <button
                  type="button"
                  onPointerDown={handleStartRecording}
                  onPointerUp={handleStopRecording}
                  onPointerLeave={handleStopRecording}
                  disabled={chatStatus !== "idle" && chatStatus !== "recording"}
                  className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition ${
                    chatStatus === "recording"
                      ? "bg-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.3)] scale-110"
                      : "bg-white/10 hover:bg-white/15"
                  } disabled:opacity-40`}
                  title="Hold to record"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-white">
                    <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 16.93A8.001 8.001 0 0 1 4.07 11H6.1a5.92 5.92 0 0 0 11.8 0h2.03A8.001 8.001 0 0 1 13 17.93V20h3v2H8v-2h3v-2.07z" />
                  </svg>
                </button>

                {/* Send button */}
                <button
                  type="submit"
                  disabled={!chatInput.trim() || chatStatus !== "idle"}
                  className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-sky-400 text-slate-950 transition hover:bg-sky-300 disabled:opacity-40"
                  title="Send message"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              </form>

              {!token && (
                <p className="mt-3 text-xs text-slate-500">
                  💡 You can ask general banking questions now. Sign in for full account access.
                </p>
              )}
            </div>
          </div>

          {/* Next step CTA */}
          <div className="rounded-[34px] border border-white/10 bg-white/8 p-6 shadow-[0_30px_80px_rgba(15,23,42,0.45)] backdrop-blur-xl">
            <p className="text-xs uppercase tracking-[0.32em] text-slate-400">Next Step</p>
            {selectedIntent ? (
              <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-2xl font-semibold">{selectedIntent.title}</h3>
                    <p className="mt-2 text-sm leading-7 text-slate-300">{selectedIntent.agentReply}</p>
                  </div>

                  <div className="grid gap-2">
                    {selectedIntent.checklist.map((item) => (
                      <div key={item} className="rounded-2xl border border-white/10 bg-slate-950/30 px-4 py-3 text-sm text-slate-200">
                        {item}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid gap-3 lg:min-w-[240px]">
                  <button
                    onClick={() => router.push(selectedIntent.primaryHref(selectedRobot.name))}
                    className="rounded-2xl bg-sky-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-300"
                  >
                    {selectedIntent.primaryCta}
                  </button>
                  <button
                    onClick={() => router.push(selectedIntent.secondaryHref(selectedRobot.name))}
                    className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm transition hover:bg-white/10"
                  >
                    {selectedIntent.secondaryCta}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-3xl border border-dashed border-white/15 bg-slate-950/25 p-5 text-sm leading-7 text-slate-300">
                Pick a visit reason above and the desk agent will immediately respond with the right branch-style guidance and secure next step.
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
