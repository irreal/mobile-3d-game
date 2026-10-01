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
  SRGBColorSpace,
  TextureLoader,
} from 'three';
import type { Box3, BufferGeometry, Material, MeshStandardMaterialParameters, Object3D, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGlowMaterial, glowGeometry } from './glow.ts';
import { GUN_TYPES, GUNS } from './constants.ts';
import type { GunType } from './constants.ts';

/**
 * Ship models come from Quaternius' CC0 "Ultimate Spaceships" pack (public/assets/ships),
 * with the old procedural models as a fallback if loading fails. Everything faces +y
 * ("up the screen") on the z = 0 plane, viewed from +z; enemies face -y, toward the player.
 * Geometries are shared; materials are per-instance where they need to flash on hit.
 */

type ShipId = 'player' | 'grunt' | 'weaver' | 'tank' | 'diver' | 'sprayer' | 'swooper';

interface ShipSource {
  mesh: string;
  texture: string;
  /** Largest extent on the gameplay plane, in world units. */
  span: number;
  /** Enemies are turned around to face down the screen. */
  facesDown: boolean;
}

const SHIP_SOURCES: Record<ShipId, ShipSource> = {
  player: { mesh: 'challenger.glb', texture: 'challenger_blue.jpg', span: 2.5, facesDown: false },
  grunt: { mesh: 'bob.glb', texture: 'bob_red.jpg', span: 2.1, facesDown: true },
  weaver: { mesh: 'dispatcher.glb', texture: 'dispatcher_red.jpg', span: 2.2, facesDown: true },
  tank: { mesh: 'pancake.glb', texture: 'pancake_red.jpg', span: 3.6, facesDown: true },
  diver: { mesh: 'striker.glb', texture: 'striker_green.jpg', span: 2, facesDown: true },
  sprayer: { mesh: 'omen.glb', texture: 'omen_purple.jpg', span: 3.2, facesDown: true },
  swooper: { mesh: 'spitfire.glb', texture: 'spitfire_orange.jpg', span: 2.2, facesDown: true },
};

interface ShipAsset {
  geometry: BufferGeometry;
  texture: Texture;
  /** Local y of the ship's tail, where engine glows go. */
  tailY: number;
}

const shipAssets = new Map<ShipId, ShipAsset>();

/** Loads all ship models; resolves even if some fail (those fall back to procedural models). */
export async function loadShipModels(): Promise<void> {
  const base = `${import.meta.env.BASE_URL}assets/ships/`;
  const gltfLoader = new GLTFLoader();
  const textureLoader = new TextureLoader();
  const entries = Object.entries(SHIP_SOURCES) as [ShipId, ShipSource][];
  await Promise.all(
    entries.map(async ([id, source]) => {
      try {
        const [gltf, texture] = await Promise.all([
          gltfLoader.loadAsync(base + source.mesh),
          textureLoader.loadAsync(base + source.texture),
        ]);
        let geometry: BufferGeometry | null = null;
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((obj) => {
          if (!geometry && obj instanceof Mesh) geometry = (obj.geometry as BufferGeometry).clone().applyMatrix4(obj.matrixWorld);
        });
        if (!geometry) throw new Error(`${source.mesh} has no mesh`);
        shipAssets.set(id, { ...normalizeShip(geometry, source), texture: prepareTexture(texture) });
      } catch (error) {
        console.warn(`Ship model "${id}" failed to load; using the procedural fallback.`, error);
      }
    }),
  );
}

/** The pack's ships are y-up with the nose along +z; turn them to face +y (or -y) with top +z. */
function normalizeShip(geometry: BufferGeometry, source: ShipSource): { geometry: BufferGeometry; tailY: number } {
  geometry.rotateX(Math.PI / 2);
  geometry.rotateZ(source.facesDown ? 0 : Math.PI);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as Box3;
  const center = box.getCenter(box.min.clone());
  geometry.translate(-center.x, -center.y, -center.z);
  const size = box.getSize(center);
  const scale = source.span / Math.max(size.x, size.y);
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const b = geometry.boundingBox as Box3;
  return { geometry, tailY: source.facesDown ? b.max.y : b.min.y };
}

function prepareTexture(texture: Texture): Texture {
  texture.colorSpace = SRGBColorSpace;
  // glTF UV convention (the meshes came from OBJ via obj2gltf).
  texture.flipY = false;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function shipMaterial(asset: ShipAsset): MeshStandardMaterial {
  return new MeshStandardMaterial({ map: asset.texture, roughness: 0.55, metalness: 0.35, emissive: 0x000000 });
}

const engineGlowMaterials = {
  player: createGlowMaterial({ size: 1.2, intensity: 1.15, color: [1, 0.55, 0.2] }),
  enemy: createGlowMaterial({ size: 0.7, intensity: 0.85, color: [1, 0.25, 0.35] }),
};

const sharedMaterials = new Set<Material>(Object.values(engineGlowMaterials));

function engineGlow(material: Material, y: number, scale = 1): Mesh {
  const glow = new Mesh(glowGeometry, material);
  glow.position.set(0, y, 0);
  glow.scale.setScalar(scale);
  glow.renderOrder = 2;
  return glow;
}

function texturedEnemy(id: ShipId, glowScale: number): Model | null {
  const asset = shipAssets.get(id);
  if (!asset) return null;
  const object = new Group();
  const material = shipMaterial(asset);
  object.add(new Mesh(asset.geometry, material));
  object.add(engineGlow(engineGlowMaterials.enemy, asset.tailY + 0.1, glowScale));
  return { object, flashMaterials: [material] };
}

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
  powerupRocket: new CapsuleGeometry(0.2, 0.55, 4, 8),
  powerupRing: new TorusGeometry(0.42, 0.06, 6, 20),

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
  /** Local y of the engine exhaust. */
  tailY: number;
}

