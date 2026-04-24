"use client";

/**
 * FaceCapture — webcam component with live face-api.js detection overlay.
 *
 * face-api.js runs in the browser and draws a bounding box so the user can
 * see their face is detected before capturing.  All actual face embedding /
 * identity matching still happens server-side via DeepFace.
 *
 * matchOnly=false  → manual "Capture" button (account set-up flow)
 * matchOnly=true   → auto-captures every 2.5 s and fires onCapture (lobby)
 * minimal=true     → no visible UI, just runs the capture loop in background
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

// ── face-api.js model loading (lazy, once per page load) ─────────────────────
let faceApiLoaded = false;
let faceApiLoading = false;

async function loadFaceApi() {
  if (faceApiLoaded || faceApiLoading) return;
  faceApiLoading = true;
  try {
    const faceapi = await import("face-api.js");
    const MODEL_URL = "/models";
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    ]);
    faceApiLoaded = true;
  } catch (e) {
    console.warn("face-api.js failed to load:", e);
  } finally {
    faceApiLoading = false;
  }
}

export function FaceCapture({
  onCapture,
  onError,
  matchOnly = false,
  minimal = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectionRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capturedRef = useRef(false);

  const [status, setStatus] = useState("Starting camera…");
  const [cameraReady, setCameraReady] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [modelsReady, setModelsReady] = useState(false);

  // ── Load face-api.js models ─────────────────────────────────────────────────
  useEffect(() => {
    if (minimal) return; // skip overlay in minimal mode
    loadFaceApi().then(() => {
      if (faceApiLoaded) setModelsReady(true);
    });
  }, [minimal]);

  // ── Start camera ─────────────────────────────────────────────────────────────
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

  // ── Live face detection overlay ──────────────────────────────────────────────
  useEffect(() => {
    if (!cameraReady || !modelsReady || minimal) return;

    const run = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) return;

      try {
        const faceapi = await import("face-api.js");
        const detection = await faceapi.detectSingleFace(
          video,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.45 })
        );

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (detection) {
          setFaceDetected(true);
          if (!capturedRef.current) {
            setStatus(matchOnly ? "Face detected — matching…" : "Face detected ✓ — click Capture");
          }

          // Mirror the bounding box (video is CSS-mirrored with scaleX(-1))
          const { x, y, width, height } = detection.box;
          const mirroredX = canvas.width - x - width;

          // Draw glowing bounding box
          ctx.shadowColor = "#22d3ee";
          ctx.shadowBlur = 12;
          ctx.strokeStyle = "#22d3ee";
          ctx.lineWidth = 2.5;
          ctx.strokeRect(mirroredX, y, width, height);

          // Corner accents
          const corner = Math.min(width, height) * 0.18;
          ctx.shadowBlur = 0;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 3;
          const drawCorner = (cx: number, cy: number, dx: number, dy: number) => {
            ctx.beginPath();
            ctx.moveTo(cx + dx * corner, cy);
            ctx.lineTo(cx, cy);
            ctx.lineTo(cx, cy + dy * corner);
            ctx.stroke();
          };
          drawCorner(mirroredX, y, 1, 1);
          drawCorner(mirroredX + width, y, -1, 1);
          drawCorner(mirroredX, y + height, 1, -1);
          drawCorner(mirroredX + width, y + height, -1, -1);

          // Confidence label
          ctx.font = "11px monospace";
          ctx.fillStyle = "#22d3ee";
          ctx.fillText(`${Math.round(detection.score * 100)}%`, mirroredX + 4, y - 6);
        } else {
          setFaceDetected(false);
          if (!capturedRef.current) {
            setStatus(matchOnly ? "Looking for you…" : "Position your face in the frame");
          }
        }
      } catch {
        // detection errors are non-fatal — just skip the frame
      }
    };

    detectionRef.current = setInterval(run, 180);
    return () => {
      if (detectionRef.current) clearInterval(detectionRef.current);
    };
  }, [cameraReady, modelsReady, matchOnly, minimal]);

  // ── Auto-capture loop (matchOnly) ────────────────────────────────────────────
  useEffect(() => {
    if (!matchOnly || !cameraReady) return;

    const capture = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const snap = document.createElement("canvas");
      snap.width = video.videoWidth;
      snap.height = video.videoHeight;
      snap.getContext("2d")?.drawImage(video, 0, 0);
      onCapture({ imageDataUrl: snap.toDataURL("image/jpeg", 0.85) });
    };

    const init = setTimeout(capture, 800);
    intervalRef.current = setInterval(capture, 2500);

    return () => {
      clearTimeout(init);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [matchOnly, cameraReady, onCapture]);

  // ── Manual capture ────────────────────────────────────────────────────────────
  const captureManual = useCallback(() => {
    const video = videoRef.current;
    if (!video || capturedRef.current) return;
    capturedRef.current = true;

    const snap = document.createElement("canvas");
    snap.width = video.videoWidth;
    snap.height = video.videoHeight;
    snap.getContext("2d")?.drawImage(video, 0, 0);

    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (detectionRef.current) clearInterval(detectionRef.current);
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);

    setStatus("Captured ✓");
    onCapture({ imageDataUrl: snap.toDataURL("image/jpeg", 0.9) });
  }, [onCapture]);

  // ── Minimal mode ──────────────────────────────────────────────────────────────
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

  // ── Full UI ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center gap-4">
      {/* Camera frame */}
      <div
        className="relative overflow-hidden rounded-2xl border-2 bg-black shadow-lg transition-colors duration-300"
        style={{
          width: 320,
          height: 240,
          borderColor: faceDetected ? "#22d3ee" : "#e5e7eb",
          boxShadow: faceDetected ? "0 0 18px rgba(34,211,238,0.35)" : undefined,
        }}
      >
        {/* Mirrored video feed */}
        <video
          ref={videoRef}
          muted
          playsInline
          className="h-full w-full object-cover"
          style={{ transform: "scaleX(-1)" }}
        />

        {/* face-api.js detection overlay canvas (NOT mirrored — we mirror the box coords in JS) */}
        <canvas
          ref={canvasRef}
          width={640}
          height={480}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />

        {/* Loading overlay */}
        {!cameraReady && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 text-white">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            <span className="text-xs">{status}</span>
          </div>
        )}
      </div>

      {/* Status */}
      <p className={`text-sm transition-colors ${faceDetected ? "text-cyan-500 font-medium" : "text-neutral-500"}`}>
        {status}
      </p>

      {/* Capture button */}
      {!matchOnly && (
        <button
          onClick={captureManual}
          disabled={!cameraReady || status === "Captured ✓" || (!faceDetected && modelsReady)}
          className="rounded-lg bg-neutral-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
          title={!faceDetected && modelsReady ? "No face detected — look directly at the camera" : undefined}
        >
          {status === "Captured ✓" ? "✓ Face saved" : "Capture face"}
        </button>
      )}

      {/* Hint when face not detected */}
      {cameraReady && modelsReady && !faceDetected && status !== "Captured ✓" && (
        <p className="text-xs text-neutral-400">No face detected — look directly at the camera</p>
      )}
    </div>
  );
}
