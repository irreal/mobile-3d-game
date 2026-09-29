import { ActionButton } from './ActionButton.ts';
import { Keyboard } from './Keyboard.ts';
import { VirtualJoystick } from './VirtualJoystick.ts';

export interface MoveVector {
  /** Right is +1. */
  x: number;
  /** Forward (up the screen / W key) is +1. */
  y: number;
}

/**
 * Unified game input: virtual joystick + jump button on touch devices,
 * WASD/arrows + Space on desktop. Game code reads `move` and calls `consumeJump()`.
 */
export class Input {
  readonly move: MoveVector = { x: 0, y: 0 };

  private readonly joystick: VirtualJoystick;
  private readonly keyboard = new Keyboard();
  private jumpQueued = false;

  constructor(surface: HTMLElement, overlay: HTMLElement) {
    this.joystick = new VirtualJoystick(surface, overlay);
    new ActionButton(overlay, 'JUMP', this.queueJump);
    this.keyboard.onPress('Space', this.queueJump);
  }

  /** Call once per frame before game logic reads `move`. */
  update(): void {
    if (this.joystick.active) {
      this.move.x = this.joystick.x;
      this.move.y = this.joystick.y;
      return;
    }
    const k = this.keyboard;
    let x = (k.isDown('KeyD', 'ArrowRight') ? 1 : 0) - (k.isDown('KeyA', 'ArrowLeft') ? 1 : 0);
    let y = (k.isDown('KeyW', 'ArrowUp') ? 1 : 0) - (k.isDown('KeyS', 'ArrowDown') ? 1 : 0);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.move.x = x;
    this.move.y = y;
  }

  /** Returns true once per jump press, buffering presses shorter than a frame. */
  consumeJump(): boolean {
    const queued = this.jumpQueued;
    this.jumpQueued = false;
    return queued;
  }

  private readonly queueJump = (): void => {
    this.jumpQueued = true;
  };
}
