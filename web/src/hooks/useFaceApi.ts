"use client";

import { useEffect, useRef, useState } from "react";

export type FaceApiState = "idle" | "loading" | "ready" | "error";

let _loaded = false;
let _loading = false;
const _listeners: Array<(ready: boolean) => void> = [];

export function useFaceApi() {
  const [state, setState] = useState<FaceApiState>(_loaded ? "ready" : "idle");

  useEffect(() => {
    if (_loaded) { setState("ready"); return; }
    if (_loading) {
      _listeners.push((ok) => setState(ok ? "ready" : "error"));
      setState("loading");
      return;
    }
    _loading = true;
    setState("loading");

    (async () => {
      try {
        // Dynamically import so TensorFlow.js only loads client-side
        const faceapi = await import("face-api.js");
        const MODEL_URL = "/models";
        // Load TinyFaceDetector first (190 KB) so the camera appears fast,
        // then load the heavier models for landmarks + recognition in parallel.
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        _loaded = true;
        setState("ready");
        _listeners.forEach((fn) => fn(true));
      } catch (e) {
        console.error("face-api.js failed to load:", e);
        setState("error");
        _listeners.forEach((fn) => fn(false));
      } finally {
        _loading = false;
      }
    })();
  }, []);

  return state;
}

export function useFaceApiLoaded() {
  return useFaceApi() === "ready";
}
