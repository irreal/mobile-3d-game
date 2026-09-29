/** DOM overlay: score, high score, lives, weapon level, center message, and an optional FPS meter. */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly score: HTMLDivElement;
  private readonly hiScore: HTMLDivElement;
  private readonly lives: HTMLDivElement;
  private readonly weapon: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private readonly messageTitle: HTMLDivElement;
  private readonly messageBody: HTMLDivElement;
  private readonly fps: HTMLDivElement | null;
  private frames = 0;
  private accumulated = 0;
  private shown = { score: -1, hiScore: -1, lives: -1, weapon: -1 };

  constructor(overlay: HTMLElement) {
    this.root = el('div', 'hud');
    const top = el('div', 'hud-top');
    this.score = el('div', 'hud-score');
    this.hiScore = el('div', 'hud-hiscore');
    const right = el('div', 'hud-right');
    this.lives = el('div', 'hud-lives');
    this.weapon = el('div', 'hud-weapon');
    right.append(this.lives, this.weapon);
    top.append(this.score, this.hiScore, right);

    this.message = el('div', 'hud-message');
    this.messageTitle = el('div', 'hud-message-title');
    this.messageBody = el('div', 'hud-message-body');
    this.message.append(this.messageTitle, this.messageBody);

    this.root.append(top, this.message);

    const showFps = import.meta.env.DEV || new URLSearchParams(location.search).has('fps');
    this.fps = showFps ? el('div', 'hud-fps') : null;
    if (this.fps) this.root.append(this.fps);

    overlay.appendChild(this.root);
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

  setLives(lives: number): void {
    if (lives === this.shown.lives) return;
    this.shown.lives = lives;
    this.lives.textContent = '▲'.repeat(Math.max(0, lives));
  }

  setWeaponLevel(level: number, max: number): void {
    if (level === this.shown.weapon) return;
    this.shown.weapon = level;
    this.weapon.textContent = `PWR ${'■'.repeat(level)}${'□'.repeat(max - level)}`;
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

function el(tag: 'div', className: string): HTMLDivElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
