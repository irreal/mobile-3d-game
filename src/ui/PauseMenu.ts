export interface PauseMenuActions {
  pause: () => void;
  resume: () => void;
  restart: () => void;
  quit: () => void;
  toggleSound: () => boolean;
  /** Toggles post-processing quality; returns the new setting. */
  toggleEffects: () => 'high' | 'low';
  resetTutorials: () => void;
}

/** Pause button (during play) and the modal pause menu. */
export class PauseMenu {
  private readonly button: HTMLButtonElement;
  private readonly modal: HTMLDivElement;
  private readonly soundButton: HTMLButtonElement;
  private readonly effectsButton: HTMLButtonElement;
  private readonly tutorialButton: HTMLButtonElement;
  private open = false;

  constructor(overlay: HTMLElement, actions: PauseMenuActions, muted: boolean, effects: 'high' | 'low') {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'hud-pause';
    this.button.setAttribute('aria-label', 'Pause');
    this.button.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
    this.button.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.button.addEventListener('click', actions.pause);
    this.button.hidden = true;

    this.modal = document.createElement('div');
    this.modal.className = 'modal pause-menu';
    this.modal.hidden = true;
    const card = document.createElement('div');
    card.className = 'modal-card';
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'PAUSED';

    this.soundButton = menuButton('', () => this.renderSound(actions.toggleSound()));
    this.effectsButton = menuButton('', () => this.renderEffects(actions.toggleEffects()));
    this.tutorialButton = menuButton('Show tutorials again', () => {
      actions.resetTutorials();
      this.tutorialButton.textContent = 'Tutorials reset ✓';
      this.tutorialButton.disabled = true;
    });
    card.append(
      title,
      menuButton('Resume', actions.resume, 'primary'),
      menuButton('Restart', actions.restart),
      this.soundButton,
      this.effectsButton,
      this.tutorialButton,
      menuButton('Quit to title', actions.quit),
    );
    this.modal.append(card);
    this.modal.addEventListener('pointerdown', (e) => e.stopPropagation());
    overlay.append(this.button, this.modal);
    this.renderSound(muted);
    this.renderEffects(effects);
  }

  get isOpen(): boolean {
    return this.open;
  }

  setButtonVisible(visible: boolean): void {
    this.button.hidden = !visible;
  }

  show(): void {
    this.open = true;
    this.modal.hidden = false;
    this.tutorialButton.textContent = 'Show tutorials again';
    this.tutorialButton.disabled = false;
  }

  hide(): void {
    this.open = false;
    this.modal.hidden = true;
  }

  renderSound(muted: boolean): void {
    this.soundButton.textContent = muted ? 'Sound: Off' : 'Sound: On';
  }

  renderEffects(quality: 'high' | 'low'): void {
    this.effectsButton.textContent = quality === 'high' ? 'Effects: High' : 'Effects: Low (faster)';
  }
}

function menuButton(label: string, onClick: () => void, variant?: 'primary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = variant ? `menu-button ${variant}` : 'menu-button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
