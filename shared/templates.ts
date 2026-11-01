import type { WeaponScriptFile } from './protocol.js';

export const WEAPON_TEMPLATES: WeaponScriptFile[] = [
  {
    id: 'tpl-ak',
    name: 'AK',
    code: `-- "AK": automatic rifle, medium damage, medium recoil
return {
  name = "AK",
  hp = 100,
  damage = 15,
  fireIntervalMs = 100,
  hitscan = true,
  projectileSpeed = 200,
  magazine = 30,
  reloadMs = 2000,
  recoil = 0.6,
  spreadDeg = 2.0,
  knockback = 0.2,
  slow = 0,
  aoeRadius = 0,
  aoeDamageFalloff = 0.5,
}
`,
  },
  {
    id: 'tpl-awp',
    name: 'AWP',
    code: `-- "AWP": one-shot sniper, but slow fire and long reload
return {
  name = "AWP",
  hp = 100,
  damage = 100,
  fireIntervalMs = 1200,
  hitscan = true,
  projectileSpeed = 400,
  magazine = 5,
  reloadMs = 3000,
  recoil = 1.0,
  spreadDeg = 0.3,
  knockback = 0.8,
  slow = 0,
  aoeRadius = 0,
  aoeDamageFalloff = 0.5,
}
`,
  },
  {
    id: 'tpl-smg',
    name: 'SMG',
    code: `-- "SMG": fast, weak shots, low recoil, small magazine
return {
  name = "SMG",
  hp = 100,
  damage = 6,
  fireIntervalMs = 60,
  hitscan = true,
  projectileSpeed = 180,
  magazine = 25,
  reloadMs = 1400,
  recoil = 0.25,
  spreadDeg = 3.0,
  knockback = 0,
  slow = 0,
  aoeRadius = 0,
  aoeDamageFalloff = 0.5,
}
`,
  },
  {
    id: 'tpl-gl',
    name: 'Cannon',
    code: `-- "Cannon": slow projectile, area damage, knockback
return {
  name = "Cannon",
  hp = 100,
  damage = 20,
  fireIntervalMs = 700,
  hitscan = false,
  projectileSpeed = 25,
  magazine = 4,
  reloadMs = 2500,
  recoil = 1.2,
  spreadDeg = 1.0,
  knockback = 1.5,
  slow = 0.3,
  aoeRadius = 2.5,
  aoeDamageFalloff = 0.4,
}
`,
  },
];
