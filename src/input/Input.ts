import { Keyboard } from './Keyboard.ts';

export interface Vec2 {
  x: number;
  y: number;
}

export type PressListener = (x: number, y: number, timeMs: number) => void;

/**
 * Game input for a shmup:
 * - Relative drag: the ship follows the finger's *movement*, not its position, so the
 *   finger can rest anywhere (typically below the ship) without covering it.
 *   Works with touch, pen and mouse.
 * - Keyboard: WASD / arrows for movement.
 * - Taps (pointer down, Space, Enter) for menus.
 */
export class Input {
  /** Keyboard movement axis, each component in [-1, 1]; +y is up. */
  readonly axis: Vec2 = { x: 0, y: 0 };
  /** Position of the active pointer in CSS pixels relative to the surface (valid while `dragging`). */
  readonly pointer: Vec2 = { x: 0, y: 0 };

  private readonly keyboard = new Keyboard();
  private readonly tapListeners = new Set<() => void>();
  private readonly releaseListeners = new Set<() => void>();
  private readonly pressListeners = new Set<PressListener>();
  private readonly moveListeners = new Set<PressListener>();
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private dragX = 0;
  private dragY = 0;

  constructor(private readonly surface: HTMLElement) {
    surface.addEventListener('pointerdown', this.onDown);
    surface.addEventListener('pointermove', this.onMove);
    surface.addEventListener('pointerup', this.onUp);
    surface.addEventListener('pointercancel', this.onUp);
    surface.addEventListener('lostpointercapture', this.onUp);
    this.keyboard.onPress('Space', this.emitTap);
    this.keyboard.onPress('Enter', this.emitTap);
  }

  get dragging(): boolean {
    return this.pointerId !== null;
  }

  onTap(listener: () => void): () => void {
    this.tapListeners.add(listener);
    return () => this.tapListeners.delete(listener);
  }

  /** Fires once per press of a key (by `KeyboardEvent.code`). */
  onKey(code: string, listener: () => void): void {
    this.keyboard.onPress(code, listener);
  }

  /**
   * Fires on every pointer press (any finger) with its surface position in CSS pixels and
   * the event time (performance.now() time base). Runs before tap listeners.
   */
  onPress(listener: PressListener): () => void {
    this.pressListeners.add(listener);
    return () => this.pressListeners.delete(listener);
  }

  /** Fires as the steering pointer moves, with its surface position in CSS pixels. */
  onPointerMove(listener: PressListener): () => void {
    this.moveListeners.add(listener);
    return () => this.moveListeners.delete(listener);
  }

  /** Fires when the steering pointer is lifted (or cancelled). */
  onRelease(listener: () => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  /** Call once per frame before reading `axis` / `consumeDrag`. */
  update(): void {
    const k = this.keyboard;
    let x = (k.isDown('KeyD', 'ArrowRight') ? 1 : 0) - (k.isDown('KeyA', 'ArrowLeft') ? 1 : 0);
    let y = (k.isDown('KeyW', 'ArrowUp') ? 1 : 0) - (k.isDown('KeyS', 'ArrowDown') ? 1 : 0);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.axis.x = x;
    this.axis.y = y;
  }

  /** Drag distance in CSS pixels since the last call (+y is up the screen). */
  consumeDrag(out: Vec2): Vec2 {
    out.x = this.dragX;
    out.y = this.dragY;
    this.dragX = 0;
    this.dragY = 0;
    return out;
  }

  dispose(): void {
    this.surface.removeEventListener('pointerdown', this.onDown);
    this.surface.removeEventListener('pointermove', this.onMove);
    this.surface.removeEventListener('pointerup', this.onUp);
    this.surface.removeEventListener('pointercancel', this.onUp);
    this.surface.removeEventListener('lostpointercapture', this.onUp);
    this.keyboard.dispose();
  }

  private readonly emitTap = (): void => {
    this.tapListeners.forEach((fn) => fn());
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (this.pressListeners.size > 0) {
      const rect = this.surface.getBoundingClientRect();
      const now = performance.now();
      // Very old engines used epoch timestamps; fall back to "now" for those.
      const time = Math.abs(e.timeStamp - now) < 1000 ? e.timeStamp : now;
      this.pressListeners.forEach((fn) => fn(e.clientX - rect.left, e.clientY - rect.top, time));
    }
    this.emitTap();
    // Additional fingers are ignored while one is already steering.
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.surface.setPointerCapture(e.pointerId);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.updatePointer(e);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.dragX += e.clientX - this.lastX;
    this.dragY -= e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.updatePointer(e);
    this.moveListeners.forEach((fn) => fn(this.pointer.x, this.pointer.y, e.timeStamp));
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.releaseListeners.forEach((fn) => fn());
  };

  private updatePointer(e: PointerEvent): void {
    const rect = this.surface.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
  }
}
