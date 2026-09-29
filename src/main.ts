import './style.css';
import { Engine } from './core/Engine.ts';
import { ShooterScene } from './game/ShooterScene.ts';
import { Input } from './input/Input.ts';
import { Hud } from './ui/Hud.ts';

const container = document.querySelector<HTMLElement>('#app');
if (!container) throw new Error('#app container not found');

const engine = new Engine(container);
const input = new Input(engine.canvas);
const hud = new Hud(container);

engine.setScene(new ShooterScene(engine.camera, input, hud));
engine.onFrame((dt) => hud.tick(dt));
engine.start();
