"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { FaceCapture, type CaptureResult } from "@/components/FaceCapture";
import { ROBOTS, type RobotDef } from "@/components/Robot";

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

const RobotScene = dynamic(
  () => import("@/components/RobotScene").then((m) => m.RobotScene),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-white/70">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white/80" />
        Loading lobby...
      </div>
    ),
  },
);

type SessionStage =
  | "idle"
  | "permissions"
  | "identifying"
  | "ready"
  | "listening"
  | "processing";

type CameraState = "waiting" | "matching" | "matched" | "new" | "error";
type IdentityState = "unknown" | "confirming" | "confirmed" | "guest";

type ChatMessage = {
  id: string;
  role: "agent" | "visitor";
  text: string;
};

type AgentAction = {
  autoListen?: boolean;
  routePush?: string;
  magicLink?: string | null;
};

type FrontDeskReply = {
  summary: string;
  reply: string;
  intent: "open-account" | "documents" | "account-help" | "general" | "clarify";
  should_route: boolean;
  route_target: "none" | "signup" | "login" | "magic_link";
  confidence: number;
};

export default function Home() {
  const router = useRouter();
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const speechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenRetryRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  const vadAudioCtxRef = useRef<AudioContext | null>(null);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoListenEnabledRef = useRef(false);
  const [vadLevel, setVadLevel] = useState(0); // 0–100, for waveform indicator

  const [authFirstName, setAuthFirstName] = useState<string | null>(null);
  const [selectedRobot, setSelectedRobot] = useState<RobotDef | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessionStage, setSessionStage] = useState<SessionStage>("idle");
  const [cameraState, setCameraState] = useState<CameraState>("waiting");
  const [micGranted, setMicGranted] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [recognisedName, setRecognisedName] = useState<string | null>(null);
  const [identityState, setIdentityState] = useState<IdentityState>("unknown");
  const [pendingMagicLink, setPendingMagicLink] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionError, setSessionError] = useState("");
  const [lobbyStatus, setLobbyStatus] = useState(
    "Click an available desk and the agent will greet you.",
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    setSpeechSupported(typeof window !== "undefined" && "MediaRecorder" in window);
  }, []);

  // Pre-load speech synthesis voices so first speak() call isn't silent
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => window.speechSynthesis.getVoices();
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, []);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
    };
  }, []);

  // ── Auth session ─────────────────────────────────────────────────────────
  useEffect(() => {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    sb.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      // Pull first name from accounts table
      const res = await sb
        .from("accounts")
        .select("first_name")
        .eq("user_id", data.session.user.id)
        .maybeSingle();
      setAuthFirstName(res.data?.first_name ?? data.session.user.email?.split("@")[0] ?? "Account");
    });
    const { data: listener } = sb.auth.onAuthStateChange((_event, session) => {
      if (!session) setAuthFirstName(null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const deskStates = useMemo(
    () =>
      ROBOTS.map((robot) => ({
        robot,
        label: "Open",
      })),
    [],
  );

  function pushMessage(role: ChatMessage["role"], text: string) {
    setMessages((current) => [
      ...current,
      { id: `${role}-${Date.now()}-${current.length}`, role, text },
    ]);
  }

  function finishAgentAction(action?: AgentAction) {
    if (!action) return;

    if (action.autoListen) {
      // Always auto-listen after robot speaks — VAD handles stop automatically
      speechTimeoutRef.current = setTimeout(() => {
        void startVADListen();
      }, 500);
      return;
    }

    const target = action.magicLink ?? action.routePush;
    if (target) {
      speechTimeoutRef.current = setTimeout(() => {
        if (action.magicLink) {
          window.location.href = action.magicLink;
        } else if (action.routePush) {
          router.push(action.routePush);
        }
      }, 900);
    }
  }

  function speakAgent(text: string, action?: AgentAction) {
    pushMessage("agent", text);

    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      finishAgentAction(action);
      return;
    }

    window.speechSynthesis.cancel();
    if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = selectedRobot?.name === "ZED" ? 0.9 : 1.03;

    // Safety net: always fire finishAgentAction even if onend never fires
    // (Chrome sometimes silently drops speech when user-gesture chain is broken)
    const estimatedMs = Math.max(2500, text.length * 65);
    let fired = false;
    const done = () => {
      if (fired) return;
      fired = true;
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      finishAgentAction(action);
    };

    utterance.onend = done;
    utterance.onerror = done;
    speechTimeoutRef.current = setTimeout(done, estimatedMs);

    // Chrome macOS bug: speech synthesis pauses if not nudged
    const resumeInterval = setInterval(() => {
      if (!window.speechSynthesis.speaking) { clearInterval(resumeInterval); return; }
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }, 5000);
    utterance.onend = () => { clearInterval(resumeInterval); done(); };
    utterance.onerror = () => { clearInterval(resumeInterval); done(); };

    window.speechSynthesis.speak(utterance);
  }

  async function requestMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicGranted(true);
      setSessionError("");
      return true;
    } catch {
      setMicGranted(false);
      setSessionError("Please allow microphone access to talk with the agent.");
      return false;
    }
  }

  async function startDeskSession(robot: RobotDef, index: number) {
    setSelectedRobot(robot);
    setFocusIndex(index);
    setSessionOpen(true);
    setSessionStage("permissions");
    setCameraState("waiting");
    setRecognisedName(null);
    setIdentityState("unknown");
    setPendingMagicLink(null);
    setMessages([]);
    setSessionError("");
    setLobbyStatus(`${robot.name} is greeting you at Desk ${index + 1}.`);

    autoListenEnabledRef.current = true;

    // Speak FIRST — must happen synchronously within the click gesture.
    speakAgent(
      `Hello! Welcome to BankBot Vision. I'm ${robot.name}. Let me scan your face, then tell me how I can help you today.`,
      { autoListen: true },
    );

    // Request mic after — safe because speech already unlocked above.
    await requestMicrophone();
  }

  function handleSelectRobot(robot: RobotDef, index: number) {
    if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    void startDeskSession(robot, index);
  }

  function closeSession() {
    autoListenEnabledRef.current = false;
    stopVAD();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);

    setSessionOpen(false);
    setSelectedRobot(null);
    setFocusIndex(null);
    setSessionStage("idle");
    setCameraState("waiting");
    setRecognisedName(null);
    setPendingMagicLink(null);
    setMessages([]);
    setSessionError("");
    setLobbyStatus("Click an available desk and the agent will greet you.");
  }

  async function handleFaceCapture(result: CaptureResult) {
    if (!selectedRobot) return;
    // If we've already matched or errored, stop processing new frames
    if (cameraState === "matched" || cameraState === "error" || cameraState === "new") return;

    const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

    try {
      const res = await fetch(`${apiUrl}/face/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_data_url: result.imageDataUrl }),
      });

      if (!res.ok) {
        throw new Error("Detection failed");
      }

      const data = await res.json();
      
      if (!data.detected) {
        // No face found in this frame — keep waiting/polling
        return;
      }

      // Face detected — stop polling by changing state
      setCameraState("matching");
      setSessionStage("identifying");

      if (!data.matched) {
        setCameraState("new");
        setSessionStage("ready");
        setIdentityState("guest");
        speakAgent(
          "Hello and welcome. I do not see an existing account yet. Tell me your first name and how I can help you today. I can help with opening an account, documents, or general banking questions.",
          { autoListen: true },
        );
        return;
      }

      setRecognisedName(data.first_name);
      setIdentityState("confirming");
      setPendingMagicLink(data.magic_link);
      setCameraState("matched");
      setSessionStage("ready");
      speakAgent(
        `Hello. I think I recognised you as ${data.first_name}. Please tell me your first name so I can confirm, then I can help with balances, cards, documents, or account opening.`,
        { autoListen: true },
      );
    } catch (error) {
      setCameraState("error");
      setSessionStage("ready");
      setIdentityState("guest");
      setSessionError(error instanceof Error ? error.message : "Face recognition is unavailable right now.");
      speakAgent(
        "Hello, welcome. I couldn't complete recognition, but we can still continue. Tell me your first name and how I can help you today.",
        { autoListen: true },
      );
    }
  }

  function handleFaceError(message: string) {
    setCameraState("error");
    setSessionStage("ready");
    setIdentityState("guest");
    setSessionError(message);
    speakAgent(
      "Hello, welcome. Face recognition is having trouble right now, but I can still help you. Tell me your first name and how I can help today.",
      { autoListen: true },
    );
  }

  async function processVisitorRequest(text: string) {
    if (!selectedRobot) return;

    const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";
    const encodedAgent = encodeURIComponent(selectedRobot.name);
    const lowerText = text.toLowerCase();

    if (identityState === "confirming" && recognisedName) {
      const recognisedLower = recognisedName.toLowerCase();
      const mentionsRecognisedName = lowerText.includes(recognisedLower);
      const providedAnyName =
        /\bmy name is\b/.test(lowerText) ||
        /\bi am\b/.test(lowerText) ||
        /\bit's\b/.test(lowerText) ||
        text.trim().split(/\s+/).length <= 3;

      if (mentionsRecognisedName) {
        setIdentityState("confirmed");
        setSessionStage("ready");
        speakAgent(
          `Thank you, ${recognisedName}. How can I help you today? I can help with balances, cards, documents, or opening an account.`,
          { autoListen: micGranted && speechSupported },
        );
        return;
      }

      if (providedAnyName) {
        setIdentityState("confirmed");
        setSessionStage("ready");
        speakAgent(
          `Thank you. I may confirm the profile securely again in a moment. How can I help you today? I can help with balances, cards, documents, or opening an account.`,
          { autoListen: micGranted && speechSupported },
        );
        return;
      }
    }

    try {
      const res = await fetch(`${apiUrl}/agent/frontdesk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterance: text,
          robot_name: selectedRobot.name,
          recognised_name: recognisedName,
          has_face_match: cameraState === "matched",
          has_magic_link: Boolean(pendingMagicLink),
          history: messagesRef.current
            .slice(-8)
            .map((message) => ({ role: message.role, text: message.text })),
        }),
      });

      if (!res.ok) {
        throw new Error("The desk agent could not process that request.");
      }

      const decision: FrontDeskReply = await res.json();
      setSessionStage("ready");
      if (identityState !== "confirmed") {
        setIdentityState(cameraState === "matched" ? "confirmed" : identityState);
      }

      const action: AgentAction = {};
      if (decision.should_route) {
        if (decision.route_target === "signup") {
          action.routePush = `/signup?agent=${encodedAgent}`;
        } else if (decision.route_target === "login") {
          action.routePush = `/login?agent=${encodedAgent}&mode=choose`;
        } else if (decision.route_target === "magic_link" && pendingMagicLink) {
          action.magicLink = pendingMagicLink;
        } else {
          action.autoListen = micGranted && speechSupported;
        }
      } else {
        action.autoListen = micGranted && speechSupported;
      }

      speakAgent(decision.reply, action);
    } catch (error) {
      setSessionStage("ready");
      setSessionError(error instanceof Error ? error.message : "I couldn't process that request clearly.");
      speakAgent(
        "I am still with you. Tell me the main thing you need help with today, and I will take it step by step.",
        { autoListen: micGranted && speechSupported },
      );
    }
  }

  // ── VAD auto-listen — no button required ─────────────────────────────────
  function stopVAD() {
    if (vadIntervalRef.current) { clearInterval(vadIntervalRef.current); vadIntervalRef.current = null; }
    if (vadAudioCtxRef.current) { vadAudioCtxRef.current.close().catch(() => {}); vadAudioCtxRef.current = null; }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setVadLevel(0);
  }

  async function startVADListen() {
    if (!autoListenEnabledRef.current) return;
    if (mediaRecorderRef.current?.state === "recording") return;
    if (typeof window === "undefined" || !("MediaRecorder" in window)) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!autoListenEnabledRef.current) { stream.getTracks().forEach(t => t.stop()); return; }

      // Web Audio for VAD
      const audioCtx = new AudioContext();
      vadAudioCtxRef.current = audioCtx;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      // Calibrate ambient noise over 400 ms
      await new Promise(r => setTimeout(r, 400));
      if (!autoListenEnabledRef.current) { stream.getTracks().forEach(t => t.stop()); audioCtx.close(); return; }
      analyser.getByteFrequencyData(dataArray);
      const ambient = dataArray.slice(0, 32).reduce((a, b) => a + b, 0) / 32;
      const SPEECH_THRESH = Math.max(14, ambient * 2.8);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };

      let hasSpeech = false;
      let silenceStart = Date.now();
      const recordStart = Date.now();

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (vadAudioCtxRef.current === audioCtx) { audioCtx.close(); vadAudioCtxRef.current = null; }
        mediaRecorderRef.current = null;
        setVadLevel(0);

        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        // Too short or no real speech — restart listener
        if (!hasSpeech || blob.size < 800) {
          if (autoListenEnabledRef.current) setTimeout(() => startVADListen(), 400);
          return;
        }

        setSessionStage("processing");
        setSessionError("");
        try {
          const form = new FormData();
          form.append("file", blob, "audio.webm");
          const res = await fetch(`${API_URL}/voice/transcribe`, { method: "POST", body: form });
          if (!res.ok) throw new Error("Transcription failed");
          const { text } = await res.json();
          const transcript = text?.trim();
          if (!transcript) throw new Error("Empty transcript");

          listenRetryRef.current = 0;
          const next = [
            ...messagesRef.current,
            { id: `v-${Date.now()}`, role: "visitor" as const, text: transcript },
          ];
          messagesRef.current = next;
          setMessages(next);
          await processVisitorRequest(transcript);
        } catch {
          setSessionStage("ready");
          if (autoListenEnabledRef.current) setTimeout(() => startVADListen(), 800);
        }
      };

      mediaRecorderRef.current = recorder;
      setSessionStage("listening");
      setSessionError("");
      recorder.start(100);

      // VAD loop — check level every 80 ms
      vadIntervalRef.current = setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        const level = Math.round(
          (dataArray.slice(0, 48).reduce((a, b) => a + b, 0) / 48 / 255) * 100
        );
        setVadLevel(level);

        const speaking = level * 2.55 > SPEECH_THRESH;
        if (speaking) {
          hasSpeech = true;
          silenceStart = Date.now();
        }

        const silenceDuration = Date.now() - silenceStart;
        const elapsed = Date.now() - recordStart;

        // Stop conditions: silence after speech (1.4s) OR no speech in 9s
        if (hasSpeech && silenceDuration > 1400) {
          if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
          if (recorder.state === "recording") recorder.stop();
        } else if (!hasSpeech && elapsed > 9000) {
          if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
          if (recorder.state === "recording") recorder.stop();
        }
      }, 80);

    } catch {
      setSessionStage("ready");
      if (autoListenEnabledRef.current) setTimeout(() => startVADListen(), 1500);
    }
  }

  const sessionTitle = useMemo(() => {
    if (!selectedRobot) return "Approach a desk";
    if (cameraState === "matched" && recognisedName) return `Hello, ${recognisedName}`;
    if (cameraState === "new") return "First-time visitor";
    if (sessionStage === "listening") return `${selectedRobot.name} is listening`;
    if (sessionStage === "processing") return `${selectedRobot.name} is responding`;
    return `${selectedRobot.name} at your desk`;
  }, [cameraState, recognisedName, selectedRobot, sessionStage]);

  return (
    <div className="min-h-screen bg-[#eaf1f7] text-slate-950">
      <DisclaimerBanner />

      <header className="absolute inset-x-0 top-[37px] z-50">
        <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          {/* Logo */}
          <div className="flex items-center gap-3 rounded-full border border-white/15 bg-slate-950/35 px-4 py-2 text-white backdrop-blur">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-sky-500 text-lg">
              🏦
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.34em] text-sky-200/80">Virtual Branch</p>
              <p className="text-sm font-semibold tracking-tight">BankBot Vision</p>
            </div>
          </div>

          {/* Auth nav */}
          <div className="flex items-center gap-2">
            {authFirstName ? (
              <>
                <button
                  onClick={() => router.push("/account")}
                  className="flex items-center gap-2 rounded-full border border-white/15 bg-slate-950/35 px-4 py-2 text-sm font-medium text-white backdrop-blur transition hover:bg-white/10"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-500 text-xs font-bold">
                    {authFirstName[0].toUpperCase()}
                  </span>
                  {authFirstName}
                </button>
                <button
                  onClick={async () => {
                    const sb = createBrowserClient(
                      process.env.NEXT_PUBLIC_SUPABASE_URL!,
                      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                    );
                    await sb.auth.signOut();
                    setAuthFirstName(null);
                  }}
                  className="rounded-full border border-white/15 bg-slate-950/35 px-4 py-2 text-sm text-white/70 backdrop-blur transition hover:bg-white/10 hover:text-white"
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => router.push("/signup")}
                  className="rounded-full border border-white/15 bg-slate-950/35 px-4 py-2 text-sm font-medium text-white backdrop-blur transition hover:bg-white/10"
                >
                  Create account
                </button>
                <button
                  onClick={() => router.push("/login")}
                  className="rounded-full bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-400"
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="relative h-[calc(100vh-37px)] min-h-[760px] overflow-hidden bg-[radial-gradient(circle_at_top,#1e3a8a_0%,#0f172a_38%,#020617_100%)]">
        <div className="absolute inset-0">
          <RobotScene
            onSelectRobot={handleSelectRobot}
            focusIndex={focusIndex}
            speakingIndex={
              sessionStage === "listening" || sessionStage === "processing" ? focusIndex : null
            }
          />
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-slate-950/75 via-slate-950/35 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-slate-950 via-slate-950/65 to-transparent" />

        {/* ── Desk name plates on the counter ── */}
        <div
          className={[
            "pointer-events-none absolute inset-x-0 z-10 flex justify-around px-[8%] transition-opacity duration-500",
            focusIndex === null ? "opacity-100" : "opacity-0",
          ].join(" ")}
          style={{ bottom: "29%" }}
        >
          {ROBOTS.map((robot) => (
            <div key={robot.name} className="flex flex-col items-center gap-1">
              {/* Name plate */}
              <div
                className="rounded-lg border px-5 py-1.5 backdrop-blur-sm"
                style={{
                  borderColor: `${robot.color}55`,
                  backgroundColor: `${robot.color}18`,
                }}
              >
                <p
                  className="text-xs font-bold uppercase tracking-[0.28em]"
                  style={{ color: robot.color }}
                >
                  {robot.name}
                </p>
              </div>
              {/* Personality subtitle */}
              <p className="text-[10px] tracking-wide text-white/40">{robot.personality}</p>
            </div>
          ))}
        </div>

        {!sessionOpen && (
          <div className="pointer-events-none absolute inset-x-0 bottom-8 z-20 mx-auto w-full max-w-[1100px] px-4">
            <div className="mx-auto max-w-xl rounded-[28px] border border-white/10 bg-slate-950/38 px-5 py-4 text-center text-white backdrop-blur-xl">
              <p className="text-xs uppercase tracking-[0.34em] text-sky-200/75">Lobby Floor</p>
              <p className="mt-3 text-base leading-8 text-slate-100">
                {lobbyStatus}
              </p>
            </div>
          </div>
        )}

        {sessionOpen && selectedRobot && (
          <>
            {/* Invisible face scanner */}
            {(cameraState === "waiting" || cameraState === "matching") && (
              <div className="pointer-events-none absolute opacity-0">
                <FaceCapture
                  onCapture={handleFaceCapture}
                  onError={handleFaceError}
                  matchOnly
                  minimal
                />
              </div>
            )}

            {/* Top-left: robot identity chip */}
            <div className="absolute left-4 top-[80px] z-40 flex items-center gap-2 sm:left-6">
              <div
                className="flex items-center gap-2 rounded-full border border-white/15 bg-slate-950/55 px-3 py-1.5 text-white backdrop-blur-xl"
                style={{ borderColor: `${selectedRobot.color}40` }}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: selectedRobot.color }} />
                <span className="text-xs font-semibold tracking-wide">{selectedRobot.name}</span>
                {recognisedName && (
                  <span className="text-xs text-emerald-300">· {recognisedName}</span>
                )}
              </div>
              <button
                onClick={closeSession}
                className="rounded-full border border-white/15 bg-slate-950/55 px-3 py-1.5 text-xs text-white/70 backdrop-blur-xl transition hover:bg-white/10"
              >
                Leave
              </button>
            </div>

            {/* Bottom overlay: transcript + listening indicator */}
            <div className="absolute inset-x-0 bottom-0 z-40 flex flex-col items-center gap-3 pb-8 pt-4">

              {/* Last few messages */}
              {messages.length > 0 && (
                <div className="w-full max-w-lg space-y-1.5 px-4">
                  {messages.slice(-3).map((msg) => (
                    <div
                      key={msg.id}
                      className={[
                        "rounded-2xl px-4 py-2 text-sm leading-relaxed backdrop-blur-xl",
                        msg.role === "agent"
                          ? "ml-4 border border-white/10 bg-slate-950/55 text-white/90"
                          : "mr-4 border border-sky-400/20 bg-sky-950/50 text-sky-100",
                      ].join(" ")}
                    >
                      {msg.text}
                    </div>
                  ))}
                </div>
              )}

              {/* VAD indicator */}
              <div className="flex items-center gap-3 rounded-full border border-white/10 bg-slate-950/60 px-5 py-2.5 backdrop-blur-xl">
                {sessionStage === "listening" ? (
                  <>
                    {/* Live audio bars */}
                    <div className="flex items-end gap-[3px]" style={{ height: 18 }}>
                      {[0.4, 0.7, 1, 0.6, 0.85, 0.5, 0.9].map((base, i) => (
                        <div
                          key={i}
                          className="w-[3px] rounded-full bg-sky-400 transition-all duration-75"
                          style={{
                            height: `${Math.max(3, Math.min(18, (vadLevel * base * 0.18) + 3))}px`,
                            opacity: 0.6 + base * 0.4,
                          }}
                        />
                      ))}
                    </div>
                    <span className="text-xs font-medium text-sky-300">Listening…</span>
                  </>
                ) : sessionStage === "processing" ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white/80" />
                    <span className="text-xs font-medium text-white/70">Thinking…</span>
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 animate-pulse rounded-full bg-white/30" />
                    <span className="text-xs text-white/40">
                      {cameraState === "waiting" || cameraState === "matching"
                        ? "Scanning face…"
                        : "Ready"}
                    </span>
                  </>
                )}
              </div>

            </div>
          </>
        )}
      </main>
    </div>
  );
}
