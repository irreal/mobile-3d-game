import { bindUpdateCheck } from './update.ts';

/** DOM overlay: score, high score, lives, gun, rocket and barrier status, center message, and an optional FPS meter. */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly score: HTMLDivElement;
  private readonly hiScore: HTMLDivElement;
  private readonly wave: HTMLDivElement;
  private readonly lives: HTMLDivElement;
  private readonly laser: HTMLDivElement;
  private readonly rocket: HTMLDivElement;
  private readonly barrier: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private readonly messageTitle: HTMLDivElement;
  private readonly messageBody: HTMLDivElement;
  private readonly fps: HTMLDivElement | null;
  private renderMute: ((muted: boolean) => void) | null = null;
  private frames = 0;
  private accumulated = 0;
  private shown = { score: -1, hiScore: -1, lives: -1, weapons: '', wave: -1 };

  constructor(overlay: HTMLElement) {
    this.root = el('div', 'hud');
    const top = el('div', 'hud-top');
    this.score = el('div', 'hud-score');
    this.hiScore = el('div', 'hud-hiscore');
    this.wave = el('div', 'hud-wave');
    const center = el('div', 'hud-center');
    center.append(this.hiScore, this.wave);
    const right = el('div', 'hud-right');
    this.lives = el('div', 'hud-lives');
    this.laser = el('div', 'hud-weapon laser');
    this.rocket = el('div', 'hud-weapon rocket');
    this.barrier = el('div', 'hud-weapon barrier');
    this.barrier.textContent = 'BARRIER ◈';
    this.barrier.hidden = true;
    right.append(this.lives, this.laser, this.rocket, this.barrier);
    top.append(this.score, center, right);

    this.message = el('div', 'hud-message');
    this.messageTitle = el('div', 'hud-message-title');
    this.messageBody = el('div', 'hud-message-body');
    this.message.append(this.messageTitle, this.messageBody);

    this.root.append(top, this.message);

    const version = document.createElement('button');
    version.type = 'button';
    version.className = 'hud-version';
    version.title = 'Check for update';
    const label = `v${__APP_VERSION__} · ${__APP_COMMIT__} ⟳`;
    bindUpdateCheck(version, label);
    this.root.append(version);

    const showFps = import.meta.env.DEV || new URLSearchParams(location.search).has('fps');
    this.fps = showFps ? el('div', 'hud-fps') : null;
    if (this.fps) this.root.append(this.fps);

    overlay.appendChild(this.root);
  }

  /** Adds a sound on/off toggle button (the only interactive HUD element). */
  addMuteButton(muted: boolean, toggle: () => boolean): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hud-mute';
    const render = (m: boolean): void => {
      button.innerHTML = m ? SPEAKER_OFF : SPEAKER_ON;
      button.setAttribute('aria-label', m ? 'Unmute sound' : 'Mute sound');
    };
    render(muted);
    this.renderMute = render;
    // Keep taps on the button from reaching the game (start/steer).
    button.addEventListener('pointerdown', (e) => e.stopPropagation());
    button.addEventListener('click', () => render(toggle()));
    this.root.append(button);
  }

  setMuted(muted: boolean): void {
    this.renderMute?.(muted);
  }

  setScore(score: number): void {
    if (score === this.shown.score) return;
    this.shown.score = score;
    this.score.textContent = score.toLocaleString('en-US');
  }

  setHiScore(score: number): void {
    if (score === this.shown.hiScore) return;
    this.shown.hiScore = score;
    this.hiScore.textContent = `HI ${score.toLocaleString('en-US')}`;
  }

  /** 0 hides the wave indicator. */
  setWave(wave: number): void {
    if (wave === this.shown.wave) return;
    this.shown.wave = wave;
    this.wave.textContent = wave > 0 ? `WAVE ${wave}` : '';
  }

  setLives(lives: number): void {
    if (lives === this.shown.lives) return;
    this.shown.lives = lives;
    this.lives.textContent = '▲'.repeat(Math.max(0, lives));
  }

  /** Main gun (short tag, colour, level), rockets, and whether a barrier is up. */
  setWeapons(gun: { tag: string; color: number }, level: number, max: number, rocket: number, rocketMax: number, barrier: boolean): void {
    const key = `${gun.tag}${level}/${rocket}/${barrier}`;
    if (key === this.shown.weapons) return;
    this.shown.weapons = key;
    this.laser.textContent = `${gun.tag} ${'■'.repeat(level)}${'□'.repeat(max - level)}`;
    this.laser.style.color = `#${gun.color.toString(16).padStart(6, '0')}`;
    this.rocket.textContent = `RKT ${'■'.repeat(rocket)}${'□'.repeat(rocketMax - rocket)}`;
    this.barrier.hidden = !barrier;
  }

  showMessage(title: string, body = ''): void {
    this.messageTitle.textContent = title;
    this.messageBody.textContent = body;
    this.message.classList.add('visible');
  }

  hideMessage(): void {
    this.message.classList.remove('visible');
  }

  /** Feed frame times for the FPS meter (no-op unless enabled via dev mode or `?fps`). */
  tick(dt: number): void {
    if (!this.fps) return;
    this.frames++;
    this.accumulated += dt;
    if (this.accumulated >= 0.5) {
      this.fps.textContent = `${Math.round(this.frames / this.accumulated)} fps`;
      this.frames = 0;
      this.accumulated = 0;
    }
  }
}

const SPEAKER_PATH = 'M4 9v6h4l5 4V5L8 9H4z';
const SPEAKER_ON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${SPEAKER_PATH}"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const SPEAKER_OFF = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${SPEAKER_PATH}"/><path d="M16 9l6 6M22 9l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

function el(tag: 'div', className: string): HTMLDivElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
