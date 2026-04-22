"use client";

/**
 * FaceCapture — simple webcam component.
 *
 * All face ML (detection, embedding, matching) now runs on the server via
 * DeepFace. This component just shows the camera feed and captures a JPEG
 * frame to send to the API.
 *
 * matchOnly=false  → manual "Capture" button (signup flow)
 * matchOnly=true   → auto-captures every 2.5 s and fires onCapture (lobby)
 * minimal=true     → no visible UI (just runs the capture loop in background)
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type CaptureResult = {
  imageDataUrl: string; // data:image/jpeg;base64,…
};

type Props = {
  onCapture: (result: CaptureResult) => void;
  onError?: (msg: string) => void;
  matchOnly?: boolean;
  minimal?: boolean;
};

export function FaceCapture({
  onCapture,
  onError,
  matchOnly = false,
  minimal = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capturedRef = useRef(false);

  const [status, setStatus] = useState("Starting camera…");
  const [cameraReady, setCameraReady] = useState(false);

  // ── Start camera ────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } })
      .then((stream) => {
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play();
            setCameraReady(true);
            setStatus(matchOnly ? "Looking for you…" : "Position your face in the frame");
          };
        }
      })
      .catch(() => {
        if (!active) return;
        setStatus("Camera access denied");
        onError?.("Camera access denied. Please allow camera permission and refresh.");
      });

    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [matchOnly, onError]);

  // ── Auto-capture loop (matchOnly) ────────────────────────────────────────
  useEffect(() => {
    if (!matchOnly || !cameraReady) return;

    // Fire first capture right away, then every 2.5 s
    const capture = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const snap = document.createElement("canvas");
      snap.width = video.videoWidth;
      snap.height = video.videoHeight;
      snap.getContext("2d")?.drawImage(video, 0, 0);
      onCapture({ imageDataUrl: snap.toDataURL("image/jpeg", 0.85) });
    };

    // Small initial delay so the camera has a frame
    const init = setTimeout(capture, 800);
    intervalRef.current = setInterval(capture, 2500);

    return () => {
      clearTimeout(init);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [matchOnly, cameraReady, onCapture]);

  // ── Manual capture (signup) ──────────────────────────────────────────────
  const captureManual = useCallback(() => {
    const video = videoRef.current;
    if (!video || capturedRef.current) return;
    capturedRef.current = true;

    const snap = document.createElement("canvas");
    snap.width = video.videoWidth;
    snap.height = video.videoHeight;
    snap.getContext("2d")?.drawImage(video, 0, 0);

    streamRef.current?.getTracks().forEach((t) => t.stop());
    setStatus("Captured ✓");
    onCapture({ imageDataUrl: snap.toDataURL("image/jpeg", 0.9) });
  }, [onCapture]);

  // ── Minimal mode (lobby inline) ──────────────────────────────────────────
  if (minimal) {
    return (
      <div className="flex items-center gap-2">
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute h-px w-px opacity-0 pointer-events-none"
        />
        <span
          className={[
            "h-2 w-2 rounded-full",
            cameraReady ? "bg-green-400 animate-pulse" : "bg-slate-500",
          ].join(" ")}
        />
        <span className="text-xs text-white/60">{status}</span>
      </div>
    );
  }

  // ── Full UI (signup) ─────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center gap-4">
      {/* Camera frame */}
      <div className="relative overflow-hidden rounded-2xl border-2 border-neutral-200 bg-black shadow-lg"
        style={{ width: 320, height: 240 }}>
        <video
          ref={videoRef}
          muted
          playsInline
          className="h-full w-full object-cover"
          style={{ transform: "scaleX(-1)" }}
        />

        {/* Oval face guide */}
        {cameraReady && (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 320 240"
          >
            <ellipse
              cx="160" cy="118" rx="72" ry="90"
              fill="none"
              stroke="rgba(255,255,255,0.55)"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
          </svg>
        )}

        {/* Loading overlay */}
        {!cameraReady && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 text-white">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            <span className="text-xs">{status}</span>
          </div>
        )}
      </div>

      <p className="text-sm text-neutral-500">{status}</p>

      {/* Capture button (manual mode) */}
      {!matchOnly && (
        <button
          onClick={captureManual}
          disabled={!cameraReady || status === "Captured ✓"}
          className="rounded-lg bg-neutral-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
        >
          {status === "Captured ✓" ? "✓ Face saved" : "Capture face"}
        </button>
      )}
    </div>
  );
}
