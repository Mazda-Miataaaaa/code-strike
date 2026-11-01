import type { WeaponSpec, MatchState, PlayerState, Team, Vec3, ServerToClient, ClientToServer, WinReason } from '../../shared/protocol.js';
import { validateSpec, specPoints } from '../../shared/budget.js';
import { makeMap, collide, raycast, norm, add, scale, dist, sub } from './map.js';
import { makeServiceMap, type GameServiceMap } from '../services/vulnService.js';
import { LuaSandbox } from '../sandbox/pool.js';
import { WEAPON_TEMPLATES } from '../../shared/templates.js';
import type { MatchConfig } from './config.js';

const BOT_NAMES = ['Bot-Rex', 'Bot-Vox', 'Bot-Zed', 'Bot-Nyx', 'Bot-Ace', 'Bot-Kai'];
const ROUNDS_TO_WIN = 5;

function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export interface PlayerHandle {
  id: number;
  name: string;
  team: Team;
  bot: boolean;
  hp: number;
  maxHp: number;
  pos: Vec3;
  yaw: number;
  alive: boolean;
  respawnAt: number;
  weapon: WeaponSpec;
  ammo: number;
  lastShotAt: number;
  reloadUntil: number;
  kills: number;
  deaths: number;
  hacks: number;
  slowUntil: number;
  terminal: number | null;
  botState?: { targetId: number | null; nextDecisionAt: number; lastSeen: number; seenSince: number; strafeDir: number };
}

interface Projectile { pos: Vec3; dir: Vec3; speed: number; shooterId: number; spec: WeaponSpec; life: number }

export class Match {
  players = new Map<number, PlayerHandle>();
  private nextPlayerId = 1;
  private botCounter = 0;
  private map = makeMap();
  private services: GameServiceMap;
  private sandbox: LuaSandbox;
  private cfg: MatchConfig;
  phase: 'lobby' | 'prep' | 'live' | 'ended' = 'lobby';
  phaseEndsAt = 0;
  score = { red: 0, blue: 0 };
  matchWinner: Team | null = null;
  winner: Team | null = null;
  winReason: WinReason | null = null;
  hackAlerts: { team: Team; serverId: number; at: number }[] = [];
  private projectiles: Projectile[] = [];
  private events: ServerToClient[] = [];

  constructor(sandbox: LuaSandbox, cfg: MatchConfig) {
    this.sandbox = sandbox;
    this.cfg = cfg;
    this.services = makeServiceMap(cfg.serversToHack, cfg.pinLength);
  }

