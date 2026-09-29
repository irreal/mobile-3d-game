# mobile-3d-game

Three.js 3D game for mobile browsers, built with Vite + TypeScript.

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

Controls: drag anywhere on the screen to move (floating virtual joystick), tap **JUMP** to jump.
On desktop: WASD / arrow keys and Space, or drag with the mouse.

## Project structure

```
index.html                 Mobile viewport meta, #app mount point
public/                    Static files copied as-is (favicon, web app manifest)
src/
  main.ts                  Bootstraps engine, input, HUD and the initial scene
  config.ts                Tunables: pixel-ratio cap, camera FOVs, joystick, shadows
  style.css                Full-screen canvas, gesture blocking, touch UI styles
  core/
    Engine.ts              WebGLRenderer + camera, resize handling, active GameScene
    GameLoop.ts            setAnimationLoop wrapper, clamped delta, pauses when hidden
    viewport.ts            Resize/orientation observers, default touch gesture blocking
  input/
    Input.ts               Unified input (move vector + jump) from touch and keyboard
    VirtualJoystick.ts     Floating on-screen joystick (pointer events, multi-touch safe)
    ActionButton.ts        On-screen touch button
    Keyboard.ts            Held-key tracking for desktop
  game/
    PlaygroundScene.ts     Placeholder level: lights, ground, crates, follow camera
    Player.ts              Controllable character: movement, jump, box collisions
  ui/
    Hud.ts                 FPS counter and controls hint
```

To add a level, implement the `GameScene` interface from `src/core/Engine.ts` (a `scene` plus an
`update(dt)` method) and pass it to `engine.setScene(...)`.

### Mobile notes

- `devicePixelRatio` is capped at 2 (`config.maxPixelRatio`) to keep fill rate manageable.
- The canvas buffer is resized on element resize, window resize, orientation change and mobile
  browser toolbar changes (`visualViewport`); the camera widens its FOV in portrait.
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
