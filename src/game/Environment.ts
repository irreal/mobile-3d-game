import {
  BackSide,
  CanvasTexture,
  Color,
  Group,
  MathUtils,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  Vector4,
} from 'three';
import type { Camera, Texture } from 'three';
import { Planet } from './Planet.ts';

export type EnvironmentId = 'space' | 'desert' | 'ocean' | 'lava';

/** Environment per pair of waves (a cockpit strike ends each pair); cycles after the last. */
const ORDER: readonly EnvironmentId[] = ['space', 'desert', 'space', 'ocean', 'space', 'lava'];

const pairOf = (wave: number): number => Math.floor(Math.max(0, wave - 1) / 2);

export function environmentForWave(wave: number): EnvironmentId {
  return ORDER[pairOf(wave) % ORDER.length]!;
}

/** The next planet the ship will reach from `wave` on (the current one if already there). */
export function upcomingPlanet(wave: number): Exclude<EnvironmentId, 'space'> {
  const pair = pairOf(wave);
  for (let i = 0; i < ORDER.length; i++) {
    const id = ORDER[(pair + i) % ORDER.length]!;
    if (id !== 'space') return id;
  }
  return 'desert';
}

interface Palette {
  name: string;
  skyTop: number;
  skyHorizon: number;
  fog: number;
  sun: number;
  low: number;
  mid: number;
  high: number;
  /** Colour of the flat "sea" filling everything below `seaLevel` (water or lava). */
  sea: number;
  /** 0..1 height of the sea; -1 for none. */
  seaLevel: number;
  /** Emissive strength of the sea (lava glows). */
  seaGlow: number;
  /** 0 = rolling fbm, 1 = sharp ridges. */
  ridge: number;
  /** 0..1 mesa-style terracing. */
  terrace: number;
  /** Height range in world units. */
  amplitude: number;
  /** Feature size (higher = smaller features). */
  frequency: number;
  /** Wind ripples on flat ground (sand). */
  dunes: number;
  cloud: number;
  cloudOpacity: number;
  /** Tint for the entry veil (clouds / heat). */
  veil: string;
}

const PALETTES: Record<Exclude<EnvironmentId, 'space'>, Palette> = {
  desert: {
    name: 'KHARAN · DESERT WORLD',
    skyTop: 0x3a2a5e,
    skyHorizon: 0xf2a86b,
    fog: 0xd9956a,
    sun: 0xfff0c8,
    low: 0x6a321e,
    mid: 0xc27a45,
    high: 0xf4c890,
    sea: 0x000000,
    seaLevel: -1,
    seaGlow: 0,
    ridge: 0.35,
    terrace: 0.75,
    amplitude: 9,
    frequency: 0.045,
    dunes: 1,
    cloud: 0xf3c9a0,
    cloudOpacity: 0.16,
    veil: '255 214 170',
  },
  ocean: {
    name: 'THALASSA · OCEAN WORLD',
    skyTop: 0x1d4f9c,
    skyHorizon: 0x9fd4ff,
    fog: 0xa8d0f0,
    sun: 0xffffff,
    low: 0xd9c89a,
    mid: 0x3f8f4a,
    high: 0x2a5e37,
    sea: 0x0f4f86,
    seaLevel: 0.46,
    seaGlow: 0,
    ridge: 0.15,
    terrace: 0,
    amplitude: 8,
    frequency: 0.05,
    dunes: 0,
    cloud: 0xffffff,
    cloudOpacity: 0.42,
    veil: '240 248 255',
  },
  lava: {
    name: 'VULCAN · MOLTEN WORLD',
    skyTop: 0x12060c,
    skyHorizon: 0x7a2412,
    fog: 0x4a1a12,
    sun: 0xff9a5a,
    low: 0x1a1214,
    mid: 0x2e2226,
    high: 0x524048,
    sea: 0xd8400c,
    seaLevel: 0.32,
    seaGlow: 0.8,
    ridge: 0.85,
    terrace: 0,
    amplitude: 11,
    frequency: 0.045,
    dunes: 0,
    cloud: 0x3a2622,
    cloudOpacity: 0.5,
    veil: '255 120 50',
  },
};

