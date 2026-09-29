/** Tracks held keys by `KeyboardEvent.code` (layout-independent, e.g. 'KeyW'). */
export class Keyboard {
  private readonly held = new Set<string>();
  private readonly pressListeners = new Map<string, Set<() => void>>();

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  isDown(...codes: string[]): boolean {
    return codes.some((code) => this.held.has(code));
  }

  /** Fires once per physical key press (ignores auto-repeat). */
  onPress(code: string, listener: () => void): void {
    let listeners = this.pressListeners.get(code);
    if (!listeners) {
      listeners = new Set();
      this.pressListeners.set(code, listeners);
    }
    listeners.add(listener);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.held.add(e.code);
    this.pressListeners.get(e.code)?.forEach((fn) => fn());
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
  };
}
