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
  risk_level?: "low" | "medium" | "high";
  escalate?: boolean;
  clarification_count?: number;
  intent_module?: string;
  pin_verified?: boolean;
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
  // Generation counter — prevents cancelled utterances from firing finishAgentAction
  const speechGenRef = useRef(0);
  // True while TTS is actively playing — prevents VAD from starting mid-speech
  const isSpeakingRef = useRef(false);
  const [vadLevel, setVadLevel] = useState(0); // 0–100, for waveform indicator

  // ── Auth state refs — always current even inside stale VAD closures ──────────
  const identityStateRef = useRef<IdentityState>("unknown");
  const cameraStateRef   = useRef<CameraState>("waiting");
  const pinVerifiedRef   = useRef(false);
  const userIdRef        = useRef<string | null>(null);
  const recognisedNameRef= useRef<string | null>(null);
  const pendingQueryRef  = useRef<string | null>(null);
  const pendingMagicLinkRef = useRef<string | null>(null);

  const [authFirstName, setAuthFirstName] = useState<string | null>(null);
  const [selectedRobot, setSelectedRobot] = useState<RobotDef | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessionStage, setSessionStage] = useState<SessionStage>("idle");
  const [isRobotSpeaking, setIsRobotSpeaking] = useState(false);
  const [cameraState, setCameraState] = useState<CameraState>("waiting");
  const [micGranted, setMicGranted] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [recognisedName, setRecognisedName] = useState<string | null>(null);
  const [identityState, setIdentityState] = useState<IdentityState>("unknown");
  const [userId, setUserId] = useState<string | null>(null);
  const [pinVerified, setPinVerified] = useState(false);
  const [pendingQuery, setPendingQuery] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<{ said: string; understood: string; reply: string } | null>(null);
  const [pendingMagicLink, setPendingMagicLink] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionError, setSessionError] = useState("");
  // Session state echoed back to backend each turn
  const [clarificationCount, setClarificationCount] = useState(0);
  const [lobbyStatus, setLobbyStatus] = useState(
    "Click an available desk and the agent will greet you.",
  );

  useEffect(() => { messagesRef.current       = messages;       }, [messages]);
  useEffect(() => { identityStateRef.current  = identityState;  }, [identityState]);
  useEffect(() => { cameraStateRef.current    = cameraState;    }, [cameraState]);
  useEffect(() => { pinVerifiedRef.current    = pinVerified;    }, [pinVerified]);
  useEffect(() => { userIdRef.current         = userId;         }, [userId]);
  useEffect(() => { recognisedNameRef.current = recognisedName; }, [recognisedName]);
  useEffect(() => { pendingQueryRef.current   = pendingQuery;   }, [pendingQuery]);
  useEffect(() => { pendingMagicLinkRef.current = pendingMagicLink; }, [pendingMagicLink]);

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

  function pushMessage(role: ChatMessage["role"], text: string) {
    setMessages((current) => [
      ...current,
      { id: `${role}-${Date.now()}-${current.length}`, role, text },
    ]);
  }

  function finishAgentAction(action?: AgentAction) {
    if (!action) return;

    if (action.autoListen) {
      // Wait 600 ms after TTS ends before listening
      speechTimeoutRef.current = setTimeout(() => {
        void startVADListen();
      }, 600);
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

    // Cancel any in-flight speech — the old utterance's onerror will fire with
    // error="canceled" and we guard against it below so it won't trigger VAD.
    window.speechSynthesis.cancel();
    if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);

    // Bump generation — any done() closure from a previous speakAgent call
    // will see a stale generation and bail out immediately.
    const gen = ++speechGenRef.current;
    isSpeakingRef.current = true;
    setIsRobotSpeaking(true);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = selectedRobot?.name === "ZED" ? 0.9 : 1.03;

    // Safety timeout: fire done() even if onend never fires.
    const estimatedMs = Math.max(2500, text.length * 65);

    const done = () => {
      // Stale if a newer speakAgent call has started
      if (speechGenRef.current !== gen) return;
      isSpeakingRef.current = false;
      setIsRobotSpeaking(false);
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      finishAgentAction(action);
    };

    // Chrome macOS bug: speech synthesis can pause if not nudged every few seconds
    const resumeInterval = setInterval(() => {
      if (!window.speechSynthesis.speaking || speechGenRef.current !== gen) {
        clearInterval(resumeInterval);
        return;
      }
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }, 5000);

    utterance.onend = () => { clearInterval(resumeInterval); done(); };
    utterance.onerror = (e) => {
      clearInterval(resumeInterval);
      // "canceled" means we called cancel() intentionally — do NOT fire done()
      // because a newer speakAgent call is already in progress.
      if ((e as SpeechSynthesisErrorEvent).error === "canceled") return;
      done();
    };

    speechTimeoutRef.current = setTimeout(done, estimatedMs);
    window.speechSynthesis.speak(utterance);
  }

  // Speak a short immediate acknowledgment without adding it to the message log.
  // The real speakAgent call (with the API reply) will cancel this naturally.
  function speakQuick(text: string) {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const gen = ++speechGenRef.current;
    isSpeakingRef.current = true;
    setIsRobotSpeaking(true);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = selectedRobot?.name === "ZED" ? 0.9 : 1.03;
    utterance.onend = () => {
      if (speechGenRef.current !== gen) return;
      isSpeakingRef.current = false;
      setIsRobotSpeaking(false);
    };
    utterance.onerror = (e) => {
      if ((e as SpeechSynthesisErrorEvent).error === "canceled") return;
      if (speechGenRef.current !== gen) return;
      isSpeakingRef.current = false;
      setIsRobotSpeaking(false);
    };
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
    setUserId(null);
    setPinVerified(false);
    setPendingQuery(null);
    setIdentityState("unknown");
    setPendingMagicLink(null);
    setMessages([]);
    setSessionError("");
    setLobbyStatus(`${robot.name} is greeting you at Desk ${index + 1}.`);

    autoListenEnabledRef.current = true;

    // Speak FIRST — must happen synchronously within the click gesture to unlock
    // the Web Speech API. Keep it short so the VAD doesn't echo-loop on it.
    const greetings = [
      "Hi there! How can I help you today?",
      "Hello! Good to see you. What can I do for you?",
      "Hey, welcome in! How are you doing today?",
    ];
    speakAgent(
      greetings[Math.floor(Math.random() * greetings.length)],
      { autoListen: true },
    );

    // Fallback: if face scan hasn't resolved in 9 seconds, treat as new visitor
    // so the conversation can start without a face match.
    setTimeout(() => {
      setCameraState((s) => (s === "waiting" || s === "matching" ? "new" : s));
      setIdentityState((id) => (id === "unknown" ? "guest" : id));
    }, 9000);

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
    setUserId(null);
    setPinVerified(false);
    setIdentityState("unknown");
    setPendingQuery(null);
    setPendingMagicLink(null);
    setMessages([]);
    setSessionError("");
    setClarificationCount(0);
    setLobbyStatus("Click an available desk and the agent will greet you.");
  }

  async function handleFaceCapture(result: CaptureResult) {
    if (!selectedRobot) return;
    // Stop processing once we have a result (matched/new) or hardware error
    if (cameraState === "matched" || cameraState === "new" || cameraState === "error") return;

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
          "Welcome! I can help with balances, recent spending, account questions, and opening a new account. What would you like to do?",
          { autoListen: true },
        );
        return;
      }

      setRecognisedName(data.first_name);
      setUserId(data.user_id);
      setIdentityState("confirmed");
      setPendingMagicLink(data.magic_link);
      setCameraState("matched");
      setSessionStage("ready");
      speakAgent(
        `Welcome back, ${data.first_name}! Please say your four-digit PIN one digit at a time.`,
        { autoListen: true },
      );
    } catch {
      // Silently skip this frame — let the next capture interval retry.
      // Do NOT change cameraState here; setting it to "new" would block all future frames.
    }
  }

  function handleFaceError(_msg?: string) {
    // Camera hardware unavailable — fall back to guest without blocking future frames
    setCameraState("error");
    setSessionStage("ready");
    setIdentityState("guest");
  }

  async function processVisitorRequest(text: string) {
    if (!selectedRobot) return;

    const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";
    const lowerText = text.toLowerCase();

    // ── Phase 1: Face still scanning ─────────────────────────────────────────
    // Read auth state from refs — always current even inside stale VAD closures
    const currentIdentity  = identityStateRef.current;
    const currentCamera    = cameraStateRef.current;
    const currentPinVerified = pinVerifiedRef.current;
    const currentUserId    = userIdRef.current;
    const currentName      = recognisedNameRef.current;
    const currentPending   = pendingQueryRef.current;
    const currentMagicLink = pendingMagicLinkRef.current;

    // ── Phase 1: Face still scanning ─────────────────────────────────────────
    const stillScanning = currentCamera === "waiting" || currentCamera === "matching";
    if (stillScanning) {
      const isSmallTalk = /^(hi|hello|hey|good|fine|great|thanks?|how are|i'?m\b)/i.test(text.trim());
      if (!isSmallTalk) setPendingQuery(text);
      setCameraState("new");
      setIdentityState("guest");
    }

    // ── Phase 2: PIN entry — intercept before calling backend ─────────────────
    if (currentIdentity === "confirmed" && !currentPinVerified) {
      const hasAnyNumericContent = /\d/.test(text) ||
        /\b(zero|one|two|three|four|five|six|seven|eight|nine|oh|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/i.test(text);
      if (!hasAnyNumericContent) {
        speakAgent("Please say your four-digit PIN, one digit at a time.", { autoListen: true });
        return;
      }
    }

    setLastTurn({ said: text.slice(0, 72), understood: "…", reply: "…" });

    try {
      const res = await fetch(`${apiUrl}/agent/frontdesk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterance: text,
          robot_name: selectedRobot.name,
          recognised_name: currentName,
          user_id: currentUserId,
          has_face_match: currentCamera === "matched",
          has_magic_link: Boolean(currentMagicLink),
          pin_verified: currentPinVerified,
          pending_query: currentPending,
          history: messagesRef.current
            .slice(-8)
            .map((message) => ({ role: message.role, text: message.text })),
          clarification_count: clarificationCount,
          auth_state: currentIdentity === "confirmed" ? "confirmed"
            : currentCamera === "matched" ? "face_matched" : "none",
          customer_type: currentCamera === "new" ? "new"
            : currentCamera === "matched" ? "existing" : "unknown",
        }),
      });

      if (!res.ok) {
        throw new Error("The desk agent could not process that request.");
      }

      const decision: FrontDeskReply = await res.json();
      setSessionStage("ready");
      if (currentIdentity !== "confirmed") {
        setIdentityState(currentCamera === "matched" ? "confirmed" : currentIdentity);
      }

      // Echo session state back to backend on next turn
      if (typeof decision.clarification_count === "number") {
        setClarificationCount(decision.clarification_count);
      }
      if (decision.pin_verified) {
        setPinVerified(true);
        setPendingQuery(null); // fulfilled — the backend already answered it
      }

      // Update transcript panel
      const INTENT_LABELS: Record<string, string> = {
        transfer_money: "Money transfer",
        account_overview: "Account overview",
        recent_transactions: "Recent transactions",
        card_services: "Card services",
        fraud_dispute: "Fraud dispute",
        new_account_opening: "Opening new account",
        product_recommendation: "Product question",
        login_access_help: "Login help",
        branch_appointment: "Branch / appointment",
        greeting: "Greeting",
        public_info: "General banking info",
        unknown: "Clarifying request",
        general: "General question",
      };
      setLastTurn({
        said: text.length > 72 ? text.slice(0, 69) + "…" : text,
        understood: INTENT_LABELS[decision.intent_module ?? ""] ?? decision.intent_module ?? "General",
        reply: decision.reply.split(/(?<=[.!?])\s/)[0] ?? decision.reply,
      });

      const action: AgentAction = {};
      if (decision.should_route && decision.route_target === "magic_link" && pendingMagicLink) {
        action.magicLink = pendingMagicLink;
      } else {
        action.autoListen = true;
      }

      speakAgent(decision.reply, action);
    } catch (error) {
      setSessionStage("ready");
      setSessionError(error instanceof Error ? error.message : "I couldn't process that request clearly.");
      speakAgent(
        "Sorry, I didn't quite catch that. What did you need?",
        { autoListen: true },
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
    // Don't start recording while the robot is still speaking — we'd capture TTS audio
    if (isSpeakingRef.current) {
      setTimeout(() => startVADListen(), 300);
      return;
    }

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

      // Calibrate ambient noise over 300 ms for a stable baseline
      await new Promise(r => setTimeout(r, 300));
      if (!autoListenEnabledRef.current) { stream.getTracks().forEach(t => t.stop()); audioCtx.close(); return; }
      analyser.getByteFrequencyData(dataArray);
      const ambient = dataArray.slice(0, 32).reduce((a, b) => a + b, 0) / 32;
      const SPEECH_THRESH = Math.max(20, ambient * 3.2);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };

      let hasSpeech = false;
      let speechFrames = 0;          // consecutive frames above threshold
      const SPEECH_FRAMES_MIN = 4;   // 4 × 80 ms = 320 ms continuous speech required
      let silenceStart = Date.now();
      const recordStart = Date.now();
      // Deaf window: ignore speech for first 300 ms after VAD starts
      const deafUntil = Date.now() + 300;

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (vadAudioCtxRef.current === audioCtx) { audioCtx.close(); vadAudioCtxRef.current = null; }
        mediaRecorderRef.current = null;
        setVadLevel(0);

        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        // Too short or no real speech — restart listener
        if (!hasSpeech || blob.size < 3000) {
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

        const speaking = level * 2.55 > SPEECH_THRESH && Date.now() > deafUntil;
        if (speaking) {
          speechFrames++;
          if (speechFrames >= SPEECH_FRAMES_MIN) {
            // Only count as real speech after 320 ms continuous — filters noise bursts
            hasSpeech = true;
            silenceStart = Date.now();
          }
        } else {
          speechFrames = 0; // reset on any quiet frame
        }

        const silenceDuration = Date.now() - silenceStart;
        const elapsed = Date.now() - recordStart;

        // Stop conditions: silence after speech (700ms) OR no speech in 7s
        if (hasSpeech && silenceDuration > 700) {
          if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
          if (recorder.state === "recording") recorder.stop();
        } else if (!hasSpeech && elapsed > 7000) {
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

  const microcopy = useMemo(() => {
    if (cameraState === "waiting") return "Camera active · looking for you";
    if (cameraState === "matching") return "Checking your identity";
    if (identityState === "confirming") return "Please confirm your name";
    if (sessionStage === "processing") return "Fetching your details";
    if (sessionStage === "listening") return "Listening — speak naturally";
    return "";
  }, [cameraState, identityState, sessionStage]);

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

      <main
        className="relative h-[calc(100vh-37px)] min-h-[760px] overflow-hidden"
        style={{ background: "radial-gradient(ellipse 100% 75% at 50% 15%, #0d0321 0%, #04010e 55%, #020109 100%)" }}
      >
        {/* ── 3-D robot scene ── */}
        <div className="absolute inset-0">
          <RobotScene
            onSelectRobot={(robot) => handleSelectRobot(robot, 0)}
            focused={sessionOpen && focusIndex !== null}
            speaking={isRobotSpeaking}
            listening={sessionStage === "listening"}
          />
        </div>

        {/* ══════════════════════════════════════════════════════════
            CYBERPUNK LOBBY ATMOSPHERE
            ══════════════════════════════════════════════════════════ */}

        {/* 1 · Scanline texture — barely-there CRT feel */}
        <div
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(0,229,255,0.018) 2px, rgba(0,229,255,0.018) 3px)" }}
        />

        {/* 2 · Deep purple radial glow behind robot */}
        <div
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{ background: "radial-gradient(ellipse 75% 55% at 50% 38%, #1a0a3840 0%, transparent 70%)" }}
        />

        {/* 3 · Horizon glow halo */}
        <div
          className="pointer-events-none absolute inset-x-0 z-[2]"
          style={{
            top: "55%",
            height: "90px",
            background: "linear-gradient(to bottom, transparent, #00e5ff10 30%, #00e5ff1a 50%, #bf00ff0a 70%, transparent)",
            animation: "horizon-breathe 5s ease-in-out infinite",
          }}
        />

        {/* 4 · Horizon line — cyan → magenta */}
        <div
          className="pointer-events-none absolute inset-x-0 z-[2]"
          style={{
            top: "57%",
            height: "1px",
            background: "linear-gradient(to right, transparent 0%, #00e5ff55 12%, #00e5ff 30%, #00e5ffcc 45%, #bf00ffcc 55%, #bf00ff 70%, #bf00ff55 88%, transparent 100%)",
            boxShadow: "0 0 10px 3px rgba(0,229,255,0.35), 0 0 22px 8px rgba(0,229,255,0.12)",
            animation: "horizon-breathe 5s ease-in-out infinite",
          }}
        />

        {/* 5 · Perspective grid floor */}
        <div
          className="pointer-events-none absolute z-[2]"
          style={{
            bottom: 0,
            left: "-35%",
            right: "-35%",
            height: "44%",
            backgroundImage: [
              "repeating-linear-gradient(90deg, rgba(0,229,255,0.22) 0px, transparent 1px, transparent 79px, rgba(0,229,255,0.22) 80px)",
              "repeating-linear-gradient(0deg, rgba(0,229,255,0.22) 0px, transparent 1px, transparent 59px, rgba(0,229,255,0.22) 60px)",
              "linear-gradient(to top, rgba(0,229,255,0.1) 0%, rgba(191,0,255,0.04) 50%, transparent 80%)",
            ].join(","),
            transform: "perspective(340px) rotateX(73deg)",
            transformOrigin: "top center",
            animation: "grid-pulse 6s ease-in-out infinite",
          }}
        />

        {/* 6 · Floor center glow — robot standing point */}
        <div
          className="pointer-events-none absolute bottom-0 left-1/2 z-[3] -translate-x-1/2"
          style={{
            width: "560px",
            height: "160px",
            background: "radial-gradient(ellipse at bottom, #00e5ff28 0%, #bf00ff12 45%, transparent 72%)",
            animation: "horizon-breathe 4s ease-in-out infinite 1.2s",
          }}
        />

        {/* 7 · Left primary neon column */}
        <div
          className="pointer-events-none absolute z-[3]"
          style={{
            top: "7%", bottom: "14%", left: "6%", width: "2px",
            background: "linear-gradient(to bottom, transparent 0%, #00e5ff 12%, #00e5ff 82%, #bf00ff 96%, transparent 100%)",
            boxShadow: "0 0 8px 2px rgba(0,229,255,0.65), 0 0 22px 6px rgba(0,229,255,0.2)",
            animation: "neon-flicker 7s ease-in-out infinite",
          }}
        />
        <div
          className="pointer-events-none absolute z-[2]"
          style={{
            top: "7%", bottom: "14%", left: "calc(6% - 18px)", width: "40px",
            background: "linear-gradient(to right, transparent, rgba(0,229,255,0.07) 50%, transparent)",
          }}
        />

        {/* 8 · Left secondary neon column */}
        <div
          className="pointer-events-none absolute z-[3]"
          style={{
            top: "14%", bottom: "20%", left: "18%", width: "1px",
            background: "linear-gradient(to bottom, transparent 0%, #bf00ff90 20%, #bf00ff90 75%, transparent 100%)",
            boxShadow: "0 0 6px 2px rgba(191,0,255,0.45), 0 0 14px 5px rgba(191,0,255,0.15)",
            animation: "neon-flicker-b 9s ease-in-out infinite 2s",
          }}
        />

        {/* 9 · Right primary neon column */}
        <div
          className="pointer-events-none absolute z-[3]"
          style={{
            top: "7%", bottom: "14%", right: "6%", width: "2px",
            background: "linear-gradient(to bottom, transparent 0%, #00e5ff 12%, #00e5ff 82%, #bf00ff 96%, transparent 100%)",
            boxShadow: "0 0 8px 2px rgba(0,229,255,0.65), 0 0 22px 6px rgba(0,229,255,0.2)",
            animation: "neon-flicker 7s ease-in-out infinite 1s",
          }}
        />
        <div
          className="pointer-events-none absolute z-[2]"
          style={{
            top: "7%", bottom: "14%", right: "calc(6% - 18px)", width: "40px",
            background: "linear-gradient(to left, transparent, rgba(0,229,255,0.07) 50%, transparent)",
          }}
        />

        {/* 10 · Right secondary neon column */}
        <div
          className="pointer-events-none absolute z-[3]"
          style={{
            top: "14%", bottom: "20%", right: "18%", width: "1px",
            background: "linear-gradient(to bottom, transparent 0%, #bf00ff90 20%, #bf00ff90 75%, transparent 100%)",
            boxShadow: "0 0 6px 2px rgba(191,0,255,0.45), 0 0 14px 5px rgba(191,0,255,0.15)",
            animation: "neon-flicker-b 9s ease-in-out infinite 0.5s",
          }}
        />

        {/* 11 · Top frame neon line */}
        <div
          className="pointer-events-none absolute inset-x-0 z-[3]"
          style={{
            top: "6.5%",
            height: "1px",
            background: "linear-gradient(to right, transparent 0%, #00e5ff30 18%, #00e5ff55 50%, #00e5ff30 82%, transparent 100%)",
            animation: "corner-pulse 8s ease-in-out infinite",
          }}
        />

        {/* 12 · HUD corner brackets */}
        {/* top-left */}
        <div className="pointer-events-none absolute z-[4]" style={{ top: 90, left: 24, width: 30, height: 30, borderTop: "1.5px solid #00e5ff", borderLeft: "1.5px solid #00e5ff", boxShadow: "-2px -2px 8px rgba(0,229,255,0.5)", animation: "corner-pulse 4s ease-in-out infinite" }} />
        {/* top-right */}
        <div className="pointer-events-none absolute z-[4]" style={{ top: 90, right: 24, width: 30, height: 30, borderTop: "1.5px solid #00e5ff", borderRight: "1.5px solid #00e5ff", boxShadow: "2px -2px 8px rgba(0,229,255,0.5)", animation: "corner-pulse 4s ease-in-out infinite 1s" }} />
        {/* bottom-left */}
        <div className="pointer-events-none absolute z-[4]" style={{ bottom: 90, left: 24, width: 30, height: 30, borderBottom: "1.5px solid #bf00ff", borderLeft: "1.5px solid #bf00ff", boxShadow: "-2px 2px 8px rgba(191,0,255,0.5)", animation: "corner-pulse 4s ease-in-out infinite 2s" }} />
        {/* bottom-right */}
        <div className="pointer-events-none absolute z-[4]" style={{ bottom: 90, right: 24, width: 30, height: 30, borderBottom: "1.5px solid #bf00ff", borderRight: "1.5px solid #bf00ff", boxShadow: "2px 2px 8px rgba(191,0,255,0.5)", animation: "corner-pulse 4s ease-in-out infinite 3s" }} />

        {/* 13 · Cyber particles — cyan + magenta */}
        {([
          { left: "11%", bottom: "24%", delay: "0s",    size: 2,   dur: "6s",    variant: "a" },
          { left: "24%", bottom: "19%", delay: "1.1s",  size: 1.5, dur: "8s",    variant: "b" },
          { left: "37%", bottom: "29%", delay: "2.4s",  size: 2,   dur: "7s",    variant: "a" },
          { left: "51%", bottom: "17%", delay: "0.5s",  size: 2.5, dur: "7.5s",  variant: "b" },
          { left: "63%", bottom: "23%", delay: "3.1s",  size: 2,   dur: "6.5s",  variant: "a" },
          { left: "77%", bottom: "31%", delay: "1.6s",  size: 1.5, dur: "8.5s",  variant: "b" },
          { left: "88%", bottom: "26%", delay: "4.3s",  size: 2,   dur: "7s",    variant: "a" },
          { left: "18%", bottom: "48%", delay: "2.9s",  size: 1.5, dur: "10s",   variant: "b" },
          { left: "84%", bottom: "44%", delay: "0.4s",  size: 2,   dur: "7.5s",  variant: "a" },
          { left: "44%", bottom: "58%", delay: "5.2s",  size: 1,   dur: "11s",   variant: "b" },
          { left: "67%", bottom: "52%", delay: "3.7s",  size: 1.5, dur: "9.5s",  variant: "a" },
        ] as const).map((p, i) => (
          <div
            key={i}
            className="pointer-events-none absolute z-[3] rounded-full"
            style={{
              left: p.left,
              bottom: p.bottom,
              width: `${p.size}px`,
              height: `${p.size}px`,
              backgroundColor: p.variant === "a" ? "#00e5ff" : "#bf00ff",
              boxShadow: p.variant === "a" ? "0 0 5px 1px #00e5ff" : "0 0 5px 1px #bf00ff",
              opacity: 0,
              animationName: p.variant === "a" ? "cyber-particle" : "cyber-particle-b",
              animationDuration: p.dur,
              animationDelay: p.delay,
              animationIterationCount: "infinite",
              animationTimingFunction: "ease-out",
            }}
          />
        ))}

        {/* 14 · Side vignettes */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-[7%]" style={{ background: "linear-gradient(to right, #02010985, transparent)" }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-[7%]" style={{ background: "linear-gradient(to left, #02010985, transparent)" }} />

        {/* ══════ END ATMOSPHERE ══════ */}

        <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-black/65 via-black/20 to-transparent" />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-56"
          style={{ background: "linear-gradient(to top, #020109 0%, #020109aa 40%, transparent 100%)" }}
        />

        {/* ── ARIA holographic nameplate ── */}
        {!sessionOpen && (
          <div
            className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
            style={{ bottom: "28%" }}
          >
            <div className="flex flex-col items-center gap-2">
              {/* HUD-style identity plate */}
              <div
                className="relative px-7 py-2 backdrop-blur-md"
                style={{
                  borderTop:    `1px solid ${ROBOTS[0].color}90`,
                  borderBottom: `1px solid ${ROBOTS[0].color}90`,
                  borderLeft:   `1px solid ${ROBOTS[0].color}28`,
                  borderRight:  `1px solid ${ROBOTS[0].color}28`,
                  background: `linear-gradient(135deg, ${ROBOTS[0].color}18, transparent 60%, ${ROBOTS[0].color}0a)`,
                }}
              >
                {/* Corner brackets */}
                <div className="absolute left-0 top-0 h-2.5 w-2.5 border-l border-t" style={{ borderColor: ROBOTS[0].color }} />
                <div className="absolute right-0 top-0 h-2.5 w-2.5 border-r border-t" style={{ borderColor: ROBOTS[0].color }} />
                <div className="absolute bottom-0 left-0 h-2.5 w-2.5 border-b border-l" style={{ borderColor: ROBOTS[0].color }} />
                <div className="absolute bottom-0 right-0 h-2.5 w-2.5 border-b border-r" style={{ borderColor: ROBOTS[0].color }} />
                <p className="text-sm font-bold tracking-[0.55em] uppercase" style={{ color: ROBOTS[0].color }}>
                  {ROBOTS[0].name}
                </p>
              </div>
              <p className="text-[9px] tracking-[0.38em] uppercase" style={{ color: `${ROBOTS[0].color}55` }}>
                AI Banking Concierge · Unit 01
              </p>
            </div>
          </div>
        )}

        {/* ── Bottom info section — replaces Lobby Floor card ── */}
        {!sessionOpen && (
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex flex-col items-center gap-3 px-6">
            {/* Live status line */}
            <div className="flex items-center gap-3">
              <div className="h-px w-14" style={{ background: "linear-gradient(to right, transparent, rgba(0,229,255,0.4))" }} />
              <div className="flex items-center gap-1.5">
                <span className="relative flex h-[7px] w-[7px]">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
                  <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-cyan-400" />
                </span>
                <span className="text-[9px] font-medium tracking-[0.42em] uppercase" style={{ color: "rgba(0,229,255,0.85)" }}>
                  ARIA Online · Ready
                </span>
              </div>
              <div className="h-px w-14" style={{ background: "linear-gradient(to left, transparent, rgba(0,229,255,0.4))" }} />
            </div>

            {/* CTA */}
            <p className="text-[12px] tracking-wide text-white/35">
              Click ARIA to begin your secure banking session
            </p>

            {/* Capability chips */}
            <div className="flex flex-wrap justify-center gap-2">
              {(["Voice Enabled", "Face Recognition", "PIN Secured", "Live Balances", "AI Assistant"] as const).map((feat) => (
                <span
                  key={feat}
                  className="rounded-full px-3 py-0.5 text-[9px] tracking-wider"
                  style={{
                    border: "1px solid rgba(0,229,255,0.15)",
                    background: "rgba(0,229,255,0.04)",
                    color: "rgba(0,229,255,0.5)",
                  }}
                >
                  {feat}
                </span>
              ))}
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

            {/* Ambient screen-edge glow — pulses when listening, steady when speaking */}
            <div
              className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-500"
              style={{
                opacity: sessionStage === "listening" ? 1 : isRobotSpeaking ? 0.6 : 0,
                boxShadow: `inset 0 0 80px 12px ${selectedRobot.color}28`,
              }}
            />

            {/* Top-left: robot identity chip + microcopy + leave */}
            <div className="absolute left-4 top-[80px] z-40 flex flex-col gap-1 sm:left-6">
              <div className="flex items-center gap-2">
                <div
                  className="flex items-center gap-2 rounded-full border bg-slate-950/60 px-3 py-1.5 text-white backdrop-blur-xl"
                  style={{ borderColor: `${selectedRobot.color}50` }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full transition-all duration-300"
                    style={{
                      backgroundColor: selectedRobot.color,
                      boxShadow: sessionStage === "listening"
                        ? `0 0 6px 2px ${selectedRobot.color}`
                        : "none",
                    }}
                  />
                  <span className="text-xs font-semibold tracking-wide">{selectedRobot.name}</span>
                  {recognisedName && (
                    <span className="text-xs text-emerald-300/80">· {recognisedName}</span>
                  )}
                </div>
                <button
                  onClick={closeSession}
                  className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1.5 text-xs text-white/50 backdrop-blur-xl transition hover:bg-white/10 hover:text-white/80"
                >
                  Leave
                </button>
              </div>
              {microcopy && (
                <p className="pl-1 text-[10px] tracking-wide text-white/35 transition-all duration-500">
                  {microcopy}
                </p>
              )}
            </div>

            {/* Transcript panel — 3 lines: You said / Understood / Reply */}
            {lastTurn && (
              <div className="absolute bottom-20 left-1/2 z-40 w-full max-w-xs -translate-x-1/2 px-4">
                <div
                  className="rounded-2xl border border-white/10 bg-slate-950/65 px-4 py-3 backdrop-blur-xl"
                  style={{ borderColor: `${selectedRobot.color}22` }}
                >
                  {(
                    [
                      { label: "You said", value: lastTurn.said, accent: false },
                      { label: "Understood", value: lastTurn.understood, accent: true },
                      { label: "Answer", value: lastTurn.reply, accent: false },
                    ] as { label: string; value: string; accent: boolean }[]
                  ).map(({ label, value, accent }) => (
                    <div key={label} className="flex items-start gap-2 py-0.5">
                      <span className="w-[72px] shrink-0 text-[10px] text-white/30">{label}</span>
                      <span
                        className="line-clamp-2 text-[10px] leading-relaxed"
                        style={{ color: accent ? selectedRobot.color : "rgba(255,255,255,0.65)" }}
                      >
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Bottom: 4-state status word */}
            <div className="absolute inset-x-0 bottom-7 z-40 flex justify-center">
              <span
                className="text-[11px] font-light tracking-[0.32em] uppercase transition-all duration-300"
                style={{
                  color: sessionStage === "listening"
                    ? selectedRobot.color
                    : (cameraState === "matching" || identityState === "confirming")
                      ? "#f59e0b"
                      : "rgba(255,255,255,0.28)",
                  opacity: (sessionStage === "listening" || sessionStage === "processing" || isRobotSpeaking) ? 1 : 0,
                }}
              >
                {sessionStage === "listening" ? "Listening"
                  : isRobotSpeaking ? "Speaking"
                  : (cameraState === "matching" || identityState === "confirming") ? "Verifying"
                  : "Thinking"}
              </span>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
