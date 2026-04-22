"use client";

import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";

export type RobotDef = {
  name: string;
  color: string;
  eyeColor: string;
  personality: string;
  voiceId: string;
  greeting: string;   // spoken on desk approach
};

export const ROBOTS: RobotDef[] = [
  {
    name: "ARIA",
    color: "#2563eb",
    eyeColor: "#93c5fd",
    personality: "Friendly & Helpful",
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    greeting: "Hi there! I'm ARIA. Welcome to BankBot Vision. I'm here to help you with all your banking needs. Shall I verify who you are?",
  },
  {
    name: "MAX",
    color: "#16a34a",
    eyeColor: "#86efac",
    personality: "Fast & Precise",
    voiceId: "AZnzlk1XvdvUeBnXmlld",
    greeting: "Welcome. I'm MAX. Ready to assist you. Let me quickly verify your identity and we can get started.",
  },
  {
    name: "ZED",
    color: "#7c3aed",
    eyeColor: "#c4b5fd",
    personality: "Calm & Analytical",
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    greeting: "Good day. I'm ZED. Please allow me a moment to verify who you are, and I'll have everything ready for you.",
  },
];

type Props = {
  def: RobotDef;
  position: [number, number, number];
  onClick?: () => void;
  speaking?: boolean;
  seated?: boolean;     // seated at desk pose
  active?: boolean;     // this desk is currently selected/focused
  activity?: "typing" | "busy" | "waiting";
};