  getMap() { return this.map; }
  getServices() { return this.services; }
  takeEvents(): ServerToClient[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  addPlayer(name: string, team: Team, bot: boolean): PlayerHandle {
    const id = this.nextPlayerId++;
    const spec = WEAPON_TEMPLATES[0] ? this.templateSpec(WEAPON_TEMPLATES[0].code) : null;
    const p: PlayerHandle = {
      id, name, team, bot,
      hp: spec?.hp ?? 100, maxHp: spec?.hp ?? 100,
      pos: { ...this.spawnPoint(team, id) },
      yaw: 0, alive: true, respawnAt: 0,
      weapon: spec ?? this.fallbackSpec(),
      ammo: spec?.magazine ?? 20, lastShotAt: 0, reloadUntil: 0,
      kills: 0, deaths: 0, hacks: 0, slowUntil: 0, terminal: null,
      botState: bot ? { targetId: null, nextDecisionAt: 0, lastSeen: 0, seenSince: 0, strafeDir: Math.random() < 0.5 ? 1 : -1 } : undefined,
    };
    this.players.set(id, p);
    return p;
  }

  removePlayer(id: number) {
    this.players.delete(id);
  }

  pickTeam(): Team {
    const humans = { red: 0, blue: 0 };
    for (const p of this.players.values()) if (!p.bot) humans[p.team]++;
    return humans.red <= humans.blue ? 'red' : 'blue';
  }

  rebalanceBots() {
    const per = this.cfg.playersPerTeam || 2;
    for (const team of ['red', 'blue'] as Team[]) {
      let members = [...this.players.values()].filter((p) => p.team === team);
      while (members.length > per) {
        const bot = members.find((p) => p.bot);
        if (!bot) break;
        this.players.delete(bot.id);
        members = members.filter((p) => p !== bot);
      }
      while (members.length < per) {
        const name = BOT_NAMES[this.botCounter++ % BOT_NAMES.length];
        members.push(this.addPlayer(name, team, true));
      }
    }
  }

  private templateSpec(code: string): WeaponSpec | null {
    return this.fallbackSpec();
  }

  private fallbackSpec(): WeaponSpec {
    return {
      name: 'SMG', hp: 100, damage: 6, fireIntervalMs: 60, hitscan: true,
      projectileSpeed: 180, magazine: 25, reloadMs: 1400, recoil: 0.25,
      spreadDeg: 3, knockback: 0, slow: 0, aoeRadius: 0, aoeDamageFalloff: 0.5,
    };
  }

  spawnPoint(team: Team, id: number): Vec3 {
    const list = this.map.spawns[team];
    return list[(id - 1) % list.length];
  }

  async saveWeapon(playerId: number, code: string): Promise<{ ok: boolean; error?: string; spec?: WeaponSpec; points?: number }> {
    const r = await this.sandbox.run(code, { timeoutMs: this.cfg.scriptTimeoutMs });
    if (!r.ok) {
      return { ok: false, error: r.killed ? 'script killed: instruction budget exceeded' : `script error: ${r.error}` };
    }
    if (typeof r.value !== 'object' || r.value === null) {
      return { ok: false, error: 'script must return a table' };
    }
    const v = validateSpec(r.value as Record<string, unknown>);
    if (!v.ok) return { ok: false, error: v.error };
    const report = specPoints(v.spec!);
    if (!report.ok) {
      return { ok: false, error: `budget exceeded: ${report.total} > ${this.cfg.totalPoints} points`, points: report.total };
    }
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: 'not in match' };
    p.weapon = v.spec!;
    p.maxHp = v.spec!.hp;
    p.hp = Math.min(p.hp <= 0 ? v.spec!.hp : p.hp, v.spec!.hp) || v.spec!.hp;
    if (p.hp <= 0) p.hp = v.spec!.hp;
    p.ammo = v.spec!.magazine;
    return { ok: true, spec: v.spec!, points: report.total };
  }

  openTerminal(playerId: number, serverId: number): boolean {
    const p = this.players.get(playerId);
    if (!p || !p.alive) return false;
    const term = this.map.terminals.find((t) => t.serverId === serverId);
    if (!term) return false;
    if (dist(p.pos, term.pos) > 3) return false;
    p.terminal = serverId;
    return true;
  }

  closeTerminal(playerId: number) {
    const p = this.players.get(playerId);
    if (p) p.terminal = null;
  }

  async submitExploit(playerId: number, serverId: number, code: string): Promise<{ ok: boolean; log: string[] }> {
    const p = this.players.get(playerId);
    if (!p || p.terminal !== serverId) return { ok: false, log: ['must be at the terminal'] };
    const svc = this.services.get(serverId);
    if (!svc) return { ok: false, log: ['no such server'] };
    const res = await svc.runExploit(this.sandbox, code, p.team);
    if (res.ok) {
      p.hacks++;
      this.hackAlerts.push({ team: p.team, serverId, at: Date.now() });
      const hackedCount = this.services.services.filter((s) => s.isDown).length;
      if (hackedCount >= this.cfg.serversToHack) {
        this.endRound(p.team, 'hack');
      }
    }
    return res;
  }

