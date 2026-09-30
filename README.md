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
- Your ship fires automatically. You have 3 lives. After a hit you blink (invulnerable) briefly
  and enemy bullets on screen are cleared. Weapon levels are kept.
- Your hitbox is only the small core of the ship; bullets grazing the wings don't count.
- **Two weapons, upgraded separately** (levels shown top-right as `LSR` and `RKT`):
  - **Lasers** (levels 1–5): fast bolts, 1 damage each; more and wider bolts, then faster fire.
  - **Rockets** (levels 0–4): slow salvos, 6 damage each. Level 1 unlocks them, 2 fires two,
    3 adds homing, 4 fires three with splash damage.
- **Power-ups are deterministic:** only heavies drop them, and every heavy drops exactly one.
  Heavies come at fixed points in each wave (one per wave in waves 1–2, then two). Drops
  alternate rocket (orange capsule) and laser (cyan gem), starting with rockets, and skip a
  weapon that's already maxed. With both maxed, a pickup is worth bonus points. Tuning lives in
  `LASER_LEVELS`, `ROCKET_LEVELS`, `ROCKET` and `WAVES.tankSlots` in `constants.ts`.
- Enemies (a red faction):
  - **Grunt:** drifts down, fires aimed shots.
  - **Weaver:** comes in snaking lines, fires straight down.
  - **Heavy:** big saucer; parks near the top, fires 5-way spreads, takes many hits, drops a power-up.
- Difficulty (spawn rate, bullet speed, fire rate, formations) ramps up over about 2.5 minutes.

### Cockpit strikes (between waves)

Each wave is a fixed number of formations, and enemy HP grows each wave. After every second wave
(2, 4, 6, …), once the last enemy is gone, the camera slowly swoops down behind the ship (with cinematic letterbox bars and a barrel
roll) into the cockpit. The HUD powers on (flicker, scan line, boot text), then the enemy
squadron drops out of warp right in front of you and you fight it in first person:

The fight is a **call-and-response rhythm game locked to the cockpit music** (146 BPM), in
phrases of three bars (call bar, response bar, then a rest bar):

- **WATCH (call bar):** enemies drop out of warp one at a time on an 8th-note rhythm. Each warp
  flash lands on the beat with its own tone (climbing the current chord), and a number pops up to
  show its place in the sequence.
- **REPEAT (response bar):** tap the enemies back **in the same order and rhythm**, one bar later.
  Each target shows its number, the next one is highlighted and a ring closes on it over the last
  beat. The bar at the bottom shows the call (hollow) and the reply (solid) scrolling toward the
  hit line; the indicator at the top shows WATCH/REPEAT and the beat within the bar. The switch
  to your turn is marked by a riser over the last beat of the call ending in a chime and a gold
  flash on the downbeat, which is your first tap. During strikes the music is ducked slightly so calls and taps stand out.
- Timing is judged against what you *hear* (the audio clock, corrected for output latency) using
  the touch event's own timestamp: **PERFECT** within ±70 ms, **GREAT** ±130 ms, **GOOD** ±200 ms.
  Tapping a target far too early is a MISS, so spamming doesn't work.
- Every hit fires a rocket that lands on the next 8th note after a short flight; impact sounds are
  scheduled on the music clock, so explosions hit on the beat. Replies play the same tones as the
  calls, so the response "answers" the call melody.
- After a miss nothing new warps in. Enemies you missed **fire back** at the end of the response
  (a volley that lands 1½ beats later)
  and warp away. Each volley costs one of 3 shield pips (refilled every strike); with the shield
  down it costs a life. A hit interrupts the sequence: every ship still on the field flies away,
  and after a pause of about two bars (to get your bearings) a fresh phrase starts on a bar line.
- **Heavies** (orange, from the second strike) stay on the field and join one call per phrase
  until they've been hit twice.
- Rhythms get denser with each strike and again halfway through; from level 3 the sequence jumps
  around the screen instead of reading left to right. A strike is 6 phrases, +1 per strike.
- **Combo:** ×1.5 score from 8 hits in a row; at 16 you enter **Overdrive** (gold rockets, ×2).
  The strike bonus scales with accuracy and adds your max combo.
- The music keeps playing while paused; on resume the chart moves back by whole phrases so it
  stays on the beat. `COCKPIT.inputOffsetMs` in `constants.ts` can compensate for touch latency.
- The first-person view is an actual cockpit interior (dashboard, canopy glass and struts) that
  the camera flies into; its dashboard lights power on with the HUD.
- The camera then flies back out and the next, harder wave starts. Squadrons grow and gain heavies
  in later waves.
- The high score is stored in `localStorage`. Add `?fps` to the URL to show an FPS meter
  (always on in dev).

## Menus, tutorials and version

- **Pause** with the pause button (bottom-right, during play), Esc or P. The game also pauses when
  the tab/app goes to the background. The menu has Resume, Restart, Sound on/off, Effects
  High/Low, Show tutorials again, and Quit to title.
- **Cockpit test** (pause menu, for testing): buttons 1–5 jump straight into that cockpit strike
  level of the current game (the fly-in plays, then the squadron for that strike).
- Dying in the cockpit keeps the first-person view for the game-over screen.
- **Tutorials:** a quick "How to fly" card at the start of each game, and a "Cockpit strike" card the
  first time you enter the cockpit in each game. From the third time a card is shown, it offers
  a *Don't show again* checkbox. Show counts and opt-outs are stored in `localStorage`
  (`nova-strike:tutorial:*`). *Show tutorials again* in the pause menu clears them.