export function Robot({
  def,
  position,
  onClick,
  speaking = false,
  seated = false,
  active = false,
  activity = "waiting",
}: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const headRef  = useRef<THREE.Group>(null);
  const lArmRef  = useRef<THREE.Group>(null);
  const rArmRef  = useRef<THREE.Group>(null);
  const lLegRef  = useRef<THREE.Group>(null);
  const rLegRef  = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  const bodyColor  = new THREE.Color(def.color);
  const darkColor  = bodyColor.clone().multiplyScalar(0.6);
  const lightColor = bodyColor.clone().multiplyScalar(1.4);
  const eyeColor   = new THREE.Color(def.eyeColor);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    const activityIsTyping = seated && activity === "typing" && !active && !speaking;
    const activityIsBusy = seated && activity === "busy" && !active && !speaking;

    // Bob — gentle when seated, lively when speaking
    const bobSpeed = speaking ? 3.5 : active ? 1.9 : activityIsBusy ? 1.8 : 1.2;
    const bobAmp   = speaking ? 0.06 : active ? 0.038 : (seated ? 0.025 : 0.06);
    groupRef.current.position.y = position[1] + Math.sin(t * bobSpeed) * bobAmp;

    // Head nod + sway
    if (headRef.current) {
      headRef.current.rotation.x = speaking
        ? Math.sin(t * 4.0) * 0.15
        : activityIsTyping
          ? -0.18 + Math.sin(t * 3.4) * 0.03
          : activityIsBusy
            ? Math.sin(t * 2.2) * 0.08
            : 0;
      headRef.current.rotation.y = activityIsBusy
        ? Math.sin(t * 1.9) * 0.2
        : Math.sin(t * 0.8) * ((hovered || active) ? 0.25 : 0.08);
      headRef.current.rotation.z = Math.sin(t * 0.5) * 0.03;
    }

    if (!seated) {
      // Walk cycle for standing robots
      const swing = speaking ? 0 : Math.sin(t * 2.0) * 0.35;
      if (lArmRef.current) lArmRef.current.rotation.x =  swing;
      if (rArmRef.current) rArmRef.current.rotation.x = -swing;
      if (lLegRef.current) lLegRef.current.rotation.x = -swing * 0.7;
      if (rLegRef.current) rLegRef.current.rotation.x =  swing * 0.7;
    } else if (activityIsTyping) {
      if (lArmRef.current) {
        lArmRef.current.rotation.x = 1.28 + Math.sin(t * 9.0) * 0.12;
        lArmRef.current.rotation.z = 0.24 + Math.sin(t * 4.2) * 0.05;
      }
      if (rArmRef.current) {
        rArmRef.current.rotation.x = 1.22 + Math.sin(t * 9.0 + 0.5) * 0.12;
        rArmRef.current.rotation.z = -0.24 + Math.sin(t * 4.0 + 0.4) * 0.05;
      }
    } else if (activityIsBusy) {
      if (lArmRef.current) {
        lArmRef.current.rotation.x = 0.95 + Math.sin(t * 2.6) * 0.18;
        lArmRef.current.rotation.z = 0.05 + Math.sin(t * 1.9) * 0.08;
      }
      if (rArmRef.current) {
        rArmRef.current.rotation.x = 0.65 + Math.sin(t * 2.9 + 0.4) * 0.28;
        rArmRef.current.rotation.z = -0.45 + Math.sin(t * 2.9 + 0.3) * 0.12;
      }
    } else if (seated && !active && !speaking) {
      if (lArmRef.current) {
        lArmRef.current.rotation.x = THREE.MathUtils.lerp(lArmRef.current.rotation.x, 1.08, 0.08);
        lArmRef.current.rotation.z = THREE.MathUtils.lerp(lArmRef.current.rotation.z, 0.15, 0.08);
      }
      if (rArmRef.current) {
        rArmRef.current.rotation.x = THREE.MathUtils.lerp(rArmRef.current.rotation.x, 1.08, 0.08);
        rArmRef.current.rotation.z = THREE.MathUtils.lerp(rArmRef.current.rotation.z, -0.15, 0.08);
      }
    }

    // Lean forward slightly when active/hovered
    groupRef.current.rotation.x = (hovered || active)
      ? THREE.MathUtils.lerp(groupRef.current.rotation.x, -0.06, 0.08)
      : THREE.MathUtils.lerp(groupRef.current.rotation.x, 0, 0.08);
  });

  const mat = (color: THREE.Color) => (
    <meshStandardMaterial color={color} roughness={0.3} metalness={0.6} />
  );

  const eyeIntensity = (hovered || active) ? 3.5 : speaking ? 2.5 : 1.5;

  // ── Seated pose offsets ─────────────────────────────────────────────────
  // Torso sits higher because legs are bent under the desk
  const torsoY   = seated ? 0.1  : 0;
  const headY    = seated ? 0.9  : 0.8;
  const lArmX    = -0.52;
  const rArmX    =  0.52;
  const armY     = seated ? 0.2  : 0.15;

  return (
    <group
      ref={groupRef}
      position={position}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      onPointerEnter={() => { setHovered(true);  document.body.style.cursor = "pointer"; }}
      onPointerLeave={() => { setHovered(false); document.body.style.cursor = "default"; }}
    >
      {/* Torso */}
      <RoundedBox args={[0.75, 0.95, 0.45]} radius={0.06} position={[0, torsoY, 0]}>
        {mat((hovered || active) ? lightColor : bodyColor)}
      </RoundedBox>

      {/* Chest panel */}
      <RoundedBox args={[0.4, 0.35, 0.05]} radius={0.04} position={[0, torsoY + 0.05, 0.23]}>
        <meshStandardMaterial color={darkColor} roughness={0.2} metalness={0.8} />
      </RoundedBox>

      {/* Head */}
      <group ref={headRef} position={[0, headY, 0]}>
        <RoundedBox args={[0.62, 0.58, 0.52]} radius={0.1}>
          {mat((hovered || active) ? lightColor : bodyColor)}
        </RoundedBox>
        {/* Eyes */}
        {[-0.16, 0.16].map((x, i) => (
          <mesh key={i} position={[x, 0.05, 0.27]}>
            <sphereGeometry args={[0.08, 16, 16]} />
            <meshStandardMaterial color={eyeColor} emissive={eyeColor} emissiveIntensity={eyeIntensity} />
          </mesh>
        ))}
        {/* Mouth — wider when speaking */}
        <RoundedBox
          args={speaking ? [0.32, 0.07, 0.04] : [0.28, 0.05, 0.04]}
          radius={0.02}
          position={[0, -0.14, 0.27]}
        >
          <meshStandardMaterial color={eyeColor} emissive={eyeColor} emissiveIntensity={speaking ? 1.8 : 0.8} />
        </RoundedBox>
        {/* Antenna */}
        <mesh position={[0, 0.38, 0]}>
          <cylinderGeometry args={[0.03, 0.03, 0.25, 8]} />
          <meshStandardMaterial color={darkColor} metalness={0.9} roughness={0.1} />
        </mesh>
        <mesh position={[0, 0.52, 0]}>
          <sphereGeometry args={[0.07, 12, 12]} />
          <meshStandardMaterial color={eyeColor} emissive={eyeColor} emissiveIntensity={active ? 3 : 2} />
        </mesh>
      </group>

      {seated ? (
        <>
          {/* Arms resting on desk — angled forward + down */}
          <group ref={lArmRef} position={[lArmX, armY, 0]} rotation={[1.1, 0, 0.15]}>
            <mesh position={[0, -0.25, 0]}>
              <boxGeometry args={[0.22, 0.55, 0.22]} />
              {mat(darkColor)}
            </mesh>
            <mesh position={[0, -0.56, 0]}>
              <sphereGeometry args={[0.13, 10, 10]} />
              {mat(bodyColor)}
            </mesh>
          </group>
          <group ref={rArmRef} position={[rArmX, armY, 0]} rotation={[1.1, 0, -0.15]}>
            <mesh position={[0, -0.25, 0]}>
              <boxGeometry args={[0.22, 0.55, 0.22]} />
              {mat(darkColor)}
            </mesh>
            <mesh position={[0, -0.56, 0]}>
              <sphereGeometry args={[0.13, 10, 10]} />
              {mat(bodyColor)}
            </mesh>
          </group>

          {/* Legs bent under desk (hidden, just thighs visible) */}
          <group ref={lLegRef} position={[-0.2, torsoY - 0.52, 0]} rotation={[1.4, 0, 0]}>
            <mesh position={[0, -0.2, 0]}>
              <boxGeometry args={[0.25, 0.45, 0.28]} />
              {mat(darkColor)}
            </mesh>
          </group>
          <group ref={rLegRef} position={[0.2, torsoY - 0.52, 0]} rotation={[1.4, 0, 0]}>
            <mesh position={[0, -0.2, 0]}>
              <boxGeometry args={[0.25, 0.45, 0.28]} />
              {mat(darkColor)}
            </mesh>
          </group>
        </>
      ) : (
        <>
          {/* Standing arms */}
          <group ref={lArmRef} position={[-0.52, 0.15, 0]}>
            <mesh position={[0, -0.3, 0]}>
              <boxGeometry args={[0.22, 0.65, 0.22]} />
              {mat(darkColor)}
            </mesh>
            <mesh position={[0, -0.68, 0]}>
              <sphereGeometry args={[0.14, 10, 10]} />
              {mat(bodyColor)}
            </mesh>
          </group>
          <group ref={rArmRef} position={[0.52, 0.15, 0]}>
            <mesh position={[0, -0.3, 0]}>
              <boxGeometry args={[0.22, 0.65, 0.22]} />
              {mat(darkColor)}
            </mesh>
            <mesh position={[0, -0.68, 0]}>
              <sphereGeometry args={[0.14, 10, 10]} />
              {mat(bodyColor)}
            </mesh>
          </group>

          {/* Standing legs */}
          <group ref={lLegRef} position={[-0.2, -0.72, 0]}>
            <mesh position={[0, -0.3, 0]}>
              <boxGeometry args={[0.25, 0.65, 0.28]} />
              {mat(darkColor)}
            </mesh>
            <RoundedBox args={[0.3, 0.14, 0.38]} radius={0.06} position={[0, -0.65, 0.05]}>
              {mat(bodyColor)}
            </RoundedBox>
          </group>
          <group ref={rLegRef} position={[0.2, -0.72, 0]}>
            <mesh position={[0, -0.3, 0]}>
              <boxGeometry args={[0.25, 0.65, 0.28]} />
              {mat(darkColor)}
            </mesh>
            <RoundedBox args={[0.3, 0.14, 0.38]} radius={0.06} position={[0, -0.65, 0.05]}>
              {mat(bodyColor)}
            </RoundedBox>
          </group>
        </>
      )}
    </group>
  );
}

