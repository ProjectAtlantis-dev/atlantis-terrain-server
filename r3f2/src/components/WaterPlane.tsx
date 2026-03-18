import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { WATER_EXTENT } from '@/utils/constants';
import { useControlsStore } from '@/stores/controlsStore';

// Water shader matching the original main.terrain.js water system
const waterVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv * 400.0;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const waterFragmentShader = /* glsl */ `
  uniform float time;
  uniform vec3 sunDirection;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  // Simple wave normal
  vec3 waveNormal(vec2 uv, float t) {
    float s1 = sin(uv.x * 0.7 + t * 1.2) * 0.3;
    float s2 = sin(uv.y * 0.9 + t * 0.8) * 0.25;
    float s3 = sin((uv.x + uv.y) * 1.3 + t * 1.5) * 0.15;
    float s4 = sin((uv.x - uv.y) * 2.1 + t * 2.0) * 0.1;
    float dx = cos(uv.x * 0.7 + t * 1.2) * 0.7 * 0.3
             + cos((uv.x + uv.y) * 1.3 + t * 1.5) * 1.3 * 0.15
             + cos((uv.x - uv.y) * 2.1 + t * 2.0) * 2.1 * 0.1;
    float dy = cos(uv.y * 0.9 + t * 0.8) * 0.9 * 0.25
             + cos((uv.x + uv.y) * 1.3 + t * 1.5) * 1.3 * 0.15
             - cos((uv.x - uv.y) * 2.1 + t * 2.0) * 2.1 * 0.1;
    return normalize(vec3(-dx * 0.02, -dy * 0.02, 1.0));
  }

  void main() {
    vec3 n = waveNormal(vUv, time);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);

    vec3 deepColor = vec3(0.02, 0.06, 0.14);
    vec3 shallowColor = vec3(0.05, 0.15, 0.25);
    vec3 baseColor = mix(deepColor, shallowColor, fresnel * 0.5);

    // Diffuse ripple
    float diffuse = max(dot(n, normalize(sunDirection)), 0.0) * 0.15;
    baseColor += diffuse;

    // Sun specular
    vec3 halfVec = normalize(viewDir + normalize(sunDirection));
    float spec = pow(max(dot(n, halfVec), 0.0), 120.0) * 0.5;
    baseColor += vec3(spec);

    gl_FragColor = vec4(baseColor, 0.92);
  }
`;

/**
 * Water plane at Z=0.5 in terrainRoot-local space.
 * 200km x 200km plane with animated wave normals.
 */
export function WaterPlane() {
  const meshRef = useRef<THREE.Mesh>(null);
  const mapMode = useControlsStore((s) => s.mapMode);

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: waterVertexShader,
      fragmentShader: waterFragmentShader,
      uniforms: {
        time: { value: 0 },
        sunDirection: { value: new THREE.Vector3(0.5, 0.3, 0.8) },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }, []);

  useFrame((_, delta) => {
    material.uniforms.time.value += delta * 0.4;
  });

  return (
    <mesh
      ref={meshRef}
      position={[0, 0, 0.5]}
      rotation={[0, 0, 0]}
      visible={!mapMode}
      renderOrder={-1}
    >
      <planeGeometry args={[WATER_EXTENT, WATER_EXTENT]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
