# mobile-3d-game

**Nova Strike**: a vertical shoot 'em up for mobile browsers, built with Three.js, Vite and TypeScript.
Fly upward through space, shoot incoming aliens and dodge their fire.

**Live:** https://irreal.github.io/mobile-3d-game/

## Requirements

- Node.js 22.13+ (see `.nvmrc`; `nvm use` picks it up)
- npm

## Scripts

| Command                | What it does                                                  |
| ---------------------- | ------------------------------------------------------------- |
| `npm install`          | Install dependencies                                          |
| `npm run dev`          | Dev server with HMR at http://localhost:5173/mobile-3d-game/  |
| `npm run dev:host`     | Same, but reachable from other devices on your LAN            |
| `npm run build`        | Type-check, then build the production bundle into `dist/`     |
| `npm run preview`      | Serve the built `dist/` locally (`preview:host` for LAN)      |
| `npm run typecheck`    | TypeScript check only (`tsc --noEmit`)                        |
| `npm run lint`         | ESLint (`lint:fix` to auto-fix)                               |

The app is served under `/mobile-3d-game/` in dev too (matching GitHub Pages), so open
`http://localhost:5173/mobile-3d-game/`.

## Testing on a phone over LAN

1. Put the phone and your computer on the same Wi-Fi network.
2. Run `npm run dev:host` (equivalent to `vite --host`). Vite prints a `Network:` URL such as
   `http://192.168.1.23:5173/mobile-3d-game/`.
3. Open that URL on the phone. Code changes hot-reload on the device.

If the phone can't connect, allow Node through your computer's firewall for port 5173. To test the
production build instead, run `npm run build && npm run preview:host` (port 4173).

Some browser APIs (fullscreen, device orientation, vibration, etc.) require HTTPS on phones and
won't work over plain-HTTP LAN; use the deployed GitHub Pages site to test those.

## How to play

- **Touch:** drag anywhere to steer. The ship follows your finger's movement rather than jumping to
  where you touch, so keep your thumb below the ship where it doesn't block the view.
- **Desktop:** WASD / arrow keys, or drag with the mouse. Space / Enter / click starts a game.
- Your ship fires automatically. You have 3 lives. After a hit you blink (invulnerable) briefly,
  enemy bullets on screen are cleared, and you lose one weapon level.
- Your hitbox is only the small core of the ship; bullets grazing the wings don't count.
- Green gems power up your weapon (3 levels). Big purple aliens always drop one; others sometimes do.
- Enemies:
  - **Saucer** (green): drifts down, fires aimed shots.
  - **Dart** (orange): comes in snaking lines, fires straight down.
  - **Heavy** (purple): parks near the top, fires 5-way spreads, takes many hits.
- Difficulty (spawn rate, bullet speed, fire rate, formations) ramps up over about 2.5 minutes.

### Cockpit strikes (between waves)

Each wave is a fixed number of formations, and enemy HP grows each wave. Once the last enemy is
gone, the camera slowly swoops down behind the ship (with cinematic letterbox bars and a barrel
roll) into the cockpit. The HUD powers on (flicker, scan line, boot text), then you fight a
squadron ahead of you in first person:

- **Swipe over targets to lock on, lift your finger to fire** homing rockets at everything locked
  (up to 8 locks). A single tap on a target also works.
- Heavies need several locks: swipe over them repeatedly.
- Kills from the same volley **chain**: the 2nd kill scores ×2, the 3rd ×3, and so on.
- Enemies fire glowing plasma orbs at the cockpit. Lock and shoot them down before they hit you.
- Clear the squadron before the timer runs out for a bonus (more for time left). If time runs
  out, they escape.
- The camera then flies back out and the next, harder wave starts. Squadrons grow and gain heavies
  in later waves.
- The high score is stored in `localStorage`. Add `?fps` to the URL to show an FPS meter
  (always on in dev).

## Audio

All music and sound effects are synthesized at runtime with the Web Audio API. There are no audio
files, so there's nothing to license or download. There are two original tracks: *Nova Drive*
(shooter) and *Lock On* (cockpit). The music is muffled during camera transitions and crossfades
between the two sections. The speaker button (bottom-right) mutes all sound; the setting is saved.
Mobile browsers only allow audio after a user gesture, so sound starts with the first tap.