// ── Desk component ────────────────────────────────────────────────────────────
type DeskProps = {
  position: [number, number, number];
  color: string;
  active?: boolean;
  activity?: "typing" | "busy" | "waiting";
};

export function Desk({ position, color, active = false, activity = "waiting" }: DeskProps) {
  const accentColor = new THREE.Color(color);
  const deskColor   = new THREE.Color(active ? "#2d3748" : "#1e2533");
  const legColor    = new THREE.Color("#111827");
  const screenColor =
    activity === "typing"
      ? "#1d4ed8"
      : activity === "busy"
        ? "#7c2d12"
        : active
          ? "#1e3a5f"
          : "#111";
  const glowOpacity =
    activity === "typing"
      ? 1.15
      : activity === "busy"
        ? 0.95
        : active
          ? 1.2
          : 0.4;

  return (
    <group position={position}>
      {/* Desktop surface */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[2.2, 0.08, 1.1]} />
        <meshStandardMaterial color={deskColor} roughness={0.4} metalness={0.3} />
      </mesh>

      {/* Accent trim strip on front edge */}
      <mesh position={[0, 0.02, 0.52]}>
        <boxGeometry args={[2.2, 0.06, 0.04]} />
        <meshStandardMaterial color={accentColor} emissive={accentColor} emissiveIntensity={active ? 0.8 : 0.3} />
      </mesh>

      {/* Small monitor on desk */}
      <group position={[0, 0.35, -0.25]}>
        {/* Screen */}
        <mesh>
          <boxGeometry args={[0.7, 0.45, 0.04]} />
          <meshStandardMaterial color={screenColor} roughness={0.2} />
        </mesh>
        {/* Screen glow */}
        <mesh position={[0, 0, 0.025]}>
          <planeGeometry args={[0.62, 0.38]} />
          <meshStandardMaterial color={accentColor} emissive={accentColor} emissiveIntensity={glowOpacity} transparent opacity={0.9} />
        </mesh>
        {activity === "typing" && (
          <>
            <mesh position={[-0.08, 0.05, 0.03]}>
              <planeGeometry args={[0.18, 0.025]} />
              <meshBasicMaterial color="#e0f2fe" />
            </mesh>
            <mesh position={[0.08, -0.04, 0.03]}>
              <planeGeometry args={[0.24, 0.025]} />
              <meshBasicMaterial color="#bfdbfe" />
            </mesh>
          </>
        )}
        {activity === "busy" && (
          <mesh position={[0, 0.02, 0.03]}>
            <ringGeometry args={[0.06, 0.12, 20]} />
            <meshBasicMaterial color="#fdba74" />
          </mesh>
        )}
        {activity === "waiting" && (
          <mesh position={[0, -0.02, 0.03]}>
            <planeGeometry args={[0.24, 0.025]} />
            <meshBasicMaterial color="#c4b5fd" />
          </mesh>
        )}
        {/* Stand */}
        <mesh position={[0, -0.32, 0.08]}>
          <cylinderGeometry args={[0.03, 0.05, 0.2, 8]} />
          <meshStandardMaterial color="#374151" />
        </mesh>
        <mesh position={[0, -0.44, 0.08]}>
          <boxGeometry args={[0.25, 0.03, 0.18]} />
          <meshStandardMaterial color="#374151" />
        </mesh>
      </group>

      {/* Keyboard / laptop base */}
      <mesh position={[0, 0.05, -0.02]}>
        <boxGeometry args={[0.62, 0.035, 0.22]} />
        <meshStandardMaterial color="#334155" metalness={0.6} roughness={0.35} />
      </mesh>

      {/* Small mug or desk accessory */}
      <mesh position={[0.62, 0.08, 0.02]}>
        <cylinderGeometry args={[0.07, 0.07, 0.12, 16]} />
        <meshStandardMaterial color={activity === "busy" ? "#f59e0b" : "#e5e7eb"} roughness={0.5} />
      </mesh>
      <mesh position={[0.7, 0.08, 0.02]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.03, 0.01, 10, 18]} />
        <meshStandardMaterial color="#cbd5e1" />
      </mesh>

      {/* Name plate on desk front */}
      <mesh position={[0, 0.06, 0.42]}>
        <boxGeometry args={[0.55, 0.1, 0.02]} />
        <meshStandardMaterial color={accentColor} emissive={accentColor} emissiveIntensity={0.5} />
      </mesh>

      {/* 4 legs */}
      {([-0.9, 0.9] as number[]).map((lx) =>
        ([-0.35, 0.35] as number[]).map((lz) => (
          <mesh key={`${lx}-${lz}`} position={[lx, -0.42, lz]}>
            <boxGeometry args={[0.08, 0.76, 0.08]} />
            <meshStandardMaterial color={legColor} metalness={0.7} roughness={0.3} />
          </mesh>
        ))
      )}

      {/* Chair seat */}
      <mesh position={[0, -0.72, -0.7]}>
        <boxGeometry args={[0.7, 0.08, 0.65]} />
        <meshStandardMaterial color="#1f2937" roughness={0.8} />
      </mesh>
      {/* Chair back */}
      <mesh position={[0, -0.35, -0.99]}>
        <boxGeometry args={[0.68, 0.72, 0.07]} />
        <meshStandardMaterial color="#1f2937" roughness={0.8} />
      </mesh>
      {/* Chair pole */}
      <mesh position={[0, -1.0, -0.7]}>
        <cylinderGeometry args={[0.04, 0.04, 0.56, 8]} />
        <meshStandardMaterial color="#374151" metalness={0.8} />
      </mesh>
      {/* Chair base */}
      <mesh position={[0, -1.28, -0.7]} rotation={[0, Math.PI / 4, 0]}>
        <cylinderGeometry args={[0.38, 0.38, 0.04, 5]} />
        <meshStandardMaterial color="#374151" metalness={0.7} />
      </mesh>
    </group>
  );
}