export function createPlayerShip(): PlayerModel {
  const asset = shipAssets.get('player');
  if (asset) {
    const object = new Group();
    const hull = shipMaterial(asset);
    object.add(new Mesh(asset.geometry, hull));
    const flame = mesh(
      geometries.flame,
      new MeshBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0.85, blending: AdditiveBlending }),
      0,
      asset.tailY - 0.3,
      0,
    );
    flame.rotation.z = Math.PI;
    object.add(flame, engineGlow(engineGlowMaterials.player, asset.tailY - 0.05));
    return { object, flashMaterials: [hull], flame, tailY: asset.tailY };
  }
  return createProceduralPlayerShip();
}

function createProceduralPlayerShip(): PlayerModel {
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

  return { object, flashMaterials: [hull, wing, accent], flame, tailY: -1.15 };
}

export function createGrunt(): Model {
  const textured = texturedEnemy('grunt', 0.9);
  if (textured) return textured;
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
  const textured = texturedEnemy('weaver', 0.9);
  if (textured) return textured;
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
  const textured = texturedEnemy('tank', 1.6);
  if (textured) return textured;
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

/** Slim green lancer that lines up and dives at the player. */
export function createDiver(): Model {
  return texturedEnemy('diver', 0.8) ?? tinted(createWeaver(), 0x57e389);
}

/** Purple gunship that parks and sprays rotating rings of shots. */
export function createSprayer(): Model {
  return texturedEnemy('sprayer', 1.3) ?? tinted(createTank(), 0xc04dff, 0.75);
}

/** Orange wide-wing fighter that sweeps across the screen in an arc. */
export function createSwooper(): Model {
  return texturedEnemy('swooper', 0.9) ?? tinted(createGrunt(), 0xff9a3d);
}

function tinted(model: Model, color: number, scale = 1): Model {
  for (const m of model.flashMaterials) m.color.setHex(color);
  model.object.scale.setScalar(scale);
  return model;
}

export type PowerupKind = GunType | 'rocket';
export const POWERUP_KINDS: readonly PowerupKind[] = [...GUN_TYPES, 'rocket'];

export const POWERUP_COLORS = {
  ...Object.fromEntries(GUN_TYPES.map((t) => [t, GUNS[t].color])),
  rocket: 0xffa040,
} as Record<PowerupKind, number>;

const powerupGlows = {} as Record<PowerupKind, Material>;
for (const k of POWERUP_KINDS) {
  const hex = POWERUP_COLORS[k];
  const color: [number, number, number] = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  powerupGlows[k] = createGlowMaterial({ size: 2, intensity: 0.8, core: 0.15, color });
  sharedMaterials.add(powerupGlows[k]);
}

export interface PowerupModel extends Model {
  /** One look per kind; show the one the orb currently is. */
  looks: Record<PowerupKind, Object3D>;
}

/** Power orb: gun colours are gems, rockets an orange capsule with a ring. */
export function createPowerup(): PowerupModel {
  const object = new Group();
  const flashMaterials: MeshStandardMaterial[] = [];
  const looks = {} as Record<PowerupKind, Object3D>;
  for (const kind of POWERUP_KINDS) {
    const look = new Group();
    const color = POWERUP_COLORS[kind];
    const body = standard(color, { emissive: color, emissiveIntensity: 0.7, metalness: 0.2 });
    flashMaterials.push(body);
    if (kind !== 'rocket') {
      look.add(mesh(geometries.powerup, body));
    } else {
      const capsule = mesh(geometries.powerupRocket, body);
      capsule.rotation.z = 0.5;
      const ring = mesh(geometries.powerupRing, standard(0xfff1c9, { emissive: 0xffd23d, emissiveIntensity: 0.6 }));
      ring.rotation.x = Math.PI / 2;
      look.add(capsule, ring);
    }
    look.add(new Mesh(glowGeometry, powerupGlows[kind]));
    look.visible = false;
    looks[kind] = look;
    object.add(look);
  }
  return { object, flashMaterials, looks };
}

export function disposeModel(model: Model): void {
  model.object.traverse((obj) => {
    if (obj instanceof Mesh && !sharedMaterials.has(obj.material as Material)) (obj.material as Material).dispose();
  });
}
