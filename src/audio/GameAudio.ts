import { AudioEngine } from './AudioEngine.ts';
import { Music } from './Music.ts';
import { Sfx } from './Sfx.ts';

export class GameAudio {
  readonly engine = new AudioEngine();
  readonly music = new Music(this.engine);
  readonly sfx = new Sfx(this.engine);
}