  async submitPatch(playerId: number, serverId: number, code: string): Promise<{ accepted: boolean; log: string[] }> {
    const p = this.players.get(playerId);
    if (!p) return { accepted: false, log: ['not in match'] };
    if (this.phase !== 'prep' && this.phase !== 'live') {
      return { accepted: false, log: ['patches can only be applied during prep or live phase'] };
    }
    const svc = this.services.get(serverId);
    if (!svc) return { accepted: false, log: ['no such server'] };
    return svc.applyPatch(this.sandbox, code);
  }

  input(playerId: number, msg: Extract<ClientToServer, { t: 'input' }>) {
    const p = this.players.get(playerId);
    if (!p || !p.alive || this.phase !== 'live') return;
    if (p.terminal !== null) return;
    const speed = this.cfg.playerSpeed * (Date.now() < p.slowUntil ? 0.5 : 1);
    const dt = Math.max(0, Math.min(Number(msg.dt) || 0, 0.1));
    let mx = Math.max(-1, Math.min(1, Number(msg.move?.x) || 0));
    let mz = Math.max(-1, Math.min(1, Number(msg.move?.z) || 0));
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const yaw = Number.isFinite(msg.yaw) ? msg.yaw : p.yaw;
    const pitch = Number.isFinite(msg.pitch) ? Math.max(-1.2, Math.min(1.2, msg.pitch)) : 0;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const nx = p.pos.x + (mz * sy - mx * cy) * speed * dt;
    const nz = p.pos.z + (mz * cy + mx * sy) * speed * dt;
    p.pos = collide({ x: nx, y: 0, z: nz }, this.map, this.cfg.playerRadius);
    p.yaw = yaw;
    if (msg.shoot) this.tryShoot(p, pitch);
  }

  private tryShoot(p: PlayerHandle, pitch: number) {
    const now = Date.now();
    if (now < p.reloadUntil || now - p.lastShotAt < p.weapon.fireIntervalMs) return;
    if (p.ammo <= 0) {
      p.reloadUntil = now + p.weapon.reloadMs;
      p.ammo = p.weapon.magazine;
      return;
    }
    p.lastShotAt = now;
    p.ammo--;
    const spreadRad = (p.weapon.spreadDeg * Math.PI) / 180;
    const yawJitter = (Math.random() - 0.5) * spreadRad;
    const pitchRad = pitch + (Math.random() - 0.5) * spreadRad;
    const dir = {
      x: Math.sin(p.yaw + yawJitter) * Math.cos(pitchRad),
      y: Math.sin(pitchRad),
      z: Math.cos(p.yaw + yawJitter) * Math.cos(pitchRad),
    };
    const origin = add(p.pos, { x: 0, y: this.cfg.playerEye, z: 0 });
    if (p.weapon.hitscan) {
      this.resolveShot(p, origin, dir, 100);
    } else {
      this.projectiles.push({
        pos: origin, dir, speed: p.weapon.projectileSpeed, shooterId: p.id, spec: p.weapon, life: 0,
      });
    }
    this.events.push({ t: 'shot', shooterId: p.id, from: origin, to: add(origin, scale(dir, 100)), weapon: p.weapon.name });
  }

  private resolveShot(shooter: PlayerHandle, origin: Vec3, dir: Vec3, maxDist: number) {
    const wallHit = raycast(origin, dir, this.map, maxDist);
    let bestT = wallHit ? wallHit.t : maxDist;
    let hitPlayer: PlayerHandle | null = null;
    for (const target of this.players.values()) {
      if (target.id === shooter.id || target.team === shooter.team || !target.alive) continue;
      const t = this.rayHitPlayer(origin, dir, target, bestT);
      if (t !== null) { bestT = t; hitPlayer = target; }
    }
    if (hitPlayer) this.applyHit(shooter, hitPlayer, shooter.weapon, dir);
  }

