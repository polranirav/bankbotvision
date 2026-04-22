"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import * as THREE from "three";
import { Robot, Desk, ROBOTS, type RobotDef } from "./Robot";
import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";

// Desk positions — 3 stations spread across the lobby
const DESK_POSITIONS: [number, number, number][] = [
  [-4.2, -0.3, 0],
  [ 0,   -0.3, 0],
  [ 4.2, -0.3, 0],
];

// Robot sits just behind and above the desk surface
const ROBOT_OFFSETS: [number, number, number][] = [
  [-4.2, 0.52, -0.55],
  [ 0,   0.52, -0.55],
  [ 4.2, 0.52, -0.55],
];

const DESK_ACTIVITIES: Array<"typing" | "waiting" | "waiting"> = [
  "typing",
  "waiting",
  "waiting",
];

// ── Camera rig — lerps toward selected desk ──────────────────────────────────
type CameraProps = { focusIndex: number | null };

function CameraRig({ focusIndex }: CameraProps) {
  const { camera } = useThree();
  const targetPos = useRef(new THREE.Vector3(0, 1.8, 9));
  const targetLook = useRef(new THREE.Vector3(0, 0, 0));
  const currentLook = useRef(new THREE.Vector3(0, 0.35, 0));

  useFrame(() => {
    if (focusIndex !== null) {
      const dx = DESK_POSITIONS[focusIndex][0];
      targetPos.current.set(dx * 0.82, 0.92, 2.7);
      targetLook.current.set(dx, 0.44, -0.12);
    } else {
      targetPos.current.set(0, 1.8, 9);
      targetLook.current.set(0, 0.25, 0);
    }

    camera.position.lerp(targetPos.current, focusIndex !== null ? 0.08 : 0.05);
    currentLook.current.lerp(targetLook.current, focusIndex !== null ? 0.1 : 0.06);
    camera.lookAt(currentLook.current);
  });

  return null;
}

// ── Floor ────────────────────────────────────────────────────────────────────
function LobbyFloor() {
  return (
    <>
      {/* Main floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.3, 0]} receiveShadow>
        <planeGeometry args={[30, 20]} />
        <meshStandardMaterial color="#0f172a" roughness={0.8} metalness={0.1} />
      </mesh>
      {/* Floor tiles pattern — alternating subtle squares */}
      {Array.from({ length: 9 }, (_, col) =>
        Array.from({ length: 5 }, (_, row) => {
          const x = (col - 4) * 3;
          const z = (row - 2) * 3 + 1;
          if ((col + row) % 2 === 0) return null;
          return (
            <mesh key={`${col}-${row}`} rotation={[-Math.PI / 2, 0, 0]} position={[x, -1.295, z]}>
              <planeGeometry args={[2.9, 2.9]} />
              <meshStandardMaterial color="#111827" roughness={0.9} />
            </mesh>
          );
        })
      )}
      {/* Back wall */}
      <mesh position={[0, 2, -4]} receiveShadow>
        <planeGeometry args={[30, 10]} />
        <meshStandardMaterial color="#0c1220" roughness={0.9} />
      </mesh>
      {/* Dividers between desks */}
      {[-2.1, 2.1].map((x) => (
        <mesh key={x} position={[x, 0.5, -0.5]}>
          <boxGeometry args={[0.06, 2.4, 1.8]} />
          <meshStandardMaterial color="#1e293b" roughness={0.6} metalness={0.2} />
        </mesh>
      ))}
      {/* Counter base */}
      <mesh position={[0, -0.85, 0.62]}>
        <boxGeometry args={[14, 0.9, 0.22]} />
        <meshStandardMaterial color="#111827" roughness={0.5} metalness={0.3} />
      </mesh>
    </>
  );
}

// ── Ambient décor ─────────────────────────────────────────────────────────────
function LobbyDecor() {
  return (
    <>
      {/* Ceiling strip lights */}
      {[-4.2, 0, 4.2].map((x, i) => (
        <group key={i} position={[x, 3.5, -1]}>
          <mesh>
            <boxGeometry args={[1.8, 0.06, 0.3]} />
            <meshStandardMaterial color="#e2e8f0" emissive="#e2e8f0" emissiveIntensity={0.3} />
          </mesh>
          <pointLight position={[0, -0.5, 0]} intensity={0.8} color="#f0f9ff" distance={6} />
        </group>
      ))}
      {/* BankBot Vision sign on back wall */}
      <group position={[0, 2.8, -3.9]}>
        <mesh>
          <planeGeometry args={[4, 0.6]} />
          <meshStandardMaterial color="#0f172a" />
        </mesh>
        {/* Glowing accent line under sign */}
        <mesh position={[0, -0.38, 0.01]}>
          <planeGeometry args={[4, 0.04]} />
          <meshStandardMaterial color="#3b82f6" emissive="#3b82f6" emissiveIntensity={2} />
        </mesh>
      </group>
    </>
  );
}

// ── Scene content ─────────────────────────────────────────────────────────────
type SceneProps = {
  onSelectRobot: (robot: RobotDef, index: number) => void;
  focusIndex: number | null;
  speakingIndex: number | null;
};

function SceneContent({ onSelectRobot, focusIndex, speakingIndex }: SceneProps) {
  return (
    <>
      <ambientLight intensity={0.25} />
      <directionalLight position={[0, 8, 6]} intensity={0.9} castShadow color="#f0f9ff" />
      <pointLight position={[-6, 3, 2]} intensity={0.4} color="#60a5fa" />
      <pointLight position={[ 6, 3, 2]} intensity={0.4} color="#a78bfa" />

      <ContactShadows position={[0, -1.28, 0]} opacity={0.5} scale={20} blur={2.5} far={5} />

      <LobbyFloor />
      <LobbyDecor />

      {ROBOTS.map((robot, i) => (
        <group key={robot.name}>
          <Desk
            position={DESK_POSITIONS[i]}
            color={robot.color}
            active={focusIndex === i}
            activity={DESK_ACTIVITIES[i]}
          />
          <Robot
            def={robot}
            position={ROBOT_OFFSETS[i]}
            onClick={() => onSelectRobot(robot, i)}
            speaking={speakingIndex === i}
            seated
            active={focusIndex === i}
            activity={DESK_ACTIVITIES[i]}
          />
        </group>
      ))}

      <CameraRig focusIndex={focusIndex} />
    </>
  );
}

// ── Exported canvas ───────────────────────────────────────────────────────────
type Props = {
  onSelectRobot: (robot: RobotDef, index: number) => void;
  focusIndex: number | null;
  speakingIndex: number | null;
};

export function RobotScene({ onSelectRobot, focusIndex, speakingIndex }: Props) {
  return (
    <Canvas
      camera={{ position: [0, 1.8, 9], fov: 52 }}
      style={{ width: "100%", height: "100%" }}
      shadows
    >
      <Suspense fallback={null}>
        <SceneContent
          onSelectRobot={onSelectRobot}
          focusIndex={focusIndex}
          speakingIndex={speakingIndex}
        />
      </Suspense>
    </Canvas>
  );
}
