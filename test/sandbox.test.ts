import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LuaSandbox } from '../server/sandbox/pool.js';
import { setBudgetConfig, validateSpec, specPoints, type BudgetConfig } from '../shared/budget.js';
import { WEAPON_TEMPLATES } from '../shared/templates.js';

setBudgetConfig(JSON.parse(readFileSync('config/balance.json', 'utf8')) as unknown as BudgetConfig);

test('sandbox runs a weapon table and returns it', async () => {
  const sb = new LuaSandbox();
  const r = await sb.run('return { name = "X", damage = 10, hitscan = true }');
  assert.ok(r.ok, r.error);
  const v = r.value as any;
  assert.equal(v.name, 'X');
  assert.equal(v.damage, 10);
  await sb.close();
});

test('while true do end is killed by the instruction budget', async () => {
  const sb = new LuaSandbox();
  const start = Date.now();
  const r = await sb.run('while true do end', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.killed, true);
  assert.ok(Date.now() - start < 5000, 'must not hang the server');
  const after = await sb.run('return 6*7');
  assert.ok(after.ok);
  assert.equal(after.value, 42);
  await sb.close();
});

test('sandbox blocks os and io', async () => {
  const sb = new LuaSandbox();
  const osr = await sb.run('return os.clock()');
  assert.equal(osr.ok, false);
  const ior = await sb.run('io.write("x")');
  assert.equal(ior.ok, false);
  await sb.close();
});

test('templates fit the budget', async () => {
  const sb = new LuaSandbox();
  for (const tpl of WEAPON_TEMPLATES) {
    const r = await sb.run(tpl.code);
    assert.ok(r.ok, `${tpl.name}: ${r.error}`);
    const v = validateSpec(r.value as any);
    assert.ok(v.ok, `${tpl.name} invalid: ${v.error}`);
    const report = specPoints(v.spec!);
    assert.ok(report.ok, `${tpl.name} exceeds budget: ${report.total}`);
  }
  await sb.close();
});

test('overpowered weapon is rejected by the budget', () => {
  const v = validateSpec({
    name: 'God', hp: 100, damage: 100, fireIntervalMs: 50, hitscan: true,
    projectileSpeed: 400, magazine: 50, reloadMs: 300, recoil: 0, spreadDeg: 0.05,
    knockback: 0, slow: 0, aoeRadius: 0, aoeDamageFalloff: 0,
  });
  assert.ok(v.ok);
  const report = specPoints(v.spec!);
  assert.equal(report.ok, false);
});