  private applyHit(shooter: PlayerHandle, target: PlayerHandle, spec: WeaponSpec, dir: Vec3) {
    this.applyDamage(target, spec.damage, shooter);
    if (spec.knockback > 0) {
      target.pos = collide(add(target.pos, scale(norm(dir), spec.knockback)), this.map, this.cfg.playerRadius);
    }
    if (spec.slow > 0) target.slowUntil = Date.now() + 1000 * spec.slow;
    if (spec.aoeRadius > 0) this.splash(shooter, target.pos, spec, target.id);
  }

  private splash(shooter: PlayerHandle, center: Vec3, spec: WeaponSpec, skipId: number) {
    if (spec.aoeRadius <= 0) return;
    this.events.push({ t: 'explosion', pos: center, radius: spec.aoeRadius });
    for (const target of this.players.values()) {
      if (target.id === skipId || target.team === shooter.team || !target.alive) continue;
      const d = dist(target.pos, center);
      if (d <= spec.aoeRadius) {
        const aoeDmg = spec.damage * spec.aoeDamageFalloff * (1 - d / spec.aoeRadius);
        this.applyDamage(target, aoeDmg, shooter);
      }
    }
  }

  private rayHitPlayer(origin: Vec3, dir: Vec3, target: PlayerHandle, maxT: number): number | null {
    const base = target.pos;
    const foot = { x: base.x, y: 0, z: base.z };
    const head = { x: base.x, y: this.cfg.playerEye + 0.2, z: base.z };
    const toFoot = sub(foot, origin);
    const t = toFoot.x * dir.x + toFoot.y * dir.y + toFoot.z * dir.z;
    if (t < 0 || t > maxT) return null;
    const closest = add(origin, scale(dir, t));
    const cy = Math.max(foot.y, Math.min(head.y, closest.y));
    const dx = closest.x - base.x;
    const dz = closest.z - base.z;
    const d = Math.sqrt(dx * dx + dz * dz + (closest.y - cy) * (closest.y - cy));
    if (d <= this.cfg.playerRadius + 0.1) return t;
    return null;
  }

  private applyDamage(target: PlayerHandle, dmg: number, shooter: PlayerHandle) {
    if (!target.alive || this.phase !== 'live') return;
    target.hp -= dmg;
    this.events.push({ t: 'hit', targetId: target.id, dmg: Math.round(dmg) });
    if (target.hp <= 0) {
      target.alive = false;
      target.deaths++;
      target.terminal = null;
      target.respawnAt = Date.now() + this.cfg.respawnSeconds * 1000;
      shooter.kills++;
      this.events.push({ t: 'died', id: target.id, killerId: shooter.id });
      this.checkElimination();
    }
  }

  private checkElimination() {
    for (const team of ['red', 'blue'] as Team[]) {
      const enemy: Team = team === 'red' ? 'blue' : 'red';
      const alive = [...this.players.values()].filter((p) => p.team === enemy && p.alive);
      if (this.players.size > 0 && alive.length === 0 && [...this.players.values()].some((p) => p.team === enemy)) {
        this.endRound(team, 'elimination');
        return;
      }
    }
  }

  private timeoutWinner(): Team {
    const s = { red: { a: 0, hp: 0 }, blue: { a: 0, hp: 0 } };
    for (const p of this.players.values()) {
      if (p.alive) { s[p.team].a++; s[p.team].hp += p.hp; }
    }
    if (s.red.a !== s.blue.a) return s.red.a > s.blue.a ? 'red' : 'blue';
    if (s.red.hp !== s.blue.hp) return s.red.hp > s.blue.hp ? 'red' : 'blue';
    return 'blue';
  }