- **Version:** bottom-left shows `v<package.json version> · <commit>`. Both are injected at build
  time by `vite.config.ts` (the commit comes from `GITHUB_SHA` in CI, or `git` locally). Bump
  `version` in `package.json` for releases.

## Graphics

- **Ships:** the player ship and enemies come from Quaternius'
  [Ultimate Spaceships pack](https://quaternius.com/packs/ultimatespaceships.html) (CC0, public
  domain; license in `public/assets/ships/`). The player flies the blue *Challenger*; the enemy
  faction flies red ships: *Bob* (grunt), *Dispatcher* (weaver) and *Pancake* (heavy). The OBJ
  sources were converted to GLB (`obj2gltf` + `gltf-transform weld`) with textures downscaled to
  512–1024 px JPEG. `loadShipModels()` in `models.ts` loads them at startup and bakes orientation
  and size into the geometry; if loading fails, the old procedural models are used.
- **Cockpit interior:** "Space ship cockpit" by Ville Seppanen (Osmic) from
  [OpenGameArt](https://opengameart.org/content/space-ship-cockpit), CC-BY 3.0 (attribution
  required; credited in the pause menu, license in `public/assets/cockpit/`). Loaded as OBJ by
  `CockpitInterior.ts`, which gives each named part a material and places it at the pilot's eye.
- **Post-processing** (`src/core/PostFx.ts`): an HDR render target with MSAA, bloom
  (`UnrealBloomPass` at half resolution), and a custom final shader with zoom blur (camera fly-in/out),
  chromatic aberration (hits, big explosions), screen-space shockwave ripples, vignette and film
  grain, then tone mapping.
- **Effects:** soft camera-facing glow sprites (`glow.ts`) for sparks, explosion flashes, enemy
  bullets, orbs and engine glows; chunky debris; expanding shock rings; a procedural nebula sky
  dome (`Nebula.ts`) and round glowing stars.
- **Effects: Low** in the pause menu renders straight to the screen (no post-processing) for
  slower phones; the choice is saved in `localStorage` (`nova-strike:fx`). With effects on,
  the pixel ratio is capped at 1.5 (`config.maxPixelRatioFx`).

## Audio

All music and sound effects are synthesized at runtime with the Web Audio API. There are no audio
files, so there's nothing to license or download. There are two original tracks: *Nova Drive*
(shooter) and *Lock On* (cockpit). The music is muffled during camera transitions and crossfades
between the two sections. The speaker button (bottom-right) mutes all sound; the setting is saved.
Mobile browsers only allow audio after a user gesture, so sound starts with the first tap.

## Project structure

```
index.html                 Mobile viewport meta, #app mount point
public/                    Static files copied as-is (favicon, web app manifest, ship models)
src/
  main.ts                  Bootstraps engine, input, HUD and the game scene
  config.ts                Engine tunables: pixel-ratio cap, camera, antialias
  style.css                Full-screen canvas, gesture blocking, HUD styles
  core/
    Engine.ts              WebGLRenderer + camera, resize handling, active GameScene
    PostFx.ts              Bloom + final shader (zoom blur, aberration, shockwaves, vignette)
    GameLoop.ts            setAnimationLoop wrapper, clamped delta, pauses when hidden
    viewport.ts            Resize/orientation observers, default touch gesture blocking
  input/
    Input.ts               Relative drag steering, keyboard axis, tap and timestamped press events
    Keyboard.ts            Held-key tracking for desktop
  game/
    ShooterScene.ts        Game states (title/playing/game over), weapons, collisions, scoring
    constants.ts           Gameplay tuning: playfield size, player, bullets, power-ups
    Playfield.ts           Fits the camera so the arena works on any aspect ratio
    PlayerShip.ts          Player ship visuals: banking, engine flicker, blink
    Enemy.ts               Enemy types, stats, movement and firing patterns
    WaveSpawner.ts         Formations and difficulty ramp over time
    InstancedPool.ts       Instanced-mesh pool for bullets/particles (1 draw call each)
    Effects.ts             Glow sparks, debris, flashes and shock rings
    glow.ts                Camera-facing additive glow sprite shader
    Nebula.ts              Procedural nebula sky dome
    Starfield.ts           Parallax scrolling stars
    models.ts              GLB ship loading (with procedural fallbacks), power-up models
    CockpitInterior.ts     3D cockpit interior for the first-person view
    CameraDirector.ts      Camera pose: top-down ↔ cockpit fly-in/out transition, shake
    CockpitSection.ts      First-person strike: call-and-response phrases, rockets, return fire, combo
    WarpField.ts           Speed-line streaks shown in first person
  audio/
    AudioEngine.ts         Web Audio graph (music/sfx buses, echo, filter), synth voices, unlock
    Music.ts               Lookahead step sequencer (drums, bass, arp, pads, lead) + beat clock
    songs.ts               Song data (chords, patterns, melodies)
    Sfx.ts                 Synthesized sound effects
    GameAudio.ts           Bundles engine, music and sfx
  ui/
    Hud.ts                 Score, high score, wave, lives, laser/rocket levels, messages, FPS meter
    CockpitOverlay.ts      Canopy frame, beat pulse, approach rings, beat lane, combo, callouts
    PauseMenu.ts           Pause button and pause menu
    Tutorial.ts            Tutorial cards and their show-count / opt-out storage
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
