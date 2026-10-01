import { CapsuleGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import type { Object3D, ShaderMaterial, Vector3 } from 'three';
import { GUN_TYPES, GUNS, ROCKET_LEVELS } from './constants.ts';
import type { GunType } from './constants.ts';
import { createGlowMaterial, glowGeometry } from './glow.ts';

const geo = {
  barrel: new CylinderGeometry(0.032, 0.042, 0.42, 8),
  muzzle: new SphereGeometry(0.042, 8, 6),
  pod: new CapsuleGeometry(0.06, 0.25, 4, 8),
  podTip: new SphereGeometry(0.05, 8, 6),
};
const gunMetal = new MeshStandardMaterial({ color: 0x9aa4bd, metalness: 0.7, roughness: 0.3 });
const gunTips = Object.fromEntries(
  GUN_TYPES.map((t) => [t, new MeshStandardMaterial({ color: 0x101820, emissive: GUNS[t].color, emissiveIntensity: 1.2 })]),
) as Record<GunType, MeshStandardMaterial>;
/** Lance barrels are long and thin, scatter barrels short and flared. */
const BARREL_SHAPE: Record<GunType, [number, number]> = { pulse: [1, 1], lance: [0.75, 1.35], scatter: [1.35, 0.7] };
const podBody = new MeshStandardMaterial({ color: 0xd8dce8, metalness: 0.4, roughness: 0.35 });
const podTip = new MeshStandardMaterial({ color: 0x402010, emissive: 0xffa040, emissiveIntensity: 1 });
const homingTip = new MeshStandardMaterial({ color: 0x400810, emissive: 0xff3050, emissiveIntensity: 1.3 });

const GROW_TIME = 0.7;

interface Part {
  object: Object3D;
  /** Seconds since it was added (for the grow-in), Infinity when shown instantly. */
  age: number;
  /** Install flash while growing in. */
  glow: Mesh | null;
}

/**
 * Guns and rocket pods mounted on the player ship, matching the current weapons: the main
 * gun's barrels (at their x offset and angle), one pod per rocket launcher. New parts
 * can grow in with a little overshoot, for the upgrade close-up.
 */
export class ShipWeapons {
  readonly object = new Group();
  private readonly parts = new Map<string, Part>();

  /** Updates the mounted parts; returns the local positions of newly added ones. */
  set(gun: GunType, level: number, rocket: number, animate: boolean): Vector3[] {
    const wanted = new Map<string, () => Object3D>();
    const g = GUNS[gun].levels[level];
    for (const [dx, deg] of g?.mounts ?? g?.shots ?? []) {
      wanted.set(`${gun}${dx}:${deg}`, () => this.barrel(gun, dx, deg));
    }
    const r = ROCKET_LEVELS[rocket];
    if (r) {
      const variant = `${r.homing ? 'h' : ''}${r.splash > 0 ? 's' : ''}`;
      for (const dx of r.offsets) wanted.set(`r${dx}${variant}`, () => this.pod(dx, r.homing, r.splash > 0));
    }
    for (const [key, part] of this.parts) {
      if (wanted.has(key)) continue;
      this.object.remove(part.object);
      this.removeGlow(part);
      this.parts.delete(key);
    }
    const added: Vector3[] = [];
    for (const [key, create] of wanted) {
      if (this.parts.has(key)) continue;
      const object = create();
      this.object.add(object);
      let glow: Mesh | null = null;
      if (animate) {
        object.scale.setScalar(0.001);
        added.push(object.position.clone());
        glow = new Mesh(glowGeometry, createGlowMaterial({ size: 1.3, intensity: 0, core: 0.35, color: [0.7, 0.95, 1] }));
        glow.position.copy(object.position);
        glow.renderOrder = 3;
        this.object.add(glow);
      }
      this.parts.set(key, { object, age: animate ? 0 : Infinity, glow });
    }
    return added;
  }

  /** Real-time seconds, so the grow-in plays at normal speed during slow motion. */
  update(realDt: number): void {
    for (const part of this.parts.values()) {
      if (part.age >= GROW_TIME) continue;
      part.age += realDt;
      const t = Math.min(1, part.age / GROW_TIME);
      // Ease-out-back: pops slightly past full size, then settles.
      const s = 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
      part.object.scale.setScalar(Math.max(0.001, s) * ((part.object.userData.baseScale as number | undefined) ?? 1));
      if (part.glow) {
        (part.glow.material as ShaderMaterial).uniforms.uIntensity!.value = 2.2 * Math.sin(Math.PI * t);
        if (t >= 1) this.removeGlow(part);
      }
    }
  }

  private removeGlow(part: Part): void {
    if (!part.glow) return;
    this.object.remove(part.glow);
    (part.glow.material as ShaderMaterial).dispose();
    part.glow = null;
  }

  private barrel(gun: GunType, dx: number, deg: number): Object3D {
    const g = new Group();
    const [width, length] = BARREL_SHAPE[gun];
    const barrel = new Mesh(geo.barrel, gunMetal);
    barrel.scale.set(width, length, width);
    const tip = new Mesh(geo.muzzle, gunTips[gun]);
    tip.position.y = 0.22 * length;
    tip.scale.setScalar(width);
    g.add(barrel, tip);
    g.position.set(dx * 0.8, 0.42 - Math.abs(dx) * 0.5, 0.08);
    g.rotation.z = (deg * Math.PI) / 180;
    return g;
  }

  private pod(dx: number, homing: boolean, splash: boolean): Object3D {
    const g = new Group();
    const body = new Mesh(geo.pod, podBody);
    const tip = new Mesh(geo.podTip, homing ? homingTip : podTip);
    tip.position.y = 0.19;
    g.add(body, tip);
    g.position.set(dx * 0.8, -0.2, dx === 0 ? -0.12 : -0.06);
    if (splash) g.scale.setScalar(1.25);
    g.userData.baseScale = splash ? 1.25 : 1;
    return g;
  }
}
