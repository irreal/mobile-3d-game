import './style.css';
import { GameAudio } from './audio/GameAudio.ts';
import { Engine } from './core/Engine.ts';
import { loadShipModels } from './game/models.ts';
import { ShooterScene } from './game/ShooterScene.ts';
import { Input } from './input/Input.ts';
import { CockpitOverlay } from './ui/CockpitOverlay.ts';
import { Hud } from './ui/Hud.ts';

const container = document.querySelector<HTMLElement>('#app');
if (!container) throw new Error('#app container not found');

const engine = new Engine(container);
const input = new Input(engine.canvas);
const hud = new Hud(container);
const cockpitOverlay = new CockpitOverlay(container);
const audio = new GameAudio();
hud.addMuteButton(audio.engine.muted, () => audio.engine.toggleMuted());
audio.engine.onMuteChange((muted) => hud.setMuted(muted));

hud.showMessage('NOVA STRIKE', 'Loading…');
await loadShipModels();

engine.setScene(
  new ShooterScene(engine.camera, input, audio, { container, hud, cockpit: cockpitOverlay }, engine.fx),
);
engine.onFrame((dt) => hud.tick(dt));
engine.start();