/** Terrain sits this far below the play plane; peaks stay well under the ships. */
const TERRAIN_Z = -15;
const TERRAIN_WIDTH = 220;
const TERRAIN_LENGTH = 240;
/** Terrain spans from this far behind the camera's origin to the far plane. */
const TERRAIN_BACK = 45;
const CLOUD_COUNT = 24;
const CLOUD_Y_MIN = -40;
const CLOUD_Y_MAX = 170;

const NOISE_GLSL = /* glsl */ `
  float hash2(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise2(p);
      p = p * 2.07 + vec2(3.1, 1.7);
      a *= 0.5;
    }
    return v / 0.9375;
  }
`;

const TERRAIN_VERTEX = /* glsl */ `
  uniform float uScroll;
  uniform float uFrequency;
  uniform float uAmplitude;
  uniform float uRidge;
  uniform float uTerrace;
  uniform float uSeaLevel;
  /** Flattened clearing: terrain-space centre (xy), radius (z), 1 if active (w). */
  uniform vec4 uClear;
  uniform float uClearHeight;
  varying float vHeight;
  varying float vSlope;
  varying vec3 vWorld;
  varying vec3 vNormal;
  ${NOISE_GLSL}

  float heightAt(vec2 p) {
    vec2 q = p * uFrequency;
    float n = fbm2(q);
    float r = 1.0 - abs(2.0 * fbm2(q * 0.8 + vec2(7.3, 2.1)) - 1.0);
    float h = mix(n, r * r, uRidge);
    // Mesas: flatten into steps with steep sides.
    float steps = 5.0;
    float s = h * steps;
    float terraced = (floor(s) + smoothstep(0.75, 1.0, fract(s))) / steps;
    h = mix(h, terraced, uTerrace);
    // A winding valley along the flight path keeps the view down the middle open.
    float valley = smoothstep(0.0, 26.0, abs(p.x - sin(p.y * 0.018) * 14.0));
    h *= mix(0.6, 1.0, valley);
    if (uClear.w > 0.0) {
      float d = length(p - uClear.xy);
      h = mix(uClearHeight, h, smoothstep(uClear.z * 0.75, uClear.z * 1.25, d));
    }
    return h;
  }

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec2 p = vec2(world.x, world.y + uScroll);
    float h = heightAt(p);
    float e = 1.5;
    float hx = heightAt(p + vec2(e, 0.0));
    float hy = heightAt(p + vec2(0.0, e));
    float sea = uSeaLevel < 0.0 ? -1.0 : uSeaLevel;
    vHeight = h;
    float shown = max(h, sea);
    world.z += shown * uAmplitude;
    vec3 n = normalize(vec3((h - hx) * uAmplitude / e, (h - hy) * uAmplitude / e, 1.0));
    vNormal = h < sea ? vec3(0.0, 0.0, 1.0) : n;
    vSlope = 1.0 - vNormal.z;
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const TERRAIN_FRAGMENT = /* glsl */ `
  uniform vec3 uLow;
  uniform vec3 uMid;
  uniform vec3 uHigh;
  uniform vec3 uSea;
  uniform float uSeaLevel;
  uniform float uSeaGlow;
  uniform vec3 uFog;
  uniform vec3 uSun;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uScroll;
  uniform float uDunes;
  varying float vHeight;
  varying float vSlope;
  varying vec3 vWorld;
  varying vec3 vNormal;
  ${NOISE_GLSL}

  const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);

  void main() {
    vec2 p = vec2(vWorld.x, vWorld.y + uScroll);
    // Per-pixel detail on top of the mesh height, so coastlines and colour bands aren't polygonal.
    float h = vHeight + (noise2(ROT * p * 0.22) - 0.5) * 0.08 + (noise2(p * 0.7) - 0.5) * 0.03;
    vec3 color = mix(uLow, uMid, smoothstep(0.2, 0.55, h));
    color = mix(color, uHigh, smoothstep(0.55, 0.85, h));
    // Steep faces read as darker rock; fine grain breaks up flat colour.
    color *= mix(1.0, 0.55, smoothstep(0.15, 0.6, vSlope));
    color *= 0.8 + 0.4 * noise2(ROT * p * 0.5);
    color *= 1.0 + uDunes * 0.18 * sin(p.y * 0.9 + p.x * 0.2 + noise2(p * 0.08) * 7.0) * (1.0 - smoothstep(0.05, 0.25, vSlope));
    float light = 0.3 + 0.95 * max(dot(vNormal, uSunDir), 0.0);
    color *= light * uSun;
    vec3 emissive = vec3(0.0);

    if (uSeaLevel >= 0.0) {
      float under = smoothstep(uSeaLevel + 0.01, uSeaLevel - 0.01, h);
      vec2 q = ROT * p;
      float ripple = 0.6 * noise2(q * 0.3 + vec2(uTime * 0.5, uTime * 0.2)) + 0.4 * noise2(ROT * q * 0.8 - vec2(uTime * 0.3, 0.0));
      vec3 sea = uSea * (0.75 + 0.5 * ripple);
      if (uSeaGlow > 0.0) {
        // Molten: dark crust with glowing cracks, and a hot rim where rock meets lava.
        float cracks = smoothstep(0.52, 0.62, ripple) * (1.0 - smoothstep(0.62, 0.8, ripple));
        sea = uSea * mix(0.18, 0.6, ripple) + uSea * cracks * 1.4;
        emissive += uSea * uSeaGlow * (smoothstep(uSeaLevel + 0.06, uSeaLevel, h) * 0.6 + cracks * under);
      } else {
        sea += vec3(0.9) * pow(ripple, 6.0) * 2.0;
        // Shallows and surf where water meets land.
        sea = mix(sea, sea * 1.6 + vec3(0.05, 0.12, 0.1), smoothstep(uSeaLevel - 0.08, uSeaLevel, h));
        sea = mix(sea, vec3(0.85, 0.95, 1.0), smoothstep(uSeaLevel - 0.02, uSeaLevel, h) * 0.8);
      }
      color = mix(color, sea, under);
    }

    float dist = length(vWorld - cameraPosition);
    float fog = 1.0 - exp(-pow(dist * 0.0085, 1.6));
    fog = max(fog, smoothstep(120.0, 175.0, dist));
    color = mix(color + emissive, uFog, fog);
    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uFog;
  uniform vec3 uSun;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 color = mix(uHorizon, uTop, smoothstep(0.0, 0.55, d.z));
    color = mix(uFog, color, smoothstep(-0.08, 0.04, d.z));
    float s = max(dot(d, uSunDir), 0.0);
    color += uSun * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.25);
    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function cloudTexture(): Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // A few overlapping soft blobs make a puff rather than a perfect disc.
  const blobs = [
    [0.5, 0.55, 0.42],
    [0.33, 0.5, 0.28],
    [0.68, 0.48, 0.3],
    [0.5, 0.38, 0.28],
  ] as const;
  for (const [x, y, r] of blobs) {
    const g = ctx.createRadialGradient(x * size, y * size, 0, x * size, y * size, r * size);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

interface Cloud {
  sprite: Sprite;
  speed: number;
}

/** After leaving a planet it shrinks away behind the ship over this long. */
const DEPART_SECONDS = 12;
/** Planet size at which the ship hits the atmosphere (fills the view). */
const ENTRY_SIZE = 1.6;
/** Terrain scrolls at this fraction of the play-plane speed (it's far below). */
export const TERRAIN_SCROLL_RATE = 0.6;
/** Top-down screen height of the approaching planet (view-direction tangent): enters from above the top edge. */
const APPROACH_SCREEN_START = 0.8;
const APPROACH_SCREEN_END = 0.1;

/**
 * Backdrop for each stretch of the game: deep space (the nebula and stars owned by the
 * scene) or a planet flown low over: sky dome, scrolling procedural terrain (optional sea
 * of water or lava), drifting clouds. Changes blend over a few seconds, through a cloud or
 * heat veil when entering or leaving an atmosphere.
 */
export class Environment {
  readonly object = new Group();
  /** 0 in space, 1 fully inside a planet's atmosphere. */
  atmosphere = 0;
  /** 0..1 re-entry heat (for camera shake). */
  heat = 0;
  private readonly world = new Group();
  private readonly planet: Planet;
  private planetLook: EnvironmentId | null = null;
  private planetSize = 0;
  private planetFade = 1;
  private entryFrom = 0;
  private upcoming: Exclude<EnvironmentId, 'space'> = 'desert';
  private approach = 0;
  private departed: Exclude<EnvironmentId, 'space'> | null = null;
  private departTime = Infinity;
  private readonly terrain: Mesh;
  private readonly terrainMaterial: ShaderMaterial;
  private readonly sky: Mesh;
  private readonly skyMaterial: ShaderMaterial;
  private readonly cloudMaterial: SpriteMaterial;
  private readonly clouds: Cloud[] = [];
  private readonly veil: HTMLDivElement;
  private current: EnvironmentId = 'space';
  private target: EnvironmentId = 'space';
  /** Palette shown on the terrain (kept while fading out to space). */
  private palette: Palette | null = null;
  private progress = 1;
  private duration = 1;
  private scroll = 0;
  private time = 0;
  private cloudOpacity = 0;

  constructor(container: HTMLElement) {
    const sunDir = new Vector3(-0.55, 0.65, 0.4).normalize();
    this.terrainMaterial = new ShaderMaterial({
      uniforms: {
        uScroll: { value: 0 },
        uTime: { value: 0 },
        uFrequency: { value: 0.02 },
        uAmplitude: { value: 8 },
        uRidge: { value: 0 },
        uTerrace: { value: 0 },
        uSeaLevel: { value: -1 },
        uClear: { value: new Vector4() },
        uClearHeight: { value: 0.3 },
        uSeaGlow: { value: 0 },
        uDunes: { value: 0 },
        uLow: { value: new Color() },
        uMid: { value: new Color() },
        uHigh: { value: new Color() },
        uSea: { value: new Color() },
        uFog: { value: new Color() },
        uSun: { value: new Color() },
        uSunDir: { value: sunDir },
        uOpacity: { value: 0 },
      },
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
      transparent: true,
    });
    const geometry = new PlaneGeometry(TERRAIN_WIDTH, TERRAIN_LENGTH, 110, 120);
    geometry.translate(0, TERRAIN_LENGTH / 2 - TERRAIN_BACK, TERRAIN_Z);
    this.terrain = new Mesh(geometry, this.terrainMaterial);
    this.terrain.frustumCulled = false;
    this.terrain.renderOrder = -5;

    this.skyMaterial = new ShaderMaterial({
      uniforms: {
        uTop: { value: new Color() },
        uHorizon: { value: new Color() },
        uFog: { value: new Color() },
        uSun: { value: new Color() },
        uSunDir: { value: sunDir },
        uOpacity: { value: 0 },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: BackSide,
      transparent: true,
      depthWrite: false,
    });
    this.sky = new Mesh(new SphereGeometry(140, 32, 16), this.skyMaterial);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -9;

    this.cloudMaterial = new SpriteMaterial({ map: cloudTexture(), transparent: true, depthWrite: false, opacity: 0 });
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const sprite = new Sprite(this.cloudMaterial);
      this.placeCloud(sprite, MathUtils.randFloat(CLOUD_Y_MIN, CLOUD_Y_MAX));
      this.clouds.push({ sprite, speed: MathUtils.randFloat(0.8, 1.2) });
      this.world.add(sprite);
    }
    this.world.add(this.sky, this.terrain);
    this.world.visible = false;
    this.planet = new Planet(new Vector3(-0.6, -0.3, 0.75).normalize());
    this.object.add(this.world, this.planet.object);

    this.veil = document.createElement('div');
    this.veil.className = 'env-veil';
    container.querySelector('.hud')?.before(this.veil);
  }

  get id(): EnvironmentId {
    return this.target;
  }

  /** Display name of a planet (empty in space). */
  nameOf(id: EnvironmentId): string {
    return id === 'space' ? '' : PALETTES[id].name;
  }

  /** Switches immediately (new game, test jumps). */
  set(id: EnvironmentId): void {
    this.current = this.target = id;
    this.progress = 1;
    if (id !== 'space') {
      this.palette = PALETTES[id];
      this.applyPalette();
    }
    this.atmosphere = id === 'space' ? 0 : 1;
    this.departed = null;
    this.departTime = Infinity;
    this.planetFade = 1;
    this.planetSize = this.approach;
  }

  /** In space: which planet lies ahead and how close it is (0 far, 1 about to enter). */
  setApproach(id: Exclude<EnvironmentId, 'space'>, amount: number): void {
    this.upcoming = id;
    this.approach = amount;
  }

  /** Blends to `id` over `seconds`. */
  transitionTo(id: EnvironmentId, seconds: number): void {
    if (id === this.target) return;
    this.current = this.target;
    this.target = id;
    this.progress = 0;
    this.duration = seconds;
    if (this.current === 'space' && id !== 'space') {
      this.palette = PALETTES[id];
      this.applyPalette();
      this.upcoming = id;
      this.entryFrom = this.planetSize;
    }
    if (id === 'space' && this.current !== 'space') {
      this.departed = this.current;
      this.departTime = 0;
      this.planetFade = 0;
    }
  }

  get transitioning(): boolean {
    return this.progress < 1;
  }

  /** Terrain scroll so far; a point on the ground at world y has terrain y = y + scrollOffset. */
  get scrollOffset(): number {
    return this.scroll;
  }

  /** Flattens the ground around terrain point (x, y); returns the world z of the flat ground. */
  setClearing(x: number, y: number, radius: number): number {
    const p = this.palette;
    const height = p ? Math.max(0.3, p.seaLevel + 0.08) : 0.3;
    const u = this.terrainMaterial.uniforms;
    (u.uClear!.value as Vector4).set(x, y, radius, 1);
    u.uClearHeight!.value = height;
    return TERRAIN_Z + height * (p?.amplitude ?? 8);
  }

  clearClearing(): void {
    (this.terrainMaterial.uniforms.uClear!.value as Vector4).w = 0;
  }

  /** `speed` is the scroll speed of the play plane in world units per second. */
  update(dt: number, camera: Camera, speed: number, cockpitBlend: number): void {
    this.time += dt;
    this.scroll += speed * TERRAIN_SCROLL_RATE * dt;
    let veil = 0;
    this.heat = 0;
    const entering = this.progress < 1 && this.current === 'space' && this.target !== 'space';
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + dt / this.duration);
      const p = this.progress;
      veil = Math.sin(Math.PI * p);
      if (this.current === 'space') {
        // Dive at the planet until it fills the view, burn through the upper atmosphere,
        // punch through the clouds, and level out over the ground.
        veil = MathUtils.smoothstep(p, 0.35, 0.55) * (1 - MathUtils.smoothstep(p, 0.65, 0.95));
        this.heat = MathUtils.smoothstep(p, 0.12, 0.35) * (1 - MathUtils.smoothstep(p, 0.45, 0.6));
        this.atmosphere = MathUtils.smoothstep(p, 0.5, 0.75);
      } else if (this.target === 'space') {
        this.atmosphere = 1 - MathUtils.smoothstep(p, 0.25, 0.7);
      } else {
        // Planet to planet: swap worlds while the view is clouded over.
        this.atmosphere = 1;
        const next = PALETTES[this.target as Exclude<EnvironmentId, 'space'>];
        if (p >= 0.5 && this.palette !== next) {
          this.palette = next;
          this.applyPalette();
        }
      }
      if (p >= 1) this.current = this.target;
    }
    this.updatePlanet(dt, camera, cockpitBlend, entering);

    const a = this.atmosphere;
    this.world.visible = a > 0.001;
    this.updateVeil(veil, this.heat);
    if (!this.world.visible) return;

    const u = this.terrainMaterial.uniforms;
    u.uScroll!.value = this.scroll;
    u.uTime!.value = this.time;
    u.uOpacity!.value = a;
    this.skyMaterial.uniforms.uOpacity!.value = a;
    this.sky.position.copy(camera.position);
    this.cloudMaterial.opacity = this.cloudOpacity * a;
    for (const c of this.clouds) {
      c.sprite.position.y -= speed * 0.8 * c.speed * dt;
      if (c.sprite.position.y < CLOUD_Y_MIN) this.placeCloud(c.sprite, CLOUD_Y_MAX);
    }
  }

  private updatePlanet(dt: number, camera: Camera, cockpitBlend: number, entering: boolean): void {
    let look: Exclude<EnvironmentId, 'space'> | null = null;
    let size = 0;
    let opacity = 0;
    let screenY = APPROACH_SCREEN_END;
    if (entering) {
      const p = this.progress;
      look = this.target as Exclude<EnvironmentId, 'space'>;
      const k = MathUtils.smoothstep(p, 0, 0.5);
      size = MathUtils.lerp(this.entryFrom, ENTRY_SIZE, k);
      screenY = MathUtils.lerp(this.approachScreenY(this.entryFrom), 0, k);
      opacity = 1 - MathUtils.smoothstep(p, 0.5, 0.62);
      this.planetSize = size;
    } else if (this.departed && this.departTime < DEPART_SECONDS) {
      // Climbing out: the planet we left drops away below and behind.
      this.departTime += dt;
      const t = this.departTime / DEPART_SECONDS;
      look = this.departed;
      size = MathUtils.lerp(1.2, 0.35, 1 - (1 - t) ** 2);
      screenY = MathUtils.lerp(0, -1.6, t ** 1.4);
      opacity = MathUtils.smoothstep(this.departTime, this.duration * 0.35, this.duration * 0.65) * (1 - MathUtils.smoothstep(t, 0.8, 1));
      this.planetSize = 0;
    } else if (this.target === 'space' && this.progress >= 1) {
      // Far ahead it drifts slowly down from above the top of the screen, growing as it nears.
      look = this.upcoming;
      this.planetFade = Math.min(1, this.planetFade + dt / 3);
      this.planetSize += (this.approach - this.planetSize) * Math.min(1, dt * 0.5);
      size = this.planetSize;
      screenY = this.approachScreenY(size);
      opacity = this.planetFade;
    }
    if (look && look !== this.planetLook) {
      const p = PALETTES[look];
      this.planet.setLook({ low: p.low, mid: p.mid, high: p.high, sea: p.sea, seaLevel: p.seaLevel, seaGlow: p.seaGlow, atmosphere: p.skyHorizon });
      this.planetLook = look;
    }
    this.planet.update(dt, camera.position, cockpitBlend, size, screenY, look ? opacity : 0);
  }

  private approachScreenY(size: number): number {
    const t = Math.min(1, size / 0.72);
    return MathUtils.lerp(APPROACH_SCREEN_START, APPROACH_SCREEN_END, 1 - (1 - t) ** 1.6);
  }

  dispose(): void {
    this.planet.dispose();
    this.terrain.geometry.dispose();
    this.terrainMaterial.dispose();
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    this.cloudMaterial.map?.dispose();
    this.cloudMaterial.dispose();
    this.veil.remove();
  }

  private applyPalette(): void {
    const p = this.palette;
    if (!p) return;
    const u = this.terrainMaterial.uniforms;
    u.uFrequency!.value = p.frequency;
    u.uAmplitude!.value = p.amplitude;
    u.uRidge!.value = p.ridge;
    u.uTerrace!.value = p.terrace;
    u.uSeaLevel!.value = p.seaLevel;
    u.uSeaGlow!.value = p.seaGlow;
    u.uDunes!.value = p.dunes;
    u.uLow!.value.setHex(p.low);
    u.uMid!.value.setHex(p.mid);
    u.uHigh!.value.setHex(p.high);
    u.uSea!.value.setHex(p.sea);
    u.uFog!.value.setHex(p.fog);
    u.uSun!.value.setHex(p.sun);
    const s = this.skyMaterial.uniforms;
    s.uTop!.value.setHex(p.skyTop);
    s.uHorizon!.value.setHex(p.skyHorizon);
    s.uFog!.value.setHex(p.fog);
    s.uSun!.value.setHex(p.sun);
    this.cloudMaterial.color.setHex(p.cloud);
    this.cloudOpacity = p.cloudOpacity;
  }

  private updateVeil(amount: number, heat: number): void {
    const tint = (this.palette ?? PALETTES.ocean).veil;
    const active = amount > 0.01 || heat > 0.01;
    this.veil.style.opacity = active ? '1' : '0';
    this.veil.style.setProperty('--veil', tint);
    this.veil.style.setProperty('--cloud', String(Math.min(1, amount * 1.15)));
    this.veil.style.setProperty('--heat', String(heat));
  }

  private placeCloud(sprite: Sprite, y: number): void {
    const size = MathUtils.randFloat(9, 20);
    sprite.scale.set(size, size * 0.6, 1);
    sprite.position.set(MathUtils.randFloatSpread(70), y + MathUtils.randFloat(0, 20), MathUtils.randFloat(-10, -3));
  }
}
