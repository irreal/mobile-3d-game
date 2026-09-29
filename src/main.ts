import './style.css';
import { Engine } from './core/Engine.ts';
import { PlaygroundScene } from './game/PlaygroundScene.ts';
import { Input } from './input/Input.ts';
import { Hud } from './ui/Hud.ts';

const container = document.querySelector<HTMLElement>('#app');
if (!container) throw new Error('#app container not found');

const engine = new Engine(container);
const input = new Input(engine.canvas, container);
const hud = new Hud(container);

engine.setScene(new PlaygroundScene(engine.camera, input));
engine.onFrame((dt) => hud.update(dt));
engine.start();
