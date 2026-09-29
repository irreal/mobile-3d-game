import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  AdditiveBlending,
} from 'three';
import type { BufferGeometry, Material, MeshStandardMaterialParameters } from 'three';

/**
 * Procedural placeholder models. Everything faces +y ("up the screen") on the z = 0 plane,
 * viewed from +z. Geometries are shared; materials are per-instance where they need to
 * flash on hit.
 */

const geometries = {
  shipBody: new ConeGeometry(0.42, 1.9, 10),
  shipWing: new BoxGeometry(2.3, 0.5, 0.12),
  shipFin: new BoxGeometry(0.14, 0.8, 0.3),
  cockpit: new SphereGeometry(0.2, 12, 8),
  flame: new ConeGeometry(0.22, 0.8, 8),

  saucer: new SphereGeometry(0.62, 16, 10),
  saucerRing: new TorusGeometry(0.82, 0.12, 8, 24),
  eye: new SphereGeometry(0.2, 10, 8),

  dart: new ConeGeometry(0.45, 1.5, 6),
  dartWing: new BoxGeometry(1.7, 0.35, 0.1),

  hull: new IcosahedronGeometry(1.25, 0),
  cannon: new CylinderGeometry(0.16, 0.2, 1.1, 8),
  hullRing: new TorusGeometry(1.35, 0.1, 6, 28),

  powerup: new OctahedronGeometry(0.45, 0),

  playerBullet: new CapsuleGeometry(0.09, 0.6, 2, 6),
  enemyBullet: new SphereGeometry(0.27, 12, 8),
  particle: new BoxGeometry(0.2, 0.2, 0.2),
  rocket: new ConeGeometry(0.14, 0.7, 6),
  warpStreak: new CylinderGeometry(0.02, 0.35, 1, 8, 1, true),
} satisfies Record<string, BufferGeometry>;

export const sharedGeometries = geometries;

function mesh(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const m = new Mesh(geometry, material);
  m.position.set(x, y, z);
  return m;
}

function standard(color: number, extra: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.25, ...extra });
}

export interface Model {
  object: Group;
  /** Materials that should flash white when the model is hit. */
  flashMaterials: MeshStandardMaterial[];
}

export interface PlayerModel extends Model {
  flame: Mesh;
}

export function createPlayerShip(): PlayerModel {
  const object = new Group();
  const hull = standard(0xdfe7ff, { metalness: 0.5, roughness: 0.3 });
  const wing = standard(0x3b7bff);
  const accent = standard(0xff6a3d);

  object.add(mesh(geometries.shipBody, hull, 0, 0.1, 0));
  object.add(mesh(geometries.shipWing, wing, 0, -0.45, 0));
  object.add(mesh(geometries.shipFin, accent, -1.05, -0.35, 0.05));
  object.add(mesh(geometries.shipFin, accent, 1.05, -0.35, 0.05));
  object.add(
    mesh(geometries.cockpit, standard(0x6ff3ff, { emissive: 0x1aa6c4, emissiveIntensity: 0.8 }), 0, 0.2, 0.28),
  );

  const flame = mesh(
    geometries.flame,
    new MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, blending: AdditiveBlending }),
    0,
    -1.15,
    0,
  );
  flame.rotation.z = Math.PI;
  object.add(flame);

  return { object, flashMaterials: [hull, wing, accent], flame };
}

export function createGrunt(): Model {
  const object = new Group();
  const dome = standard(0x57e389, { emissive: 0x0b3d1f });
  const ring = standard(0xc04dff, { metalness: 0.6 });
  const saucer = mesh(geometries.saucer, dome);
  saucer.scale.set(1, 1, 0.5);
  object.add(saucer);
  object.add(mesh(geometries.saucerRing, ring));
  object.add(mesh(geometries.eye, new MeshBasicMaterial({ color: 0xff2d55 }), 0, -0.1, 0.3));
  return { object, flashMaterials: [dome, ring] };
}

export function createWeaver(): Model {
  const object = new Group();
  const body = standard(0xffb443, { emissive: 0x3d2200 });
  const wing = standard(0xff5a36);
  const dart = mesh(geometries.dart, body);
  dart.rotation.z = Math.PI;
  object.add(dart);
  const left = mesh(geometries.dartWing, wing, -0.45, 0.35, 0);
  left.rotation.z = -0.5;
  const right = mesh(geometries.dartWing, wing, 0.45, 0.35, 0);
  right.rotation.z = 0.5;
  object.add(left, right);
  return { object, flashMaterials: [body, wing] };
}

export function createTank(): Model {
  const object = new Group();
  const hull = standard(0x9b5cff, { flatShading: true, emissive: 0x1d0a3d, metalness: 0.4 });
  const metal = standard(0x5b6380, { metalness: 0.7, roughness: 0.3 });
  const hullMesh = mesh(geometries.hull, hull);
  hullMesh.scale.set(1, 0.9, 0.6);
  object.add(hullMesh);
  object.add(mesh(geometries.hullRing, metal));
  object.add(mesh(geometries.cannon, metal, -0.7, -1.1, 0));
  object.add(mesh(geometries.cannon, metal, 0.7, -1.1, 0));
  object.add(mesh(geometries.eye, new MeshBasicMaterial({ color: 0xffe14d }), 0, -0.2, 0.75));
  return { object, flashMaterials: [hull, metal] };
}

export function createPowerup(): Model {
  const object = new Group();
  const gem = standard(0x5dff9e, { emissive: 0x1fcf6a, emissiveIntensity: 0.9, metalness: 0.1 });
  object.add(mesh(geometries.powerup, gem));
  return { object, flashMaterials: [gem] };
}

export function disposeModel(model: Model): void {
  model.object.traverse((obj) => {
    if (obj instanceof Mesh) (obj.material as Material).dispose();
  });
}
