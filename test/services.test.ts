import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServiceMap } from '../server/services/vulnService.js';
import { LuaSandbox } from '../server/sandbox/pool.js';

const PIN_LENGTH = 4;

async function withSandbox(fn: (sb: LuaSandbox) => Promise<void>) {
  const sb = new LuaSandbox();
  try {
    await fn(sb);
  } finally {
    await sb.close();
  }
}

test('SQL injection exploit takes the service down', async () => {
  await withSandbox(async (sb) => {
    const map = makeServiceMap(2, PIN_LENGTH);
    const svc = map.get(0)!;
    const exploit = `local r = login("admin' OR '1'='1", "x") if r.ok then return "root" end`;
    const res = await svc.runExploit(sb, exploit, 'blue');
    assert.ok(res.ok, JSON.stringify(res.log));
    assert.ok(svc.isDown);
  });
});

test('PIN brute force exploit takes the service down', async () => {
  await withSandbox(async (sb) => {
    const map = makeServiceMap(2, PIN_LENGTH);
    const svc = map.get(1)!;
    const exploit = `for i=0,9999 do local r=checkPin(string.format("%04d",i)) if r.ok then return end end`;
    const res = await svc.runExploit(sb, exploit, 'red');
    assert.ok(res.ok, JSON.stringify(res.log));
    assert.ok(svc.isDown);
  });
});

test('infinite loop exploit is killed by the instruction budget', async () => {
  await withSandbox(async (sb) => {
    const map = makeServiceMap(2, PIN_LENGTH);
    const svc = map.get(0)!;
    const res = await svc.runExploit(sb, `while true do end`, 'red');
    assert.equal(res.ok, false);
    assert.match(res.log[0], /budget/);
    assert.ok(!svc.isDown);
  });
});

test('a correct defense patch prevents the SQL injection', async () => {
  await withSandbox(async (sb) => {
    const map = makeServiceMap(2, PIN_LENGTH);
    const svc = map.get(0)!;
    const patch = `function validate(s) return type(s)=="string" and not s:find("[';]") end
local seen = {}
function rate(key) seen[key]=(seen[key] or 0)+1 return seen[key] <= 5 end`;
    const applied = await svc.applyPatch(sb, patch);
    assert.ok(applied.accepted, JSON.stringify(applied.log));
    const exploit = `local r = login("admin' OR '1'='1", "x") if r.ok then return "root" end`;
    const res = await svc.runExploit(sb, exploit, 'blue');
    assert.equal(res.ok, false, 'patched service must resist the injection');
    assert.ok(!svc.isDown);
  });
});

test('a patch that breaks legitimate login is rejected', async () => {
  await withSandbox(async (sb) => {
    const map = makeServiceMap(2, PIN_LENGTH);
    const svc = map.get(0)!;
    const patch = `function validate(s) return false end`;
    const applied = await svc.applyPatch(sb, patch);
    assert.equal(applied.accepted, false);
    assert.match(applied.log.join(' '), /self-check/);
  });
});
