import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { Model } from './models.ts';

/** Sentry turret positions relative to the base centre (play-plane units). */
export const SENTRY_OFFSETS: readonly (readonly [number, number])[] = [
  [-4.3, 1.4],
  [4.3, 1.4],
  [-2.7, -2.6],
  [2.7, -2.6],
];
export const CORE_OFFSET = [0, 0.6] as const;
/** Launch bays fighters take off from. */
export const HANGAR_OFFSETS: readonly (readonly [number, number])[] = [
  [-1.9, -4.4],
  [1.9, -4.4],
];
/** Radius of the terrain flattened around the base. */
export const BASE_CLEARING = 12;

const METAL = 0x3b3552;
const TEAL = 0x57ffd8;
const MAGENTA = 0xff3df0;

const geo = {
  sentryBase: new CylinderGeometry(0.95, 1.1, 0.5, 8),
  sentryDome: new SphereGeometry(0.72, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
  barrel: new CylinderGeometry(0.11, 0.14, 1.2, 8),
  eye: new SphereGeometry(0.22, 10, 8),
  core: new IcosahedronGeometry(1.25, 1),
  coreRing: new TorusGeometry(1.75, 0.16, 8, 36),
  coreShell: new TorusGeometry(2.1, 0.08, 6, 40),
  shield: new SphereGeometry(2.3, 28, 18),
  pad: new CylinderGeometry(7.8, 8.4, 1.4, 6),
  padRim: new TorusGeometry(8, 0.14, 6, 6),
  padInner: new CylinderGeometry(5.4, 5.4, 0.3, 6),
  tower: new CylinderGeometry(1.5, 2.4, 1, 8),
  towerRing: new TorusGeometry(1.9, 0.12, 6, 24),
  pylon: new CylinderGeometry(0.55, 0.95, 1, 6),
  pylonCap: new TorusGeometry(0.95, 0.1, 6, 16),
  conduit: new BoxGeometry(0.35, 1, 0.3),
  hangar: new BoxGeometry(2.2, 2.4, 0.5),
  hangarDoor: new BoxGeometry(1.7, 0.18, 0.1),
  spike: new ConeGeometry(0.25, 3, 6),
  beacon: new SphereGeometry(0.2, 8, 6),
};

function metal(color = METAL): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.55, flatShading: true });
}

function glow(color: number, intensity = 1.1): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
}

/** Twin-barrelled turret on top of a pylon; the model turns to aim (nose is -y). */
export function createSentry(): Model {
  const object = new Group();
  const shell = metal(0x5a4f7a);
  const dome = metal(0x7a6aa8);
  const light = glow(MAGENTA, 2);
  const base = new Mesh(geo.sentryBase, shell);
  base.rotation.x = Math.PI / 2;
  const top = new Mesh(geo.sentryDome, dome);
  top.rotation.x = Math.PI / 2;
  top.position.z = 0.2;
  object.add(base, top);
  for (const x of [-0.28, 0.28]) {
    const b = new Mesh(geo.barrel, shell);
    b.position.set(x, -0.85, 0.35);
    object.add(b);
  }
  const eye = new Mesh(geo.eye, light);
  eye.position.set(0, -0.45, 0.62);
  object.add(eye);
  return { object, flashMaterials: [shell, dome] };
}

/** Reactor core: a pulsing crystal inside spinning rings, wrapped in a shield bubble. */
export function createCore(): Model {
  const object = new Group();
  const crystal = new MeshStandardMaterial({
    color: 0x2a1030,
    emissive: MAGENTA,
    emissiveIntensity: 1.2,
    roughness: 0.2,
    metalness: 0.3,
    flatShading: true,
  });
  const ringMat = metal(0x6a5a90);
  const core = new Mesh(geo.core, crystal);
  core.name = 'crystal';
  const spin = new Group();
  spin.name = 'spin';
  const ring = new Mesh(geo.coreRing, ringMat);
  const shell = new Mesh(geo.coreShell, glow(TEAL, 1.4));
  shell.rotation.x = 1.1;
  spin.add(ring, shell);
  const shield = new Mesh(
    geo.shield,
    new MeshBasicMaterial({ color: new Color(TEAL).multiplyScalar(0.35), transparent: true, blending: AdditiveBlending, depthWrite: false }),
  );
  shield.name = 'shield';
  object.add(core, spin, shield);
  return { object, flashMaterials: [crystal, ringMat] };
}

interface Blinker {
  material: MeshStandardMaterial;
  phase: number;
  base: number;
}

/**
 * The fortress structure under the boss parts: a hex platform on the ground with a reactor
 * tower and sentry pylons rising to the play plane (the turrets and core are enemies placed
 * on top). Sits at `groundZ` on the flattened terrain and moves with it.
 */
export class AlienBase {
  readonly object = new Group();
  x = 0;
  y = 0;
  private readonly blinkers: Blinker[] = [];
  private readonly glows: MeshStandardMaterial[] = [];
  private readonly materials: MeshStandardMaterial[] = [];
  private time = 0;
  private wreckTime = -1;

