import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Stars, Float, Sparkles } from '@react-three/drei';

function MovingStars() {
  const starsRef = useRef();
  useFrame(({ clock }) => {
    if (starsRef.current) {
      starsRef.current.rotation.y = clock.getElapsedTime() * 0.05;
      starsRef.current.rotation.x = clock.getElapsedTime() * 0.02;
    }
  });
  return <Stars ref={starsRef} radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />;
}

function FloatingNodes() {
  const groupRef = useRef();
  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.position.y = Math.sin(clock.getElapsedTime()) * 2;
    }
  });
  
  return (
    <group ref={groupRef}>
      {[...Array(15)].map((_, i) => (
        <Float key={i} speed={2} rotationIntensity={1} floatIntensity={2} position={[(Math.random() - 0.5) * 50, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 30 - 10]}>
          <mesh>
            <boxGeometry args={[1, 2, 1]} />
            <meshStandardMaterial color="#38bdf8" wireframe opacity={0.3} transparent />
          </mesh>
        </Float>
      ))}
    </group>
  );
}

export default function Background3D() {
  return (
    <div className="fixed inset-0 z-[-1] bg-slate-950">
      <Canvas camera={{ position: [0, 0, 15], fov: 60 }}>
        <color attach="background" args={['#020617']} />
        <ambientLight intensity={0.2} />
        <directionalLight position={[10, 10, 5]} intensity={1} color="#6366f1" />
        <pointLight position={[-10, -10, -10]} intensity={0.5} color="#38bdf8" />
        
        <MovingStars />
        <FloatingNodes />
        <Sparkles count={200} scale={30} size={4} speed={0.4} opacity={0.5} color="#e0e7ff" />
      </Canvas>
    </div>
  );
}
