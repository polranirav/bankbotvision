"use client";

import { useState } from "react";

export type FaceApiState = "idle" | "loading" | "ready" | "error";

export function useFaceApi() {
  // ML is now handled on the backend. This hook simply returns "ready" 
  // so components that depended on it can start the camera immediately.
  const [state] = useState<FaceApiState>("ready");
  return state;
}

export function useFaceApiLoaded() {
  return true;
}
