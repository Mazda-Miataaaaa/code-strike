# CODE-STRIKE

A team-based FPS in the spirit of Counter-Strike, with one twist: **weapons are not purchased — they are programmed**. A round is won by eliminating the enemy team **or** by hacking two servers on the map with code.

**MVP status:** 2v2 with bots, one symmetric map, 2 vulnerability classes, weapon/exploit/patch editors, full round loop.

---

## Engine choice (and why not Godot 4)

The task allows a justified alternative to Godot 4. This MVP uses **TypeScript + Node.js (authoritative server) + three.js (browser client) + Lua-in-WASM (wasmoon)**:

- The core of the game — the Lua sandbox, the weapon DSL, the vulnerable services, the match loop — must be **verifiable by automated tests in CI**. A headless Node server lets all 12 tests (including "infinite loop gets killed" and "full match from spawn to victory") run without a GUI runtime.
- Lua scripting requires a real embedded VM with an instruction budget. `wasmoon` compiles Lua 5.4 to WASM and runs it in a dedicated worker thread that is **terminated and respawned** when a script exceeds its budget — a hard kill that cannot be escaped.
- The client is a thin renderer: the server computes every shot and every hack; the client only sends input and draws pre-computed events. This is anti-cheat by design and matches the task's networking requirements.

Porting the gameplay layer to Godot later is straightforward: the shared protocol (`shared/protocol.ts`) and the Lua sandbox contract are engine-agnostic.

## Architecture

```
client/            three.js renderer + editors (weapon / exploit / patch), sends input only
public/            static client bundle (esbuild output + index.html)
server/
  main.ts          WebSocket server, static files, bot spawning, 20 Hz tick
  game/
    match.ts       match state machine: phases, players, shots, respawn, victory
    map.ts         symmetric map: walls, spawns, raycasting (slab), collision
    config.ts      typed access to config/balance.json
  services/
    vulnService.ts in-game servers with a readable Lua source, exploit runner, patch self-check
  sandbox/
    pool.ts        Lua sandbox host: worker lifecycle, instruction budget, kill & respawn
    worker.mjs     wasmoon (Lua 5.4 in WASM) worker; os/io/package/debug removed
shared/
  protocol.ts      wire protocol (ClientToServer / ServerToClient), WeaponSpec
  budget.ts        spec validation + point-budget calculator
  templates.ts     starter weapon templates (AK, AWP, SMG, Cannon)
config/
  balance.json     ALL tunables: budget, costs, match timing, sandbox limits
test/              12 automated tests (sandbox, budget, services, full match)
```

### Round flow

1. **Prep (75 s)** — both teams open terminals, read the server source, write weapon scripts and defense patches. Patches deploy after passing a self-check (legitimate logins must keep working).
2. **Live (240 s)** — FPS gameplay. Open a terminal to hack (you are defenseless while coding — your team covers you). Exploits run server-side against the real Lua service; success marks the server hacked. Hack **both** servers or eliminate the enemy team to win.
3. **End** — victory screen with scoreboard.

## Weapon DSL

A weapon is a Lua script that returns a table:

```lua
return {
  name = "AK",
  hp = 100,             -- your character's HP is part of the budget!
  damage = 15,
  fireIntervalMs = 100,
  hitscan = true,
  projectileSpeed = 200,  -- only for hitscan = false
  magazine = 30,
  reloadMs = 2000,
  recoil = 0.6,
  spreadDeg = 2.0,
  knockback = 0.2,
  slow = 0,               -- seconds of slow on hit
  aoeRadius = 0,          -- splash damage
  aoeDamageFalloff = 0.5,
}
```

**Point budget:** every parameter costs points (see `config/balance.json`); the total must not exceed 100. Want a one-shot weapon? Take 20 HP and a 4-second reload. The editor refuses to save scripts over budget. All costs and limits live in the config — no rebuild needed to retune.

**Sandbox guarantees:** scripts run in an isolated WASM Lua VM inside a dedicated worker, with `os`/`io`/`package`/`debug` removed and no access to the world beyond the exposed table contract. A script that exceeds the instruction budget (e.g. `while true do end`) is killed — the worker is terminated and respawned — and the server keeps running. Shot and hack results are computed only on the server.

## Hacking

Two vulnerability classes in the auth service (readable at the terminal):

- **SQL injection** — `login()` builds its query with raw string concatenation (`".. user .."`).
- **Missing rate limit** — `checkPin()` counts attempts but never limits them.

Attackers write an exploit that calls the service functions and triggers the flaw. Defenders write a patch defining `validate(s)` and/or `rate(key)`; the patch is wrapped around the service and must pass a self-check (legitimate `admin`/`guest` logins still work) or it is rejected. A correct patch blocks both exploit types.

## Running

Requirements: Node.js ≥ 20.

```bash
npm install
npm run dev        # build server + client, then start on :8090
```

Open `http://localhost:8090`, enter a nickname, join. Bots spawn automatically (`BOTS=0 npm start` to disable).

Tests:

```bash
npm run build
npm test
```

Configuration lives in `config/balance.json` (budget costs, phase durations, sandbox limits, movement speed).

## Later (out of MVP scope)

- More vulnerability types (buffer overflow, race condition, deserialization)
- More maps, skins, matchmaking, 5v5
- Lua debug hooks for per-instruction accounting (currently a hard wall-clock budget on a dedicated worker)
- Client-side prediction and lag compensation
- Honeypot services alerting the defense
