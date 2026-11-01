import type { WeaponSpec, MatchState, PlayerState, Team, Vec3, ServerToClient, ClientToServer } from '../../shared/protocol.js';
import { validateSpec, specPoints } from '../../shared/budget.js';
import { makeMap, collide, raycast, norm, add, scale, dist, sub } from './map.js';
import { makeServiceMap, type GameServiceMap } from '../services/vulnService.js';
import { LuaSandbox } from '../sandbox/pool.js';
import { WEAPON_TEMPLATES } from '../../shared/templates.js';
import type { MatchConfig } from './config.js';

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
  botState?: { targetId: number | null; nextDecisionAt: number; lastSeen: number };
}

export class Match {
  players = new Map<number, PlayerHandle>();
  private nextPlayerId = 1;
  private map = makeMap();
  private services: GameServiceMap;
  private sandbox: LuaSandbox;
  private cfg: MatchConfig;
  phase: 'lobby' | 'prep' | 'live' | 'ended' = 'lobby';
  phaseEndsAt = 0;
  score = { red: 0, blue: 0 };
  winner: Team | null = null;
  winReason: 'elimination' | 'hack' | null = null;
  hackAlerts: { team: Team; serverId: number; at: number }[] = [];
  private projectiles: { pos: Vec3; dir: Vec3; speed: number; shooterId: number; spec: WeaponSpec }[] = [];
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
      botState: bot ? { targetId: null, nextDecisionAt: 0, lastSeen: 0 } : undefined,
    };
    this.players.set(id, p);
    return p;
  }

  removePlayer(id: number) {
    this.players.delete(id);
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
    const speed = this.cfg.playerSpeed * (Date.now() < p.slowUntil ? 0.5 : 1);
    const dt = Math.min(msg.dt, 0.1);
    if (p.terminal !== null) return;
    const dirx = Math.sin(msg.yaw);
    const dirz = Math.cos(msg.yaw);
    const nx = p.pos.x + (msg.move.x * dirz - msg.move.z * dirx) * speed * dt;
    const nz = p.pos.z + (msg.move.x * -dirx + msg.move.z * -dirz) * -speed * dt;
    p.pos = collide({ x: nx, y: 0, z: nz }, this.map, this.cfg.playerRadius);
    p.yaw = msg.yaw;
    if (msg.shoot) this.tryShoot(p, msg.pitch);
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
        pos: origin, dir, speed: p.weapon.projectileSpeed, shooterId: p.id, spec: p.weapon,
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
    if (hitPlayer) {
      this.applyDamage(hitPlayer, shooter.weapon.damage, shooter);
      if (shooter.weapon.knockback > 0) {
        const push = scale(norm(dir), shooter.weapon.knockback);
        hitPlayer.pos = collide(add(hitPlayer.pos, push), this.map, this.cfg.playerRadius);
      }
      if (shooter.weapon.slow > 0) hitPlayer.slowUntil = Date.now() + 1000 * shooter.weapon.slow;
      if (shooter.weapon.aoeRadius > 0) {
        for (const target of this.players.values()) {
          if (target.id === hitPlayer.id || target.team === shooter.team || !target.alive) continue;
          const d = dist(target.pos, hitPlayer.pos);
          if (d <= shooter.weapon.aoeRadius) {
            const aoeDmg = shooter.weapon.damage * shooter.weapon.aoeDamageFalloff * (1 - d / shooter.weapon.aoeRadius);
            this.applyDamage(target, aoeDmg, shooter);
          }
        }
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

  endRound(winner: Team, reason: 'elimination' | 'hack') {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.winner = winner;
    this.winReason = reason;
    this.score[winner]++;
    this.phaseEndsAt = Date.now() + 15000;
  }

  startPrep() {
    this.phase = 'prep';
    this.phaseEndsAt = Date.now() + this.cfg.prepSeconds * 1000;
    this.services.resetAll();
    this.hackAlerts = [];
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
    if (this.phase === 'live' && now > this.phaseEndsAt) {
      this.endRound('red', 'elimination');
    }

    for (const p of this.players.values()) {
      if (!p.alive && this.phase === 'live' && now > p.respawnAt) {
        p.alive = true;
        p.hp = p.maxHp;
        p.pos = { ...this.spawnPoint(p.team, p.id) };
        p.ammo = p.weapon.magazine;
      }
      if (p.bot && this.phase === 'live') this.tickBot(p, dtMs);
    }

    const step = dtMs / 1000;
    const remaining: typeof this.projectiles = [];
    for (const pr of this.projectiles) {
      pr.pos = add(pr.pos, scale(pr.dir, pr.speed * step));
      const shooter = this.players.get(pr.shooterId);
      if (!shooter) continue;
      this.resolveShot(shooter, pr.pos, pr.dir, 2);
    }
    this.projectiles = remaining;
  }

  private tickBot(p: PlayerHandle, dtMs: number) {
    const now = Date.now();
    const st = p.botState!;
    const enemies = [...this.players.values()].filter((e) => e.team !== p.team && e.alive);
    let target = st.targetId !== null ? this.players.get(st.targetId) : null;
    if (!target || !target.alive) {
      target = enemies[0] ?? null;
      st.targetId = target?.id ?? null;
    }
    if (p.terminal !== null && target && dist(p.pos, target.pos) < 15) p.terminal = null;
    if (target) {
      const d = dist(p.pos, target.pos);
      p.yaw = Math.atan2(target.pos.x - p.pos.x, target.pos.z - p.pos.z);
      if (d > 8) {
        const dirx = Math.sin(p.yaw);
        const dirz = Math.cos(p.yaw);
        const nx = p.pos.x + dirx * this.cfg.playerSpeed * (dtMs / 1000);
        const nz = p.pos.z + dirz * this.cfg.playerSpeed * (dtMs / 1000);
        p.pos = collide({ x: nx, y: 0, z: nz }, this.map, this.cfg.playerRadius);
      }
      const pitch = Math.atan2(this.cfg.playerEye - this.cfg.playerEye, d);
      this.tryShoot(p, 0);
    }
  }

  state(): MatchState {
    const players: PlayerState[] = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, bot: p.bot, hp: Math.max(0, Math.round(p.hp)),
      maxHp: p.maxHp, pos: p.pos, yaw: p.yaw, alive: p.alive,
      weaponName: p.weapon.name, kills: p.kills, deaths: p.deaths, hacks: p.hacks,
    }));
    const servers = this.services.services.map((s) => ({
      id: s.id, pos: this.map.terminals.find((t) => t.serverId === s.id)!.pos,
      hacked: s.isDown, hackProgress: null,
    }));
    return {
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      score: this.score,
      players,
      servers,
      winner: this.winner,
      winReason: this.winReason,
      hackAlerts: this.hackAlerts.slice(-10),
    };
  }
}
