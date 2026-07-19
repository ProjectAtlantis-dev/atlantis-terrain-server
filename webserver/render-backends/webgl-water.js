import * as THREE from 'three';

export function createWebGLWater({ extent }) {
  const normalTexture = new THREE.TextureLoader().load('/waternormals.jpg', texture => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  });
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      normalSampler: { value: normalTexture },
      waterColor: { value: new THREE.Color(0x001e3d) },
      sunDirection: { value: new THREE.Vector3(0.7, 0.7, 0.3) },
      sunColor: { value: new THREE.Color(0xffffff) },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vLocalPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vLocalPos = position.xy * 0.002;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float time;
      uniform sampler2D normalSampler;
      uniform vec3 waterColor;
      uniform vec3 sunDirection;
      uniform vec3 sunColor;
      varying vec2 vLocalPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      vec4 getNoise(vec2 uv) {
        vec2 uv0 = uv / 1.3 + vec2(time / 17.0, time / 29.0);
        vec2 uv1 = uv / 1.5 - vec2(time / -19.0, time / 31.0);
        vec2 uv2 = uv / 3.7 + vec2(time / 101.0, time / 97.0);
        vec2 uv3 = uv / 2.1 - vec2(time / 109.0, time / -113.0);
        return (texture2D(normalSampler, uv0) + texture2D(normalSampler, uv1) +
                texture2D(normalSampler, uv2) + texture2D(normalSampler, uv3)) * 0.5 - 1.0;
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec4 noise = getNoise(vLocalPos);
        vec3 surfNormal = normalize(mix(vWorldNormal, normalize(noise.xzy), 0.45));
        vec3 toEye = normalize(cameraPosition - vWorldPos);
        vec3 sunDir = normalize(sunDirection);
        float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(toEye, surfNormal), 0.0), 4.0);
        float diffuse = max(dot(surfNormal, sunDir), 0.0);
        vec3 rippleColor = waterColor * (0.6 + 0.4 * diffuse);
        vec3 refl = reflect(-sunDir, surfNormal);
        float spec = pow(max(dot(toEye, refl), 0.0), 80.0) * 2.0;
        vec3 col = rippleColor + sunColor * spec * 0.6;
        float alpha = clamp(fresnel * 0.35 + spec * 0.7 + 0.12, 0.0, 0.55);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    side: THREE.FrontSide,
    depthWrite: false,
  });
  const geometry = new THREE.PlaneGeometry(extent * 2, extent * 2, 1, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, 0, 0.5);
  mesh.frustumCulled = false;
  mesh.visible = false;

  return {
    mesh,
    update(elapsedTime, sunDirection, visible) {
      material.uniforms.time.value = elapsedTime * 0.4;
      material.uniforms.sunDirection.value.copy(sunDirection);
      mesh.visible = visible;
    },
    dispose() {
      normalTexture.dispose();
      material.dispose();
      geometry.dispose();
    },
  };
}