  constructor(groundZ: number) {
    const hull = this.track(metal());
    const dark = this.track(metal(0x241f33));
    const trim = this.track(glow(TEAL, 0.8));
    const hot = this.track(glow(MAGENTA, 1.1));
    const amber = this.track(glow(0xffa040, 1.2));
    this.glows.push(trim, hot, amber);

    const top = groundZ + 1.4;
    const pad = new Mesh(geo.pad, hull);
    pad.rotation.x = Math.PI / 2;
    pad.position.z = groundZ + 0.7;
    const rim = new Mesh(geo.padRim, trim);
    rim.position.z = top;
    rim.rotation.z = Math.PI / 6;
    const inner = new Mesh(geo.padInner, dark);
    inner.rotation.x = Math.PI / 2;
    inner.position.z = top + 0.15;
    this.object.add(pad, rim, inner);

    const [cx, cy] = CORE_OFFSET;
    this.column(geo.tower, hull, cx, cy, top, -2.4);
    for (let z = top + 2; z < -2.5; z += 2.6) {
      const r = new Mesh(geo.towerRing, trim);
      r.position.set(cx, cy, z);
      r.scale.setScalar(MathUtils.mapLinear(z, top, -2.4, 1.2, 0.8));
      this.object.add(r);
    }

    for (const [sx, sy] of SENTRY_OFFSETS) {
      this.column(geo.pylon, hull, sx, sy, top, -0.35);
      const cap = new Mesh(geo.pylonCap, hot);
      cap.position.set(sx, sy, -0.5);
      this.object.add(cap);
      const mid = new Mesh(geo.pylonCap, trim);
      mid.position.set(sx, sy, (top - 0.35) / 2);
      mid.scale.setScalar(1.1);
      this.object.add(mid);
      // Glowing conduit along the deck from the reactor to the pylon.
      const len = Math.hypot(sx - cx, sy - cy);
      const conduit = new Mesh(geo.conduit, hot);
      conduit.scale.y = len - 2;
      conduit.position.set((sx + cx) / 2, (sy + cy) / 2, top + 0.3);
      conduit.rotation.z = Math.atan2(sy - cy, sx - cx) - Math.PI / 2;
      this.object.add(conduit);
    }

    for (const [hx, hy] of HANGAR_OFFSETS) {
      const bay = new Mesh(geo.hangar, dark);
      bay.position.set(hx, hy, top + 0.25);
      this.object.add(bay);
      for (let i = 0; i < 3; i++) {
        const door = new Mesh(geo.hangarDoor, amber);
        door.position.set(hx, hy - 0.7 + i * 0.7, top + 0.52);
        this.object.add(door);
      }
    }

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const x = Math.cos(a) * 6.7;
      const y = Math.sin(a) * 6.7;
      const spike = new Mesh(geo.spike, dark);
      spike.rotation.x = Math.PI / 2;
      spike.position.set(x, y, top + 1.5);
      const light = this.track(glow(i % 2 ? MAGENTA : TEAL, 2));
      const beacon = new Mesh(geo.beacon, light);
      beacon.position.set(x, y, top + 3.1);
      this.blinkers.push({ material: light, phase: i * 0.9, base: 1.4 });
      this.object.add(spike, beacon);
    }
  }

  get wrecked(): boolean {
    return this.wreckTime >= 0;
  }

  /** Core destroyed: lights die, fires flicker and the structure slumps into the ground. */
  wreck(): void {
    if (this.wreckTime < 0) this.wreckTime = 0;
  }

  update(dt: number): void {
    this.time += dt;
    this.object.position.set(this.x, this.y, 0);
    if (this.wreckTime >= 0) {
      this.wreckTime += dt;
      const t = Math.min(1, this.wreckTime / 3);
      const flicker = 0.4 + Math.random() * 0.6;
      for (const m of this.glows) {
        m.emissive.setHex(0xff4a1a);
        m.emissiveIntensity = (1 - t) * 1.5 * flicker + 0.15;
      }
      for (const b of this.blinkers) b.material.emissiveIntensity = 0;
      for (const m of this.materials) if (!this.glows.includes(m)) m.color.lerp(tmpColor.setHex(0x151218), dt * 0.8);
      this.object.position.z = -t * t * 3;
      this.object.rotation.x = t * 0.05;
      return;
    }
    for (const b of this.blinkers) {
      b.material.emissiveIntensity = b.base * (Math.sin(this.time * 4 + b.phase) > 0.3 ? 1 : 0.15);
    }
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
  }

  private track(m: MeshStandardMaterial): MeshStandardMaterial {
    this.materials.push(m);
    return m;
  }

  /** Vertical column from the deck (`from`) up to `to`, standing on the z axis. */
  private column(geometry: CylinderGeometry, material: MeshStandardMaterial, x: number, y: number, from: number, to: number): void {
    const m = new Mesh(geometry, material);
    m.rotation.x = Math.PI / 2;
    m.scale.y = to - from;
    m.position.set(x, y, (from + to) / 2);
    this.object.add(m);
  }
}

const tmpColor = new Color();
