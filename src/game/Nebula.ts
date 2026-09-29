import { BackSide, Mesh, ShaderMaterial, SphereGeometry } from 'three';
import type { Camera } from 'three';

/**
 * Procedural nebula on a sky sphere that follows the camera, so it works for both the
 * top-down view and the first-person cockpit. Scrolls slowly to add depth behind the stars.
 */
export class Nebula {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private scroll = 0;

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: { uScroll: { value: 0 }, uIntensity: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uScroll;
        uniform float uIntensity;
        varying vec3 vDir;

        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float noise(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
        }
        float fbm(vec3 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p = p * 2.03 + vec3(1.7, 9.2, 3.1);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 d = normalize(vDir);
          vec3 p = d * 2.4 + vec3(0.0, uScroll, 0.0);
          float n = fbm(p);
          float n2 = fbm(p * 1.8 + vec3(4.0, 0.0, 2.0) + n * 1.5);
          vec3 color = vec3(0.008, 0.01, 0.03);
          color += vec3(0.32, 0.06, 0.42) * smoothstep(0.42, 0.85, n) * 0.75;
          color += vec3(0.03, 0.22, 0.48) * smoothstep(0.38, 0.9, n2) * 0.65;
          color += vec3(1.0, 0.55, 0.35) * pow(smoothstep(0.55, 0.95, n * n2 * 1.7), 3.0) * 0.45;
          gl_FragColor = vec4(color * uIntensity, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: BackSide,
      depthWrite: false,
    });
    this.mesh = new Mesh(new SphereGeometry(150, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  update(dt: number, camera: Camera, speed: number): void {
    this.scroll += dt * speed * 0.004;
    this.material.uniforms.uScroll!.value = this.scroll;
    this.mesh.position.copy(camera.position);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
