"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import * as THREE from "three";
import { Robot, Desk, ROBOTS, type RobotDef } from "./Robot";
import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";

const DESK_POS: [number, number, number] = [0, -0.3, 0];
const ROBOT_POS: [number, number, number] = [0, 0.52, -0.55];

// ── Camera rig ────────────────────────────────────────────────────────────────
type CameraProps = { focused: boolean };

function CameraRig({ focused }: CameraProps) {
  const { camera } = useThree();
  const targetPos = useRef(new THREE.Vector3(0, 1.8, 9));
  const targetLook = useRef(new THREE.Vector3(0, 0, 0));
  const currentLook = useRef(new THREE.Vector3(0, 0.35, 0));

  useFrame(() => {
    if (focused) {
      targetPos.current.set(0, 1.05, 3.0);
      targetLook.current.set(0, 0.68, -0.1);
    } else {
      targetPos.current.set(0, 1.8, 9);
      targetLook.current.set(0, 0.25, 0);
    }

    const speed = focused ? 0.055 : 0.045;
    camera.position.lerp(targetPos.current, speed);
    currentLook.current.lerp(targetLook.current, speed + 0.02);
    camera.lookAt(currentLook.current);
  });

  return null;
}

// ── Floor ─────────────────────────────────────────────────────────────────────
function LobbyFloor() {
  return (
    <>
      {/* Main floor — dark reflective tile */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.3, 0]} receiveShadow>
        <planeGeometry args={[30, 20]} />
        <meshStandardMaterial color="#03000f" roughness={0.3} metalness={0.6} />
      </mesh>
      {/* Alternating tiles */}
      {Array.from({ length: 9 }, (_, col) =>
        Array.from({ length: 5 }, (_, row) => {
          const x = (col - 4) * 3;
          const z = (row - 2) * 3 + 1;
          if ((col + row) % 2 === 0) return null;
          return (
            <mesh key={`${col}-${row}`} rotation={[-Math.PI / 2, 0, 0]} position={[x, -1.295, z]}>
              <planeGeometry args={[2.9, 2.9]} />
              <meshStandardMaterial color="#07001c" roughness={0.4} metalness={0.5} />
            </mesh>
          );
        })
      )}
      {/* Neon glow plane under desk — robot standing platform */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.285, 0.2]}>
        <planeGeometry args={[3.8, 2.8]} />
        <meshStandardMaterial
          color="#00e5ff" emissive="#00e5ff" emissiveIntensity={0.07}
          transparent opacity={0.3} depthWrite={false}
        />
      </mesh>
      {/* Back wall */}
      <mesh position={[0, 2, -4]} receiveShadow>
        <planeGeometry args={[30, 10]} />
        <meshStandardMaterial color="#02000c" roughness={0.9} />
      </mesh>
      {/* Counter front panel — dark chrome */}
      <mesh position={[0, -0.85, 0.62]}>
        <boxGeometry args={[6, 0.9, 0.22]} />
        <meshStandardMaterial color="#070616" roughness={0.2} metalness={0.8} />
      </mesh>
      {/* Counter neon edge — bright cyan strip */}
      <mesh position={[0, -0.42, 0.74]}>
        <boxGeometry args={[6.1, 0.02, 0.02]} />
        <meshStandardMaterial color="#00e5ff" emissive="#00e5ff" emissiveIntensity={5} />
      </mesh>
    </>
  );
}