## Project structure

```
index.html                 Mobile viewport meta, #app mount point
public/                    Static files copied as-is (favicon, web app manifest)
src/
  main.ts                  Bootstraps engine, input, HUD and the game scene
  config.ts                Engine tunables: pixel-ratio cap, camera, antialias
  style.css                Full-screen canvas, gesture blocking, HUD styles
  core/
    Engine.ts              WebGLRenderer + camera, resize handling, active GameScene
    GameLoop.ts            setAnimationLoop wrapper, clamped delta, pauses when hidden
    viewport.ts            Resize/orientation observers, default touch gesture blocking
  input/
    Input.ts               Relative drag steering, keyboard axis, tap events
    Keyboard.ts            Held-key tracking for desktop
  game/
    ShooterScene.ts        Game states (title/playing/game over), weapons, collisions, scoring
    constants.ts           Gameplay tuning: playfield size, player, bullets, power-ups
    Playfield.ts           Fits the camera so the arena works on any aspect ratio
    PlayerShip.ts          Player ship visuals: banking, engine flicker, blink
    Enemy.ts               Enemy types, stats, movement and firing patterns
    WaveSpawner.ts         Formations and difficulty ramp over time
    InstancedPool.ts       Instanced-mesh pool for bullets/particles (1 draw call each)
    Effects.ts             Explosion particles
    Starfield.ts           Parallax scrolling stars
    models.ts              Procedural placeholder models (ship, aliens, power-up)
    CameraDirector.ts      Camera pose: top-down ↔ cockpit fly-in/out transition, shake
    CockpitSection.ts      First-person strike: squadron, orbs, lock-on painting, homing rockets
    WarpField.ts           Speed-line streaks shown in first person
  audio/
    AudioEngine.ts         Web Audio graph (music/sfx buses, echo, filter), synth voices, unlock
    Music.ts               Lookahead step sequencer: drums, bass, arp, pads, lead
    songs.ts               Song data (chords, patterns, melodies)
    Sfx.ts                 Synthesized sound effects
    GameAudio.ts           Bundles engine, music and sfx
  ui/
    Hud.ts                 Score, high score, wave, lives, weapon level, messages, FPS meter
    CockpitOverlay.ts      Canopy frame, crosshair, lock reticles, timer, callouts, hit flash
```

Gameplay happens on the z = 0 plane with +y as "up the screen"; the top-down camera looks straight
down the -z axis. In the cockpit, the camera sits on the ship looking along +y with +z as up, so
both views share one world. Most balance changes go in `src/game/constants.ts` (including `WAVES` and `COCKPIT`), `ENEMY_STATS` in `Enemy.ts`, and
the formation rules in `WaveSpawner.ts`.

### Mobile notes

- `devicePixelRatio` is capped at 2 (`config.maxPixelRatio`) to keep fill rate manageable.
- The canvas buffer is resized on element resize, window resize, orientation change and mobile
  browser toolbar changes (`visualViewport`). The camera pulls back on narrow portrait screens so
  the arena is always at least `PLAYFIELD.minWidth` wide.
- Pinch-zoom, double-tap zoom, pull-to-refresh, scroll bounce, text selection and long-press menus
  are disabled via the viewport meta, CSS `touch-action`/`overscroll-behavior`, and event listeners.

## Deployment

Every push to `main` (or a manual run from the **Actions** tab via *Run workflow*) triggers
`.github/workflows/deploy.yml`, which:

1. Installs dependencies with `npm ci`, runs `npm run lint` and `npm run build`.
2. Uploads `dist/` with `actions/upload-pages-artifact`.
3. Deploys it with `actions/deploy-pages` to https://irreal.github.io/mobile-3d-game/.

The repo's Pages source must be set to **GitHub Actions** (Settings → Pages). Vite's `base` is
set to `/mobile-3d-game/` in `vite.config.ts`; change it if the repo is renamed or a custom domain
is used (use `/` for a custom domain or a `<user>.github.io` repo).
