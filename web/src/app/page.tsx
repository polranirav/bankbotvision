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

    if (action.autoListen && micGranted && speechSupported) {
      speechTimeoutRef.current = setTimeout(() => {
        startListening();
      }, 450);
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

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = selectedRobot?.name === "ZED" ? 0.9 : 1.03;
    utterance.onend = () => finishAgentAction(action);
    utterance.onerror = () => finishAgentAction(action);
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

    await requestMicrophone();

    speakAgent(
      `Hello, welcome to BankBot Vision. I'm ${robot.name}. Let me see your face first, and then tell me how I can help you today.`,
    );
  }

  function handleSelectRobot(robot: RobotDef, index: number) {
    if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    void startDeskSession(robot, index);
  }

  function closeSession() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
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

  async function startListening() {
    if (typeof window === "undefined" || !("MediaRecorder" in window)) {
      setSpeechSupported(false);
      setSessionError("Voice recording is limited in this browser.");
      speakAgent("Hello, how can I help you today?", { autoListen: false });
      return;
    }

    if (!micGranted) {
      const granted = await requestMicrophone();
      if (!granted) {
        speakAgent(
          "Please allow microphone access, then I can hear you properly. Hello, how can I help you today?",
          { autoListen: false },
        );
        return;
      }
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });

      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        recorder.stream.getTracks().forEach((track) => track.stop());

        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
        mediaRecorderRef.current = null;

        if (blob.size < 500) {
          setSessionStage("ready");
          setSessionError("I couldn't hear that clearly. Please try again.");
          if (listenRetryRef.current < 1) {
            listenRetryRef.current += 1;
            speakAgent("Hello, I didn't catch that clearly. How can I help you today?", {
              autoListen: micGranted && speechSupported,
            });
          }
          return;
        }

        setSessionStage("processing");
        setSessionError("");

        try {
          const form = new FormData();
          form.append("file", blob, "audio.webm");
          const res = await fetch(`${API_URL}/voice/transcribe`, {
            method: "POST",
            body: form,
          });

          if (!res.ok) {
            throw new Error("I couldn't transcribe that clearly.");
          }

          const { text } = await res.json();
          const transcript = text?.trim();

          if (!transcript) {
            throw new Error("I couldn't transcribe that clearly.");
          }

          listenRetryRef.current = 0;
          const nextHistory = [
            ...messagesRef.current,
            {
              id: `visitor-${Date.now()}-${messagesRef.current.length}`,
              role: "visitor" as const,
              text: transcript,
            },
          ];
          messagesRef.current = nextHistory;
          setMessages(nextHistory);
          await processVisitorRequest(transcript);
        } catch (error) {
          setSessionStage("ready");
          setSessionError(error instanceof Error ? error.message : "I couldn't transcribe that clearly.");
          if (listenRetryRef.current < 1) {
            listenRetryRef.current += 1;
            speakAgent("Hello, I didn't catch that clearly. How can I help you today?", {
              autoListen: micGranted && speechSupported,
            });
          }
        }
      };

      mediaRecorderRef.current = recorder;
      setSessionStage("listening");
      setSessionError("");
      recorder.start(100);
    } catch (error) {
      setSessionStage("ready");
      setSessionError(error instanceof Error ? error.message : "Unable to start voice recording.");
      speakAgent("Hello, I couldn't start the microphone properly. How can I help you today?", {
        autoListen: false,
      });
    }
  }

  function stopListening() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.stop();
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

      <header className="absolute inset-x-0 top-[37px] z-30">
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
            <div className="pointer-events-none absolute inset-0 z-30 bg-[radial-gradient(circle_at_center,transparent_0%,transparent_42%,rgba(2,6,23,0.18)_100%)]" />

            <div className="absolute right-4 top-[96px] z-40 flex max-w-[340px] flex-col gap-3 sm:right-6">
              <div className="rounded-[26px] border border-white/10 bg-slate-950/46 px-4 py-4 text-white shadow-[0_20px_80px_rgba(2,6,23,0.38)] backdrop-blur-xl">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.32em] text-sky-200/75">Desk Session</p>
                    <p className="mt-2 text-lg font-semibold">{sessionTitle}</p>
                  </div>
                  <button
                    onClick={closeSession}
                    className="rounded-full border border-white/15 px-3 py-1.5 text-xs font-medium text-white/85 transition hover:bg-white/10"
                  >
                    Leave
                  </button>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <div className="rounded-full bg-white/10 px-3 py-2 text-sm">
                    {selectedRobot.name}
                  </div>
                  <div className="rounded-full bg-white/10 px-3 py-2 text-sm">
                    {cameraState === "matched"
                      ? "Recognised"
                      : cameraState === "new"
                        ? "First visit"
                        : cameraState === "matching"
                          ? "Scanning"
                          : cameraState === "error"
                            ? "Scan issue"
                            : "Checking face"}
                  </div>
                  <div className="rounded-full bg-white/10 px-3 py-2 text-sm">
                    {sessionStage === "listening"
                      ? "Listening"
                      : sessionStage === "processing"
                        ? "Responding"
                        : "Ready"}
                  </div>
                  {recognisedName && (
                    <div className="rounded-full bg-emerald-400/15 px-3 py-2 text-sm text-emerald-100">
                      {recognisedName}
                    </div>
                  )}
                </div>

                {(cameraState === "waiting" || cameraState === "matching") && (
                  <div className="mt-4">
                    <FaceCapture
                      onCapture={handleFaceCapture}
                      onError={handleFaceError}
                      matchOnly
                      minimal
                    />
                  </div>
                )}

                {sessionError && (
                  <div className="mt-4 rounded-2xl border border-amber-200/20 bg-amber-400/10 px-3 py-3 text-sm text-amber-100">
                    {sessionError}
                  </div>
                )}
              </div>
            </div>

            <div className="absolute inset-x-0 bottom-6 z-40 flex justify-center px-4">
              <div className="flex flex-wrap items-center justify-center gap-3 rounded-full border border-white/10 bg-slate-950/52 px-4 py-3 text-white shadow-[0_20px_80px_rgba(2,6,23,0.34)] backdrop-blur-xl">
                <button
                  onClick={sessionStage === "listening" ? stopListening : () => { void startListening(); }}
                  disabled={!speechSupported || sessionStage === "processing"}
                  className="rounded-full bg-white/10 px-5 py-2.5 text-sm font-semibold transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {sessionStage === "listening"
                    ? "Stop recording"
                    : sessionStage === "processing"
                      ? "Processing..."
                      : "Talk to agent"}
                </button>

                {!micGranted && (
                  <button
                    onClick={() => { void requestMicrophone(); }}
                    className="rounded-full border border-white/15 px-5 py-2.5 text-sm font-medium transition hover:bg-white/10"
                  >
                    Allow microphone
                  </button>
                )}

                {!speechSupported && (
                  <div className="rounded-full border border-white/15 px-4 py-2.5 text-sm text-white/80">
                    Voice recording is limited in this browser.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