// ── Décor ─────────────────────────────────────────────────────────────────────
function LobbyDecor() {
  return (
    <>
      {/* Ceiling neon strip — cyan center */}
      <group position={[0, 3.5, -0.8]}>
        <mesh>
          <boxGeometry args={[2.4, 0.04, 0.16]} />
          <meshStandardMaterial color="#00e5ff" emissive="#00e5ff" emissiveIntensity={1.5} />
        </mesh>
      </group>
      {/* Ceiling neon — magenta left */}
      <group position={[-3.8, 3.3, -1.4]}>
        <mesh>
          <boxGeometry args={[1.8, 0.03, 0.1]} />
          <meshStandardMaterial color="#bf00ff" emissive="#bf00ff" emissiveIntensity={1.8} />
        </mesh>
        <pointLight position={[0, -0.5, 0]} intensity={1.2} color="#bf00ff" distance={7} />
      </group>
      {/* Ceiling neon — magenta right */}
      <group position={[3.8, 3.3, -1.4]}>
        <mesh>
          <boxGeometry args={[1.8, 0.03, 0.1]} />
          <meshStandardMaterial color="#bf00ff" emissive="#bf00ff" emissiveIntensity={1.8} />
        </mesh>
        <pointLight position={[0, -0.5, 0]} intensity={1.2} color="#bf00ff" distance={7} />
      </group>
      {/* Wall banner + neon underline */}
      <group position={[0, 2.8, -3.9]}>
        <mesh>
          <planeGeometry args={[4, 0.6]} />
          <meshStandardMaterial color="#030012" />
        </mesh>
        <mesh position={[0, -0.38, 0.01]}>
          <planeGeometry args={[4.1, 0.04]} />
          <meshStandardMaterial color="#00e5ff" emissive="#00e5ff" emissiveIntensity={4} />
        </mesh>
      </group>
      {/* Left wall vertical neon strip */}
      <mesh position={[-7.5, 1.5, -1.5]}>
        <boxGeometry args={[0.025, 5.5, 0.025]} />
        <meshStandardMaterial color="#bf00ff" emissive="#bf00ff" emissiveIntensity={3} />
      </mesh>
      {/* Right wall vertical neon strip */}
      <mesh position={[7.5, 1.5, -1.5]}>
        <boxGeometry args={[0.025, 5.5, 0.025]} />
        <meshStandardMaterial color="#00e5ff" emissive="#00e5ff" emissiveIntensity={3} />
      </mesh>
    </>
  );
}

// ── Scene content ─────────────────────────────────────────────────────────────
type SceneProps = {
  onSelectRobot: (robot: RobotDef) => void;
  focused: boolean;
  speaking: boolean;
  listening: boolean;
};

function SceneContent({ onSelectRobot, focused, speaking, listening }: SceneProps) {
  const robot = ROBOTS[0];
  return (
    <>
      {/* Match CSS background — deep dark purple-black */}
      <color attach="background" args={["#04010e"]} />

      <ambientLight intensity={0.18} color="#0a0025" />
      <directionalLight position={[2, 8, 5]} intensity={0.6} castShadow color="#b0d8ff" />

      {/* Front key light — illuminates robot face-on from camera side */}
      <pointLight position={[0, 1.5, 5]} intensity={1.6} color="#0088ff" distance={12} />
      {/* Cyberpunk neon fill lights */}
      <pointLight position={[-7, 3, 2]} intensity={2.2} color="#00e5ff" distance={18} />
      <pointLight position={[ 7, 3, 2]} intensity={1.8} color="#bf00ff" distance={18} />
      {/* Uplighter from floor — neon glow on underside of desk */}
      <pointLight position={[0, -0.9, 2.5]} intensity={1.1} color="#00e5ff" distance={6} />
      {/* Ceiling chandelier neon */}
      <pointLight position={[0, 3.5, -0.8]} intensity={2.0} color="#00e5ff" distance={10} />

      <ContactShadows position={[0, -1.28, 0]} opacity={0.8} scale={20} blur={1.8} far={5} color="#000018" />

      <LobbyFloor />
      <LobbyDecor />

      <Desk position={DESK_POS} color={robot.color} active={focused} activity="waiting" />
      <Robot
        def={robot}
        position={ROBOT_POS}
        onClick={() => onSelectRobot(robot)}
        speaking={speaking}
        listening={listening}
        seated
        active={focused}
        activity="waiting"
      />

      <CameraRig focused={focused} />
    </>
  );
}

// ── Exported canvas ───────────────────────────────────────────────────────────
type Props = {
  onSelectRobot: (robot: RobotDef) => void;
  focused: boolean;
  speaking: boolean;
  listening: boolean;
};

export function RobotScene({ onSelectRobot, focused, speaking, listening }: Props) {
  return (
    <Canvas
      camera={{ position: [0, 1.8, 9], fov: 46 }}
      style={{ width: "100%", height: "100%" }}
      shadows={{ type: THREE.PCFShadowMap }}
    >
      <Suspense fallback={null}>
        <SceneContent
          onSelectRobot={onSelectRobot}
          focused={focused}
          speaking={speaking}
          listening={listening}
        />
      </Suspense>
    </Canvas>
  );
}
