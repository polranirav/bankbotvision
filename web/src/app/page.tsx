"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RobotDef } from "@/components/Robot";
import { FaceCapture, type CaptureResult } from "@/components/FaceCapture";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";

// Three.js must NOT run server-side
const RobotScene = dynamic(
  () => import("@/components/RobotScene").then((m) => m.RobotScene),
  { ssr: false, loading: () => (
    <div className="flex items-center justify-center h-full text-neutral-400 text-sm gap-2">
      <span className="w-5 h-5 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin inline-block" />
      Loading robots…
    </div>
  )},
);

type Stage = "idle" | "scanning" | "matching" | "error";

export default function Home() {
  const router = useRouter();
  const [selectedRobot, setSelectedRobot] = useState<RobotDef | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  function handleSelectRobot(robot: RobotDef) {
    setSelectedRobot(robot);
    setStage("scanning");
    setErrorMsg("");
  }

  async function handleFaceCapture(result: CaptureResult) {
    if (!selectedRobot) return;
    setStage("matching");

    const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";
    try {
      const res = await fetch(
        `${apiUrl}/face/match`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ descriptor: result.descriptor }),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: "Face not recognised" }));
        setErrorMsg(body.detail ?? "Face not recognised");
        setStage("error");
        return;
      }

      const { first_name, magic_link } = await res.json();
      // Brief greeting before redirect
      setErrorMsg(`Welcome back, ${first_name}! 👋`);
      setStage("error"); // reuse to show message
      setTimeout(() => { window.location.href = magic_link; }, 1200);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Something went wrong");
      setStage("error");
    }
  }

  function closeModal() {
    setSelectedRobot(null);
    setStage("idle");
    setErrorMsg("");
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 text-white flex flex-col">
      <DisclaimerBanner />

      {/* Header */}
      <header className="flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🏦</span>
          <span className="font-bold text-lg tracking-tight">BankBot Vision</span>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => router.push("/signup")}
            className="rounded-lg bg-white/10 hover:bg-white/20 px-4 py-2 text-sm font-medium transition"
          >
            Create Account
          </button>
          <button
            onClick={() => router.push("/login")}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 text-sm font-medium transition"
          >
            Sign In
          </button>
        </div>
      </header>

      {/* Hero text */}
      <div className="text-center pt-8 pb-2 space-y-2 px-4">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          Your AI Bank Assistant
        </h1>
        <p className="text-slate-400 text-lg">
          Pick a robot. Look at the camera. Get greeted by name.
        </p>
        <p className="text-slate-500 text-sm mt-1">
          ↓ Click any robot to sign in with your face
        </p>
      </div>

      {/* 3D Robot canvas */}
      <div className="flex-1 min-h-[420px] w-full relative">
        <RobotScene onSelectRobot={handleSelectRobot} />

        {/* Robot name labels */}
        <div className="absolute bottom-6 left-0 right-0 flex justify-center gap-16 pointer-events-none">
          {["ARIA", "MAX", "ZED"].map((name, i) => {
            const colors = ["text-blue-400", "text-green-400", "text-purple-400"];
            const subs  = ["Friendly & Helpful", "Fast & Precise", "Calm & Analytical"];
            return (
              <div key={name} className="text-center">
                <p className={`font-bold text-sm ${colors[i]}`}>{name}</p>
                <p className="text-slate-500 text-xs">{subs[i]}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Face scan modal */}
      {selectedRobot && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={closeModal}
        >
          <div
            className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Robot header */}
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm"
                style={{ backgroundColor: selectedRobot.color }}
              >
                {selectedRobot.name[0]}
              </div>
              <div>
                <p className="font-semibold">{selectedRobot.name}</p>
                <p className="text-xs text-slate-400">{selectedRobot.personality}</p>
              </div>
              <button
                onClick={closeModal}
                className="ml-auto text-slate-500 hover:text-white text-xl leading-none"
              >
                ×
              </button>
            </div>

            {stage === "scanning" && (
              <>
                <p className="text-sm text-slate-300">
                  Look at the camera — {selectedRobot.name} will recognise you automatically.
                </p>
                <FaceCapture
                  onCapture={handleFaceCapture}
                  onError={(msg) => { setErrorMsg(msg); setStage("error"); }}
                  matchOnly
                />
              </>
            )}

            {stage === "matching" && (
              <div className="flex flex-col items-center gap-3 py-6">
                <div className="w-10 h-10 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
                <p className="text-sm text-slate-300">Matching your face…</p>
              </div>
            )}

            {stage === "error" && (
              <div className="space-y-3">
                <p className={`text-sm ${errorMsg.includes("Welcome") ? "text-green-400" : "text-red-400"}`}>
                  {errorMsg}
                </p>
                {!errorMsg.includes("Welcome") && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => setStage("scanning")}
                      className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm font-medium transition"
                    >
                      Try again
                    </button>
                    <button
                      onClick={() => router.push("/signup")}
                      className="flex-1 rounded-lg bg-white/10 hover:bg-white/20 py-2 text-sm transition"
                    >
                      Sign up
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
