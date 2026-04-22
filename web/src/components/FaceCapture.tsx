"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useFaceApi } from "@/hooks/useFaceApi";

export type CaptureResult = {
  descriptor: number[];   // 128-dim face-api.js descriptor
  imageDataUrl: string;   // JPEG snapshot for storage
};

type Props = {
  onCapture: (result: CaptureResult) => void;
  onError?: (msg: string) => void;
  /** Match-only mode: pass this to identify a face (no capture saved) */
  matchOnly?: boolean;
  /** Minimal mode keeps camera processing active but hides the large preview UI */
  minimal?: boolean;
};

export function FaceCapture({ onCapture, onError, matchOnly = false, minimal = false }: Props) {
  const faceState = useFaceApi();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState("Loading face models…");
  const [scanning, setScanning] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start webcam
  useEffect(() => {
    if (faceState !== "ready") return;
    setStatus("Starting camera…");
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play();
            setStatus(matchOnly ? "Look at the camera to sign in" : "Position your face in the frame");
            setScanning(true);
          };
        }
      })
      .catch(() => {
        setStatus("Camera access denied");
        onError?.("Camera access denied");
      });

    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [faceState, matchOnly, onError]);

  // Continuous face detection loop
  useEffect(() => {
    if (!scanning) return;

    const detect = async () => {
      if (!videoRef.current || videoRef.current.readyState < 2) return;
      const faceapi = (await import("face-api.js")).default ?? await import("face-api.js");

      // Use TinyFaceDetector for the live loop — 5-10× faster than SSD MobileNet.
      // Only SSD MobileNet is used at final capture for the full descriptor.
      const result = await faceapi
        .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!result) {
        setFaceDetected(false);
        drawOverlay(false);
        return;
      }

      setFaceDetected(true);
      drawOverlay(true, result.detection.box);
    };

    intervalRef.current = setInterval(detect, 150);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [scanning]);

  const drawOverlay = (detected: boolean, box?: { x: number; y: number; width: number; height: number }) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (detected && box) {
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 3;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    }
  };

  const capture = useCallback(async () => {
    if (!videoRef.current || !faceDetected) return;
    const faceapi = (await import("face-api.js")).default ?? await import("face-api.js");

    setStatus("Capturing…");
    const result = await faceapi
      .detectSingleFace(videoRef.current, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.7 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!result) {
      setStatus("No face detected — try again");
      return;
    }

    // Snapshot
    const snap = document.createElement("canvas");
    snap.width = videoRef.current.videoWidth;
    snap.height = videoRef.current.videoHeight;
    snap.getContext("2d")?.drawImage(videoRef.current, 0, 0);
    const imageDataUrl = snap.toDataURL("image/jpeg", 0.8);

    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (intervalRef.current) clearInterval(intervalRef.current);

    onCapture({
      descriptor: Array.from(result.descriptor),
      imageDataUrl,
    });
  }, [faceDetected, onCapture]);

  // Auto-capture in match-only mode when face is confidently detected
  useEffect(() => {
    if (matchOnly && faceDetected) {
      capture();
    }
  }, [matchOnly, faceDetected, capture]);

  if (faceState === "error") {
    return <p className="text-red-600 text-sm">Failed to load face models.</p>;
  }

  if (faceState === "loading") {
    return (
      <div className={`flex flex-col items-center gap-3 ${minimal ? "py-0" : "py-6"}`}>
        <div className="w-8 h-8 border-2 border-neutral-300 border-t-neutral-800 rounded-full animate-spin" />
        {!minimal && (
          <>
            <p className="text-sm text-neutral-500">Loading face recognition models…</p>
            <p className="text-xs text-neutral-400">(first load only — ~3 seconds)</p>
          </>
        )}
      </div>
    );
  }

  if (minimal) {
    return (
      <div className="relative">
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute h-px w-px opacity-0 pointer-events-none"
          style={{ transform: "scaleX(-1)" }}
        />
        <canvas
          ref={canvasRef}
          className="absolute h-px w-px opacity-0 pointer-events-none"
          style={{ transform: "scaleX(-1)" }}
        />
        <div className="rounded-full border border-white/15 bg-slate-950/45 px-4 py-2 text-sm text-white backdrop-blur">
          {faceDetected ? "Face detected" : status}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative rounded-xl overflow-hidden border-2 border-neutral-200 bg-black" style={{ width: 320, height: 240 }}>
        <video
          ref={videoRef}
          muted
          playsInline
          className="w-full h-full object-cover"
          style={{ transform: "scaleX(-1)" }}
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ transform: "scaleX(-1)" }}
        />
        {faceDetected && (
          <span className="absolute top-2 left-2 bg-green-500 text-white text-xs px-2 py-0.5 rounded-full">
            Face detected ✓
          </span>
        )}
      </div>
      <p className="text-sm text-neutral-600">{status}</p>
      {!matchOnly && (
        <button
          onClick={capture}
          disabled={!faceDetected}
          className="rounded bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-700 disabled:opacity-40"
        >
          {faceDetected ? "Capture face" : "Waiting for face…"}
        </button>
      )}
    </div>
  );
}
