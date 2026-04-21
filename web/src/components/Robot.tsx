"use client";

import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { MeshWobbleMaterial, RoundedBox } from "@react-three/drei";
import * as THREE from "three";

export type RobotDef = {
  name: string;
  color: string;       // body / limb color
  eyeColor: string;    // emissive eye color
  personality: string; // shown in UI
  voiceId: string;     // ElevenLabs voice ID (Phase 4)
};

export const ROBOTS: RobotDef[] = [
  { name: "ARIA",  color: "#2563eb", eyeColor: "#93c5fd", personality: "Friendly & Helpful",   voiceId: "21m00Tcm4TlvDq8ikWAM" },
  { name: "MAX",   color: "#16a34a", eyeColor: "#86efac", personality: "Fast & Precise",        voiceId: "AZnzlk1XvdvUeBnXmlld"  },
  { name: "ZED",   color: "#7c3aed", eyeColor: "#c4b5fd", personality: "Calm & Analytical",    voiceId: "EXAVITQu4vr4xnSDxMaL"  },
];

type Props = {
  def: RobotDef;
  position: [number, number, number];
  onClick: () => void;
};

export function Robot({ def, position, onClick }: Props) {
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

    // Idle bob
    groupRef.current.position.y = position[1] + Math.sin(t * 1.2) * 0.06;

    // Head gentle sway
    if (headRef.current) {
      headRef.current.rotation.y = Math.sin(t * 0.8) * (hovered ? 0.3 : 0.1);
      headRef.current.rotation.z = Math.sin(t * 0.5) * 0.04;
    }

    // Walk cycle (arms + legs swing opposite)
    const swing = Math.sin(t * 2.0) * 0.35;
    if (lArmRef.current) lArmRef.current.rotation.x =  swing;
    if (rArmRef.current) rArmRef.current.rotation.x = -swing;
    if (lLegRef.current) lLegRef.current.rotation.x = -swing * 0.7;
    if (rLegRef.current) rLegRef.current.rotation.x =  swing * 0.7;

    // Hover: lean forward slightly
    groupRef.current.rotation.x = hovered
      ? THREE.MathUtils.lerp(groupRef.current.rotation.x, -0.08, 0.1)
      : THREE.MathUtils.lerp(groupRef.current.rotation.x,  0,    0.1);
  });

  const mat = (color: THREE.Color, emissive = false) => (
    <meshStandardMaterial
      color={color}
      roughness={0.3}
      metalness={0.6}
      emissive={emissive ? eyeColor : undefined}
      emissiveIntensity={emissive ? 1.5 : 0}
    />
  );

  return (
    <group
      ref={groupRef}
      position={position}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onPointerEnter={() => { setHovered(true);  document.body.style.cursor = "pointer"; }}
      onPointerLeave={() => { setHovered(false); document.body.style.cursor = "default"; }}
    >
      {/* Torso */}
      <RoundedBox args={[0.75, 0.95, 0.45]} radius={0.06} position={[0, 0, 0]}>
        {mat(hovered ? lightColor : bodyColor)}
      </RoundedBox>

      {/* Chest panel */}
      <RoundedBox args={[0.4, 0.35, 0.05]} radius={0.04} position={[0, 0.05, 0.23]}>
        <meshStandardMaterial color={darkColor} roughness={0.2} metalness={0.8} />
      </RoundedBox>

      {/* Head */}
      <group ref={headRef} position={[0, 0.8, 0]}>
        <RoundedBox args={[0.62, 0.58, 0.52]} radius={0.1}>
          {mat(hovered ? lightColor : bodyColor)}
        </RoundedBox>
        {/* Eyes */}
        {[-0.16, 0.16].map((x, i) => (
          <mesh key={i} position={[x, 0.05, 0.27]}>
            <sphereGeometry args={[0.08, 16, 16]} />
            <meshStandardMaterial color={eyeColor} emissive={eyeColor} emissiveIntensity={hovered ? 3 : 1.5} />
          </mesh>
        ))}
        {/* Mouth */}
        <RoundedBox args={[0.28, 0.05, 0.04]} radius={0.02} position={[0, -0.14, 0.27]}>
          <meshStandardMaterial color={eyeColor} emissive={eyeColor} emissiveIntensity={0.8} />
        </RoundedBox>
        {/* Antenna */}
        <mesh position={[0, 0.38, 0]}>
          <cylinderGeometry args={[0.03, 0.03, 0.25, 8]} />
          <meshStandardMaterial color={darkColor} metalness={0.9} roughness={0.1} />
        </mesh>
        <mesh position={[0, 0.52, 0]}>
          <sphereGeometry args={[0.07, 12, 12]} />
          <meshStandardMaterial color={eyeColor} emissive={eyeColor} emissiveIntensity={2} />
        </mesh>
      </group>

      {/* Left arm */}
      <group ref={lArmRef} position={[-0.52, 0.15, 0]}>
        <mesh position={[0, -0.3, 0]}>
          <boxGeometry args={[0.22, 0.65, 0.22]} />
          {mat(darkColor)}
        </mesh>
        {/* Hand */}
        <mesh position={[0, -0.68, 0]}>
          <sphereGeometry args={[0.14, 10, 10]} />
          {mat(bodyColor)}
        </mesh>
      </group>

      {/* Right arm */}
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

      {/* Left leg */}
      <group ref={lLegRef} position={[-0.2, -0.72, 0]}>
        <mesh position={[0, -0.3, 0]}>
          <boxGeometry args={[0.25, 0.65, 0.28]} />
          {mat(darkColor)}
        </mesh>
        {/* Foot */}
        <RoundedBox args={[0.3, 0.14, 0.38]} radius={0.06} position={[0, -0.65, 0.05]}>
          {mat(bodyColor)}
        </RoundedBox>
      </group>

      {/* Right leg */}
      <group ref={rLegRef} position={[0.2, -0.72, 0]}>
        <mesh position={[0, -0.3, 0]}>
          <boxGeometry args={[0.25, 0.65, 0.28]} />
          {mat(darkColor)}
        </mesh>
        <RoundedBox args={[0.3, 0.14, 0.38]} radius={0.06} position={[0, -0.65, 0.05]}>
          {mat(bodyColor)}
        </RoundedBox>
      </group>

      {/* Shadow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.46, 0]}>
        <circleGeometry args={[0.5, 32]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.15} />
      </mesh>
    </group>
  );
}