  endRound(winner: Team, reason: WinReason) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.winner = winner;
    this.winReason = reason;
    this.score[winner]++;
    if (this.score[winner] >= ROUNDS_TO_WIN) {
      this.matchWinner = winner;
      this.phaseEndsAt = Date.now() + 20000;
    } else {
      this.phaseEndsAt = Date.now() + 15000;
    }
  }

  private resetMatch() {
    this.score = { red: 0, blue: 0 };
    this.matchWinner = null;
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.hacks = 0;
    }
  }

  startPrep() {
    this.phase = 'prep';
    this.phaseEndsAt = Date.now() + this.cfg.prepSeconds * 1000;
    this.services.resetAll();
    this.hackAlerts = [];
    this.winner = null;
    this.winReason = null;
    this.projectiles = [];
    for (const p of this.players.values()) {
      p.alive = true;
      p.hp = p.maxHp;
      p.pos = { ...this.spawnPoint(p.team, p.id) };
      p.ammo = p.weapon.magazine;
      p.reloadUntil = 0;
      p.terminal = null;
      if (p.botState) { p.botState.targetId = null; p.botState.nextDecisionAt = 0; }
    }
  }

  startLive() {
    this.phase = 'live';
    this.phaseEndsAt = Date.now() + this.cfg.roundSeconds * 1000;
    for (const p of this.players.values()) {
      p.alive = true;
      p.hp = p.maxHp;
      p.pos = { ...this.spawnPoint(p.team, p.id) };
      p.ammo = p.weapon.magazine;
      p.terminal = null;
    }
  }

  tick(dtMs: number) {
    const now = Date.now();
    if (this.phase === 'prep' && now > this.phaseEndsAt) this.startLive();
    if (this.phase === 'live' && now > this.phaseEndsAt) this.endRound(this.timeoutWinner(), 'timeout');
    if (this.phase === 'ended' && now > this.phaseEndsAt) {
      if (this.matchWinner) this.resetMatch();
      this.startPrep();
    }

    for (const p of this.players.values()) {
      if (!p.alive && this.phase === 'live' && now > p.respawnAt) {
        p.alive = true;
        p.hp = p.maxHp;
        p.pos = { ...this.spawnPoint(p.team, p.id) };
        p.ammo = p.weapon.magazine;
        if (p.botState) p.botState.nextDecisionAt = 0;
      }
      if (p.bot && this.phase === 'live') this.tickBot(p, dtMs);
    }

    this.tickProjectiles(dtMs / 1000);
  }

  private tickProjectiles(step: number) {
    const remaining: Projectile[] = [];
    for (const pr of this.projectiles) {
      const shooter = this.players.get(pr.shooterId);
      if (!shooter) continue;
      pr.life += step;
      if (pr.life > 3) continue;
      const stepLen = pr.speed * step;
      const wall = raycast(pr.pos, pr.dir, this.map, stepLen);
      let bestT = wall ? wall.t : stepLen;
      let hitPlayer: PlayerHandle | null = null;
      for (const target of this.players.values()) {
        if (target.id === shooter.id || target.team === shooter.team || !target.alive) continue;
        const t = this.rayHitPlayer(pr.pos, pr.dir, target, bestT);
        if (t !== null) { bestT = t; hitPlayer = target; }
      }
      const end = add(pr.pos, scale(pr.dir, bestT));
      if (hitPlayer) {
        this.applyHit(shooter, hitPlayer, pr.spec, pr.dir);
        continue;
      }
      if (wall) {
        this.splash(shooter, end, pr.spec, -1);
        continue;
      }
      pr.pos = end;
      remaining.push(pr);
    }
    this.projectiles = remaining;
  }

  private hasLOS(a: Vec3, b: Vec3): boolean {
    const o = add(a, { x: 0, y: this.cfg.playerEye, z: 0 });
    const t = add(b, { x: 0, y: this.cfg.playerEye, z: 0 });
    const d = dist(o, t);
    if (d < 1e-6) return true;
    return !raycast(o, norm(sub(t, o)), this.map, d);
  }

  private botStep(p: PlayerHandle, fwd: number, strafe: number, step: number) {
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const rx = -Math.cos(p.yaw), rz = Math.sin(p.yaw);
    let vx = fx * fwd + rx * strafe;
    let vz = fz * fwd + rz * strafe;
    const l = Math.hypot(vx, vz);
    if (l < 1e-6) return;
    vx /= l; vz /= l;
    for (const off of [0, 0.6, -0.6, 1.2, -1.2, 2.0, -2.0]) {
      const c = Math.cos(off), s = Math.sin(off);
      const dx = vx * c - vz * s;
      const dz = vx * s + vz * c;
      const np = collide({ x: p.pos.x + dx * step, y: 0, z: p.pos.z + dz * step }, this.map, this.cfg.playerRadius);
      if (Math.hypot(np.x - p.pos.x, np.z - p.pos.z) >= step * 0.6) {
        p.pos = np;
        return;
      }
    }
  }

  private tickBot(p: PlayerHandle, dtMs: number) {
    if (!p.alive) return;
    const now = Date.now();
    const dt = dtMs / 1000;
    const st = p.botState!;
    const reactionMs = this.cfg.botReactionMs ?? 250;
    const aimErrDeg = this.cfg.botAimErrorDeg ?? 4;

    if (now >= st.nextDecisionAt) {
      st.nextDecisionAt = now + 400 + Math.random() * 400;
      let best: PlayerHandle | null = null;
      let bestScore = Infinity;
      for (const e of this.players.values()) {
        if (e.team === p.team || !e.alive) continue;
        const score = dist(p.pos, e.pos) + (this.hasLOS(p.pos, e.pos) ? 0 : 12);
        if (score < bestScore) { bestScore = score; best = e; }
      }
      st.targetId = best ? best.id : null;
      if (Math.random() < 0.5) st.strafeDir = -st.strafeDir;
    }

    const target = st.targetId !== null ? this.players.get(st.targetId) : undefined;
    if (!target || !target.alive) {
      st.targetId = null;
      st.nextDecisionAt = 0;
      return;
    }

    const d = dist(p.pos, target.pos);
    const vis = this.hasLOS(p.pos, target.pos);
    if (vis) {
      if (now - st.lastSeen > 300) st.seenSince = now;
      st.lastSeen = now;
    }

    const want = Math.atan2(target.pos.x - p.pos.x, target.pos.z - p.pos.z);
    const diff = angleDiff(p.yaw, want);
    const maxTurn = 7 * dt;
    p.yaw += Math.abs(diff) <= maxTurn ? diff : Math.sign(diff) * maxTurn;

    const speed = this.cfg.playerSpeed * (now < p.slowUntil ? 0.5 : 1);
    let fwd = 1;
    if (vis) fwd = d > 11 ? 1 : d < 5 ? -0.6 : 0;
    const strafe = vis ? st.strafeDir * 0.8 : 0;
    this.botStep(p, fwd, strafe, speed * dt);

    if (vis && d < 45 && now - st.seenSince >= reactionMs && Math.abs(angleDiff(p.yaw, want)) < 0.12) {
      const err = (aimErrDeg * Math.PI) / 180;
      const yaw0 = p.yaw;
      p.yaw += (Math.random() - 0.5) * 2 * err;
      const pitch = Math.atan2(1.0 - this.cfg.playerEye, d);
      this.tryShoot(p, pitch);
      p.yaw = yaw0;
    }
  }

  state(): MatchState {
    const players: PlayerState[] = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, bot: p.bot, hp: Math.max(0, Math.round(p.hp)),
      maxHp: p.maxHp, pos: p.pos, yaw: p.yaw, alive: p.alive,
      weaponName: p.weapon.name, ammo: p.ammo, magazine: p.weapon.magazine,
      kills: p.kills, deaths: p.deaths, hacks: p.hacks,
    }));
    const servers = this.services.services.map((s) => ({
      id: s.id, pos: this.map.terminals.find((t) => t.serverId === s.id)!.pos,
      hacked: s.isDown, hackProgress: null,
    }));
    return {
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      score: this.score,
      roundsToWin: ROUNDS_TO_WIN,
      matchWinner: this.matchWinner,
      players,
      servers,
      winner: this.winner,
      winReason: this.winReason,
      hackAlerts: this.hackAlerts.slice(-10),
    };
  }
}
