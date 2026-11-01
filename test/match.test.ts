import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Match } from '../server/game/match.js';
import { LuaSandbox } from '../server/sandbox/pool.js';
import { setBudgetConfig, type BudgetConfig } from '../shared/budget.js';
import { matchConfig } from '../server/game/config.js';
import { WEAPON_TEMPLATES } from '../shared/templates.js';

setBudgetConfig(JSON.parse(readFileSync('config/balance.json', 'utf8')) as unknown as BudgetConfig);

test('full match: spawn, custom weapon, hack both servers, victory', async () => {
  const sb = new LuaSandbox();
  const m = new Match(sb, { ...matchConfig, prepSeconds: 0, roundSeconds: 60, respawnSeconds: 1 });
  const red = m.addPlayer('red-hacker', 'red', false);
  const blue = m.addPlayer('blue-def', 'blue', false);

  assert.ok(red.alive && blue.alive, 'both players spawn alive');

  const saved = await m.saveWeapon(red.id, WEAPON_TEMPLATES[1].code);
  assert.ok(saved.ok, saved.error);
  assert.equal(saved.spec!.name, 'AWP');

  const over = await m.saveWeapon(red.id, `return {
    name = "God", hp = 100, damage = 100, fireIntervalMs = 50, hitscan = true,
    projectileSpeed = 400, magazine = 50, reloadMs = 300, recoil = 0, spreadDeg = 0.05,
    knockback = 0, slow = 0, aoeRadius = 0, aoeDamageFalloff = 0 }`);
  assert.equal(over.ok, false, 'overpowered weapon must be rejected');
  assert.match(over.error!, /budget/);

  m.startPrep();
  red.pos = { x: -12, y: 0, z: 1 };
  blue.pos = { x: 12, y: 0, z: 1 };
  const patch = `function validate(s) return type(s)=="string" and not s:find("[';]") end
local seen = {}
function rate(key) seen[key]=(seen[key] or 0)+1 return seen[key] <= 5 end`;
  const patched = await m.submitPatch(blue.id, 0, patch);
  assert.ok(patched.accepted, JSON.stringify(patched.log));

  m.startLive();
  assert.equal(m.phase, 'live');

  m.openTerminal(red.id, 0);
  const exploit = `local r = login("admin' OR '1'='1", "x") if r.ok then return "root" end`;
  const res0 = await m.submitExploit(red.id, 0, exploit);
  assert.equal(res0.ok, false, 'patched server must resist');

  red.pos = { x: 12, y: 0, z: 1 };
  m.openTerminal(red.id, 1);
  const res1 = await m.submitExploit(red.id, 1, exploit);
  assert.ok(res1.ok, JSON.stringify(res1.log));

  const pinExploit = `for i=0,9999 do local r=checkPin(string.format("%04d",i)) if r.ok then return end end`;
  const svc0 = m.getServices().get(0)!;
  svc0.reset();
  red.pos = { x: -12, y: 0, z: 1 };
  m.openTerminal(red.id, 0);
  const res0b = await m.submitExploit(red.id, 0, pinExploit);
  assert.ok(res0b.ok, JSON.stringify(res0b.log));

  assert.equal(m.phase, 'ended');
  assert.equal(m.winner, 'red');
  assert.equal(m.winReason, 'hack');
  await sb.close();
});

test('elimination victory works', async () => {
  const sb = new LuaSandbox();
  const m = new Match(sb, { ...matchConfig, prepSeconds: 0, roundSeconds: 60, respawnSeconds: 999 });
  const red = m.addPlayer('red', 'red', false);
  const blue = m.addPlayer('blue', 'blue', false);
  m.startLive();

  const saved = await m.saveWeapon(red.id, WEAPON_TEMPLATES[1].code);
  assert.ok(saved.ok, saved.error);
  red.pos = { x: blue.pos.x + 2, y: 0, z: blue.pos.z };
  red.yaw = Math.atan2(blue.pos.x - red.pos.x, blue.pos.z - red.pos.z);
  m.input(red.id, { t: 'input', seq: 1, dt: 0.016, move: { x: 0, z: 0 }, yaw: red.yaw, pitch: 0, shoot: true, interact: false });
  await new Promise((r) => setTimeout(r, 50));
  m.input(red.id, { t: 'input', seq: 2, dt: 0.016, move: { x: 0, z: 0 }, yaw: red.yaw, pitch: 0, shoot: true, interact: false });

  assert.equal(m.phase, 'ended');
  assert.equal(m.winner, 'red');
  assert.equal(m.winReason, 'elimination');
  await sb.close();
});
