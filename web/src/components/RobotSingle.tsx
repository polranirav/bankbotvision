"use client";

/**
 * RobotSingle — single centred robot for the /chat page.
 * Passes a `speaking` flag to the Robot component which triggers
 * a head-nod + body pulse animation while the assistant is talking.
 */

import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, Environment, Float } from "@react-three/drei";
import { Robot, type RobotDef } from "./Robot";

type Props = {
  robot: RobotDef;
  speaking?: boolean;
};

function SceneContent({ robot, speaking }: Props) {
  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 6, 4]} intensity={1.2} castShadow />
      <pointLight position={[-3, 2, -3]} intensity={0.6} color="#a78bfa" />

      <Environment preset="city" />

      <ContactShadows position={[0, -1.5, 0]} opacity={0.35} scale={6} blur={2} far={4} />

      <Float speed={2} rotationIntensity={0.04} floatIntensity={0.25}>
        <Robot def={robot} position={[0, 0, 0]} speaking={speaking} />
      </Float>
    </>
  );
}

export function RobotSingle({ robot, speaking = false }: Props) {
  return (
    <Canvas
      camera={{ position: [0, 0.8, 4.5], fov: 45 }}
      style={{ width: "100%", height: "100%" }}
      shadows
    >
      <Suspense fallback={null}>
        <SceneContent robot={robot} speaking={speaking} />
      </Suspense>
    </Canvas>
  );
}
