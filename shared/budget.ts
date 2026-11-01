import type { WeaponSpec, BudgetReport } from './protocol.js';

export interface BudgetCosts {
  hpPer100: number;
  damagePerPoint: number;
  fireRatePerShotPerSec: number;
  hitscanFlat: number;
  projectileSpeedPerUnit: number;
  magazinePerRound: number;
  reloadCreditAt2000ms: number;
  recoilRefundAt1_5: number;
  spreadRefundAt4deg: number;
  knockback: number;
  slow: number;
  aoeRadiusPerUnit: number;
}

export interface BudgetConfig {
  budget: { totalPoints: number; minHp: number; maxHp: number; costs: BudgetCosts };
}

let cachedConfig: BudgetConfig | null = null;

export function setBudgetConfig(cfg: BudgetConfig) {
  cachedConfig = cfg;
}

export function getBudgetConfig(): BudgetConfig {
  if (!cachedConfig) throw new Error('budget config not loaded');
  return cachedConfig;
}

export function validateSpec(raw: Record<string, unknown>): { ok: boolean; spec?: WeaponSpec; error?: string } {
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return isFinite(n) ? n : undefined;
  };
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 24) : 'Custom';
  const hp = num(raw.hp) ?? 100;
  const damage = num(raw.damage);
  const fireIntervalMs = num(raw.fireIntervalMs);
  const magazine = num(raw.magazine);
  const reloadMs = num(raw.reloadMs);
  const recoil = num(raw.recoil);
  const spreadDeg = num(raw.spreadDeg);
  const knockback = num(raw.knockback) ?? 0;
  const slow = num(raw.slow) ?? 0;
  const aoeRadius = num(raw.aoeRadius) ?? 0;
  const aoeDamageFalloff = num(raw.aoeDamageFalloff) ?? 0.5;
  const hitscan = raw.hitscan === true || raw.hitscan === 'true';
  const projectileSpeed = num(raw.projectileSpeed) ?? 100;

  if (damage === undefined || damage <= 0) return { ok: false, error: 'damage must be > 0' };
  if (fireIntervalMs === undefined || fireIntervalMs < 50) return { ok: false, error: 'fireIntervalMs must be >= 50' };
  if (magazine === undefined || magazine < 1) return { ok: false, error: 'magazine must be >= 1' };
  if (reloadMs === undefined || reloadMs < 300) return { ok: false, error: 'reloadMs must be >= 300' };
  if (recoil === undefined || recoil < 0) return { ok: false, error: 'recoil must be >= 0' };
  if (spreadDeg === undefined || spreadDeg < 0.05) return { ok: false, error: 'spreadDeg must be >= 0.05' };

  const cfg = getBudgetConfig().budget;
  const spec: WeaponSpec = {
    name,
    hp: clamp(hp, cfg.minHp, cfg.maxHp),
    damage,
    fireIntervalMs,
    hitscan,
    projectileSpeed,
    magazine: Math.floor(magazine),
    reloadMs,
    recoil: clamp(recoil, 0, 3),
    spreadDeg: clamp(spreadDeg, 0.05, 10),
    knockback: clamp(knockback, 0, 3),
    slow: clamp(slow, 0, 1),
    aoeRadius: clamp(aoeRadius, 0, 5),
    aoeDamageFalloff: clamp(aoeDamageFalloff, 0, 1),
  };
  return { ok: true, spec };
}

export function specPoints(spec: WeaponSpec): BudgetReport {
  const c = getBudgetConfig().budget.costs;
  const rows: { key: string; points: number }[] = [];
  let total = 0;
  const add = (key: string, points: number) => {
    const p = round2(Math.max(0, points));
    rows.push({ key, points: p });
    total += p;
  };

  add('hp', (spec.hp / 100) * c.hpPer100);
  add('damage', spec.damage * c.damagePerPoint);
  add('fireRate', (1000 / spec.fireIntervalMs) * c.fireRatePerShotPerSec);
  if (spec.hitscan) add('hitscan', c.hitscanFlat);
  else add('projectileSpeed', spec.projectileSpeed * c.projectileSpeedPerUnit);
  add('magazine', spec.magazine * c.magazinePerRound);
  add('reload', (2000 / spec.reloadMs) * c.reloadCreditAt2000ms);
  add('recoil', (1.5 - spec.recoil) * c.recoilRefundAt1_5);
  add('spread', (4 - spec.spreadDeg) * c.spreadRefundAt4deg);
  add('knockback', spec.knockback * c.knockback);
  add('slow', spec.slow * c.slow);
  add('aoeRadius', spec.aoeRadius * c.aoeRadiusPerUnit);

  total = round2(total);
  return { ok: total <= getBudgetConfig().budget.totalPoints, total, rows };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return isFinite(n) ? Math.round(n * 100) / 100 : Infinity;
}

export function defaultSpec(): WeaponSpec {
  return {
    name: 'Custom',
    hp: 100,
    damage: 10,
    fireIntervalMs: 120,
    hitscan: true,
    projectileSpeed: 100,
    magazine: 20,
    reloadMs: 1500,
    recoil: 0.4,
    spreadDeg: 1.5,
    knockback: 0,
    slow: 0,
    aoeRadius: 0,
    aoeDamageFalloff: 0.5,
  };
}
