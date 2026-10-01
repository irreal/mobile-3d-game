import { replyDelayBeats, setReplyDelayBeats } from '../game/replyDelay.ts';
import { bindUpdateCheck } from './update.ts';

export interface PauseMenuActions {
  pause: () => void;
  resume: () => void;
  restart: () => void;
  quit: () => void;
  toggleSound: () => boolean;
  /** Toggles post-processing quality; returns the new setting. */
  toggleEffects: () => 'high' | 'low';
  resetTutorials: () => void;
  /** Testing shortcut: jump to cockpit strike N (1-based). */
  jumpToCockpit: (strike: number) => void;
  /** Testing shortcut: jump to the alien base fight on planet N (1-based). */
  jumpToBase: (planet: number) => void;
  /** Testing shortcut: play the ending. */
  jumpToVictory: () => void;
  /** Testing: read / set weapon levels (clamped by the game); `set` returns the new level. */
  weaponLevel: (weapon: Weapon) => { level: number; max: number };
  setWeaponLevel: (weapon: Weapon, level: number) => number;
  /** Testing: current main gun name, and switching to the next one (returns its name). */
  gunName: () => string;
  cycleGun: () => string;
}

export type Weapon = 'gun' | 'rocket';

const TEST_STRIKES = 5;

/** Pause button (during play) and the modal pause menu. */
export class PauseMenu {
  private readonly button: HTMLButtonElement;
  private readonly modal: HTMLDivElement;
  private readonly soundButton: HTMLButtonElement;
  private readonly effectsButton: HTMLButtonElement;
  private readonly tutorialButton: HTMLButtonElement;
  private readonly weaponRows: (() => void)[] = [];
  private readonly resetUpdate: () => void;
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
    const updateButton = menuButton('', () => {});
    this.resetUpdate = bindUpdateCheck(updateButton, 'Check for update');
    card.append(
      title,
      menuButton('Resume', actions.resume, 'primary'),
      menuButton('Restart', actions.restart),
      this.soundButton,
      this.effectsButton,
      this.tutorialButton,
      testRow(actions.jumpToCockpit),
      baseTestRow(actions.jumpToBase, actions.jumpToVictory),
      this.gunRow(actions),
      this.weaponRow('Gun level', 'gun', actions),
      this.weaponRow('Rockets', 'rocket', actions),
      replyDelayRow(),
      updateButton,
      menuButton('Quit to title', actions.quit),
      credits(),
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
    for (const render of this.weaponRows) render();
    this.resetUpdate();
  }

  /** Stepper for a weapon level (testing). */
  private weaponRow(name: string, weapon: Weapon, actions: PauseMenuActions): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'menu-row';
    const label = document.createElement('span');
    const render = (): void => {
      const { level, max } = actions.weaponLevel(weapon);
      label.textContent = `${name}: ${level}/${max}`;
    };
    const step = (by: number) => () => {
      actions.setWeaponLevel(weapon, actions.weaponLevel(weapon).level + by);
      render();
    };
    const minus = menuButton('−', step(-1));
    const plus = menuButton('+', step(1));
    minus.classList.add('small');
    plus.classList.add('small');
    row.append(label, minus, plus);
    this.weaponRows.push(render);
    render();
    return row;
  }

  /** Switches the main gun type (testing). */
  private gunRow(actions: PauseMenuActions): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'menu-row';
    const label = document.createElement('span');
    const render = (): void => {
      label.textContent = `Gun: ${actions.gunName()}`;
    };
    const next = menuButton('Switch', () => {
      actions.cycleGun();
      render();
    });
    next.classList.add('small');
    row.append(label, next);
    this.weaponRows.push(render);
    render();
    return row;
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

/** Required by the cockpit model's CC-BY license (the ship models are CC0; credited anyway). */
function credits(): HTMLDivElement {
  const c = document.createElement('div');
  c.className = 'menu-credits';
  c.textContent =
    'Cockpit model by Ville Seppanen (Osmic), CC-BY 3.0 · Ship models by Quaternius, CC0 · Music & sound synthesized in-game';
  return c;
}

/** Row of small buttons that jump to each cockpit strike level. */
function testRow(jump: (strike: number) => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'menu-row';
  const label = document.createElement('span');
  label.textContent = 'Cockpit test (1, 3, 5: asteroids)';
  row.append(label);
  for (let i = 1; i <= TEST_STRIKES; i++) {
    const b = menuButton(String(i), () => jump(i));
    b.classList.add('small');
    row.append(b);
  }
  return row;
}

/** Buttons that jump straight to each planet's alien base fight. */
function baseTestRow(jump: (planet: number) => void, ending: () => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'menu-row';
  const label = document.createElement('span');
  label.textContent = 'Base test';
  row.append(label);
  ['Desert', 'Ocean', 'Lava'].forEach((name, i) => {
    const b = menuButton(name, () => jump(i + 1));
    b.classList.add('small');
    row.append(b);
  });
  const end = menuButton('End', ending);
  end.classList.add('small');
  row.append(end);
  return row;
}

/** Stepper for the cockpit call-to-reply delay; applies from the next call. */
function replyDelayRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'menu-row';
  const label = document.createElement('span');
  const render = (): void => {
    label.textContent = `Reply delay: ${replyDelayBeats()} beats`;
  };
  const step = (by: number) => () => {
    setReplyDelayBeats(replyDelayBeats() + by);
    render();
  };
  const minus = menuButton('−', step(-1));
  const plus = menuButton('+', step(1));
  minus.classList.add('small');
  plus.classList.add('small');
  row.append(label, minus, plus);
  render();
  return row;
}

function menuButton(label: string, onClick: () => void, variant?: 'primary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = variant ? `menu-button ${variant}` : 'menu-button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
