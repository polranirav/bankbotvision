"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, ContactShadows, Float } from "@react-three/drei";
import { Robot, ROBOTS, type RobotDef } from "./Robot";
import { Suspense } from "react";

type Props = {
  onSelectRobot: (robot: RobotDef) => void;
};

function SceneContent({ onSelectRobot }: Props) {
  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 8, 5]} intensity={1.2} castShadow />
      <pointLight position={[-4, 3, -4]} intensity={0.5} color="#a78bfa" />
      <pointLight position={[4, 3, -4]}  intensity={0.5} color="#60a5fa" />

      {/* Environment */}
      <Environment preset="city" />

      {/* Floor shadow */}
      <ContactShadows
        position={[0, -1.5, 0]}
        opacity={0.4}
        scale={10}
        blur={2}
        far={4}
      />

      {/* 3 robots with subtle float animation */}
      {ROBOTS.map((robot, i) => (
        <Float
          key={robot.name}
          speed={1.5 + i * 0.3}
          rotationIntensity={0.05}
          floatIntensity={0.2}
        >
          <Robot
            def={robot}
            position={[(i - 1) * 2.6, 0, 0]}
            onClick={() => onSelectRobot(robot)}
          />
        </Float>
      ))}

      <OrbitControls
        enableZoom={false}
        enablePan={false}
        minPolarAngle={Math.PI / 3}
        maxPolarAngle={Math.PI / 2.2}
        autoRotate
        autoRotateSpeed={0.4}
      />
    </>
  );
}

export function RobotScene({ onSelectRobot }: Props) {
  return (
    <Canvas
      camera={{ position: [0, 1.2, 7], fov: 50 }}
      style={{ width: "100%", height: "100%" }}
      shadows
    >
      <Suspense fallback={null}>
        <SceneContent onSelectRobot={onSelectRobot} />
      </Suspense>
    </Canvas>
  );
}
