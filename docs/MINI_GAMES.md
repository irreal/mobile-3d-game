# Between-wave mini-games

Every `COCKPIT.everyWaves` waves (every second wave), the camera flies into the cockpit and the
player plays a first-person mini-game: a strike. The code is in `src/game/minigames/`:

| File | What it is |
| --- | --- |
| `MiniGame.ts` | The interface a mini-game implements, plus the context, frame and callbacks it gets |
| `registry.ts` | `MINI_GAMES` (every mini-game, with its settings), `pickMiniGame` (which one plays) and `MiniGameLibrary` (creates each one on first use) |
| `AsteroidRun.ts` | Asteroids: steer through an asteroid field in space (enabled) |
| `RhythmStrike.ts` | Rhythm: call-and-response dogfight over planets (disabled for now) |

## What the scene does, and what the game does

`ShooterScene` runs everything around a mini-game, the same way for all of them:

1. **Wave clear.** `pickMiniGame(world, strike)` picks the game. If none is enabled for that
   world, there's no strike: the ship flies straight on to the next world in the top-down
   view (the `transit` phase), and from the last base on to the ending.
2. **Enter.** The base is cleared, the camera flies into the cockpit, and `game.start(context)`
   is called (`frame.active` is false until the camera has arrived). Then the HUD powers on and
   the entry's `music` starts. Its `tutorial` is offered once per game, if it has one.
3. **Play.** `game.update(dt, frame)` runs every frame. Input arrives through `tap`, `drag` and
   `release`, and `frame.drag` / `frame.axis` for steering. Use the callbacks to score
   (`addScore`), hurt the player (`playerHit`: barrier, then lives and gun level, game over)
   and make big explosions (`blast`). When the player is hit, the scene calls
   `clearIncoming()`.
4. **Results.** When `update` returns `'cleared'`, the scene shows `result()` with the clear
   bonus: `COCKPIT.clearBonusPerWave × wave × accuracy + maxCombo × COCKPIT.maxComboBonus`.
   It keeps calling `update` while the card is up, so animations can finish.
5. **Exit.** The camera flies out (into the next world if it changes), then `game.clear()` is
   called and the next wave starts.

**Pause.** While paused (or a tutorial is open) the game gets no updates. `onResume()` is called
when play resumes, so a game timed by an outside clock (Rhythm follows the music) can
re-align. `clear()` can also be called at any point (game over, quit, restart), so it must
always leave the game stopped and hidden.

**Co-op.** Mini-games aren't shared: each player plays their own strike. The pick depends only
on the strike number and world, so the whole squad gets the same game. Remote ships are
hidden while players are in the cockpit, and the server holds the next wave until everyone is
ready (or 20 s pass). `context.squad` is the squad size, if a game wants to scale with it.

## Adding a mini-game

1. Create `src/game/minigames/MyGame.ts` with a class that implements `MiniGame`. The
   constructor gets its parts from `MiniGameDeps` (scene, effects, cockpit overlay, sfx, music,
   callbacks). Put its 3D objects in a `Group` that you add to the scene once, and hide it in
   `clear()`. Position it from `frame.eye` (the cockpit camera) each frame. `AsteroidRun` is
   the simplest example.
2. Draw its 2D HUD with `CockpitOverlay`. Add a mode next to `'rhythm'` / `'asteroids'` if it
   needs its own elements.
3. Add an entry to `MINI_GAMES` in `registry.ts`:

   ```ts
   {
     id: 'mygame',
     name: 'My game',             // pause-menu test row
     enabled: true,               // false: never picked between waves (the test row still works)
     worlds: ['space'],           // 'space' and/or 'planet'
     music: LOCK_ON,
     tutorial: undefined,         // or a TutorialId shown before its first strike
     create: (d) => new MyGame(d.scene, d.effects, d.overlay, d.sfx, d.callbacks),
   },
   ```

   Enabled games for the same world take turns: strike N plays fits[(N - 1) % fits.length].
4. Test it: pause menu → "My game test" → 1 / 2 / 3 starts it at its 1st / 2nd / 3rd strike
   in a world it fits.

To bring Rhythm back over planets, set `enabled: true` on its entry.
