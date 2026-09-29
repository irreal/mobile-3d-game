import { AdditiveBlending, PlaneGeometry, ShaderMaterial } from 'three';

/** Unit quad for camera-facing glow sprites; the shader turns it toward the camera. */
export const glowGeometry = new PlaneGeometry(1, 1);

export interface GlowOptions {
  /** Sprite diameter in world units at scale 1. */
  size?: number;
  /** Brightness multiplier; values above 1 feed the bloom pass. */
  intensity?: number;
  /** Size of the hot white-ish center, 0..1 of the radius. */
  core?: number;
  color?: [number, number, number];
}

/**
 * Soft additive glow that always faces the camera, so the same particles work in both the
 * top-down view and the first-person cockpit. Works on plain meshes and InstancedMesh
 * (per-instance color via `instanceColor`).
 */
export function createGlowMaterial({ size = 1, intensity = 1, core = 0.3, color = [1, 1, 1] }: GlowOptions = {}) {
  return new ShaderMaterial({
    uniforms: {
      uSize: { value: size },
      uIntensity: { value: intensity },
      uCore: { value: core },
      uColor: { value: color },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vUv = uv;
        #ifdef USE_INSTANCING
          mat4 m = modelViewMatrix * instanceMatrix;
        #else
          mat4 m = modelViewMatrix;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor * uColor;
        #else
          vColor = uColor;
        #endif
        vec4 center = m * vec4(0.0, 0.0, 0.0, 1.0);
        float scale = length(m[0].xyz) * uSize;
        center.xy += position.xy * scale;
        gl_Position = projectionMatrix * center;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      uniform float uCore;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        if (d > 1.0) discard;
        float halo = pow(1.0 - d, 2.2);
        float hot = smoothstep(uCore, 0.0, d);
        vec3 color = vColor * halo + mix(vColor, vec3(1.0), 0.6) * hot * 1.4;
        gl_FragColor = vec4(color * uIntensity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}
