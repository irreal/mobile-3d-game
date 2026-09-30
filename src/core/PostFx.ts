import { HalfFloatType, MathUtils, Vector2, WebGLRenderTarget } from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export type FxQuality = 'high' | 'low';

const STORAGE_KEY = 'nova-strike:fx';
const MAX_SHOCKWAVES = 3;

/**
 * Final full-screen pass, in linear HDR before tone mapping:
 * shockwave ripples → zoom (radial) blur with chromatic aberration → Focus tint → vignette → grain.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uZoomBlur: { value: 0 },
    uAberration: { value: 0 },
    uFocus: { value: 0 },
    uVignette: { value: 0.35 },
    uShock: { value: Array.from({ length: MAX_SHOCKWAVES }, () => new Vector2()) },
    uShockState: { value: Array.from({ length: MAX_SHOCKWAVES }, () => new Vector2()) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    #define MAX_SHOCKWAVES ${MAX_SHOCKWAVES}
    #define BLUR_TAPS 10
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    uniform float uZoomBlur;
    uniform float uAberration;
    uniform float uFocus;
    uniform float uVignette;
    uniform vec2 uShock[MAX_SHOCKWAVES];
    /** x: radius (uv units), y: strength (0 = inactive). */
    uniform vec2 uShockState[MAX_SHOCKWAVES];
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;

      for (int i = 0; i < MAX_SHOCKWAVES; i++) {
        float strength = uShockState[i].y;
        if (strength <= 0.0) continue;
        vec2 d = uv - uShock[i];
        d.x *= uAspect;
        float dist = length(d);
        float ring = dist - uShockState[i].x;
        float wave = exp(-ring * ring * 900.0) * strength;
        uv -= normalize(d + 1e-5) * wave * 0.035 * vec2(1.0 / uAspect, 1.0);
      }

      vec2 toCenter = uv - 0.5;
      float edge = dot(toCenter, toCenter);
      vec2 ca = toCenter * (uAberration * 0.018 + edge * 0.004);
      vec3 color;
      if (uZoomBlur > 0.001) {
        color = vec3(0.0);
        float jitter = hash(uv * 311.0 + uTime);
        for (int i = 0; i < BLUR_TAPS; i++) {
          float t = (float(i) + jitter) / float(BLUR_TAPS);
          vec2 offset = toCenter * uZoomBlur * t * 0.22;
          color.r += texture2D(tDiffuse, uv - offset - ca).r;
          color.g += texture2D(tDiffuse, uv - offset).g;
          color.b += texture2D(tDiffuse, uv - offset + ca).b;
        }
        color /= float(BLUR_TAPS);
      } else {
        color.r = texture2D(tDiffuse, uv - ca).r;
        color.g = texture2D(tDiffuse, uv).g;
        color.b = texture2D(tDiffuse, uv + ca).b;
      }

      float luma = dot(color, vec3(0.299, 0.587, 0.114));
      vec3 focusTint = vec3(luma) * vec3(0.75, 0.95, 1.3);
      color = mix(color, focusTint, uFocus * 0.55);

      float vignette = smoothstep(0.85, 0.2, length(toCenter * vec2(uAspect, 1.0) / max(uAspect, 1.0)));
      color *= mix(1.0, vignette, uVignette + uFocus * 0.35);

      color += (hash(vUv * 997.0 + fract(uTime)) - 0.5) * 0.025;
      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

interface Shockwave {
  x: number;
  y: number;
  age: number;
  strength: number;
}

/**
 * Post-processing: bloom plus a custom final pass. Scenes drive it through `kick`-style
 * setters (zoom blur, aberration, shockwaves); "low" quality renders straight to the canvas.
 */
export class PostFx {
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly final: ShaderPass;
  private readonly shockwaves: Shockwave[] = [];
  private aberrationKick = 0;
  private time = 0;
  private readonly qualityListeners = new Set<(q: FxQuality) => void>();
  /** Continuous values set by the scene each frame. */
  zoomBlur = 0;
  aberration = 0;
  focus = 0;
  quality: FxQuality = loadQuality();

  constructor(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.35, 0.3, 0.95);
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
    this.composer.addPass(new OutputPass());
  }

  get enabled(): boolean {
    return this.quality === 'high';
  }

  setScene(scene: Scene, camera: Camera): void {
    const pass = this.composer.passes[0] as RenderPass;
    pass.scene = scene;
    pass.camera = camera;
  }

  setQuality(quality: FxQuality): void {
    this.quality = quality;
    try {
      localStorage.setItem(STORAGE_KEY, quality);
    } catch {
      // Not persisted; fine.
    }
    this.qualityListeners.forEach((fn) => fn(quality));
  }

  onQualityChange(listener: (q: FxQuality) => void): void {
    this.qualityListeners.add(listener);
  }

  /** Brief chromatic-aberration hit, 0..1. */
  kickAberration(amount: number): void {
    if (!Number.isFinite(amount)) return;
    this.aberrationKick = Math.min(1.5, Math.max(this.aberrationKick, amount));
  }

  /** Expanding ripple at screen position (0..1 UV, y up). */
  shockwave(x: number, y: number, strength = 1): void {
    // A NaN here (e.g. projecting a point at the camera) would turn the whole frame black.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(strength)) return;
    if (this.shockwaves.length >= MAX_SHOCKWAVES) this.shockwaves.shift();
    this.shockwaves.push({ x, y, age: 0, strength });
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    // Bloom at reduced resolution: it's blurry anyway, and fill rate matters on phones.
    this.bloom.setSize(Math.round(width * pixelRatio * 0.5), Math.round(height * pixelRatio * 0.5));
    this.final.uniforms.uAspect!.value = width / height;
  }

  render(dt: number): void {
    this.time += dt;
    this.aberrationKick = Math.max(0, this.aberrationKick - dt * 2.5);
    const u = this.final.uniforms;
    u.uTime!.value = this.time;
    u.uZoomBlur!.value = MathUtils.clamp(this.zoomBlur, 0, 1);
    u.uAberration!.value = this.aberration + this.aberrationKick;
    u.uFocus!.value = this.focus;

    const centers = u.uShock!.value as Vector2[];
    const states = u.uShockState!.value as Vector2[];
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i]!;
      s.age += dt;
      if (s.age > 0.9) this.shockwaves.splice(i, 1);
    }
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const s = this.shockwaves[i];
      if (!s) {
        states[i]!.set(0, 0);
        continue;
      }
      centers[i]!.set(s.x, s.y);
      states[i]!.set(s.age * 0.75, s.strength * (1 - s.age / 0.9));
    }
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
  }
}

function loadQuality(): FxQuality {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'high' || stored === 'low') return stored;
  } catch {
    // Fall through to the default.
  }
  return 'high';
}
