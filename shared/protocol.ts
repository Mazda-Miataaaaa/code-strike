export type Team = 'red' | 'blue';

export interface WeaponSpec {
  name: string;
  hp: number;
  damage: number;
  fireIntervalMs: number;
  hitscan: boolean;
  projectileSpeed: number;
  magazine: number;
  reloadMs: number;
  recoil: number;
  spreadDeg: number;
  knockback: number;
  slow: number;
  aoeRadius: number;
  aoeDamageFalloff: number;
}

export interface WeaponScriptFile {
  id: string;
  name: string;
  code: string;
}

export interface BudgetReport {
  ok: boolean;
  total: number;
  rows: { key: string; points: number }[];
}

export const PROTOCOL_VERSION = 1;

export type ClientToServer =
  | { t: 'join'; name: string; team?: Team }
  | { t: 'input'; seq: number; dt: number; move: { x: number; z: number }; yaw: number; pitch: number; shoot: boolean; interact: boolean }
  | { t: 'saveWeapon'; code: string }
  | { t: 'selectWeapon'; id: string }
  | { t: 'openTerminal'; serverId: number }
  | { t: 'closeTerminal' }
  | { t: 'submitExploit'; serverId: number; code: string }
  | { t: 'submitPatch'; serverId: number; code: string };

export interface Vec3 { x: number; y: number; z: number }

export interface PlayerState {
  id: number;
  name: string;
  team: Team;
  bot: boolean;
  hp: number;
  maxHp: number;
  pos: Vec3;
  yaw: number;
  alive: boolean;
  weaponName: string;
  kills: number;
  deaths: number;
  hacks: number;
}

export interface ServerStateMap {
  id: number;
  pos: Vec3;
  hacked: boolean;
  hackProgress: number | null;
}

export type Phase = 'lobby' | 'prep' | 'live' | 'ended';

export interface MatchState {
  phase: Phase;
  phaseEndsAt: number;
  score: { red: number; blue: number };
  players: PlayerState[];
  servers: ServerStateMap[];
  winner: Team | null;
  winReason: 'elimination' | 'hack' | null;
  hackAlerts: { team: Team; serverId: number; at: number }[];
}

export type ServerToClient =
  | { t: 'joined'; youId: number; state: MatchState; budget: BudgetReport; templates: WeaponScriptFile[]; config: Record<string, any> }
  | { t: 'state'; state: MatchState }
  | { t: 'weaponSaved'; report: BudgetReport; ok: boolean; error?: string; id?: string }
  | { t: 'shot'; shooterId: number; from: Vec3; to: Vec3; weapon: string }
  | { t: 'hit'; targetId: number; dmg: number }
  | { t: 'died'; id: number; killerId: number }
  | { t: 'terminalOpened'; serverId: number; source: string; vulnTypeHint: string }
  | { t: 'exploitResult'; serverId: number; ok: boolean; log: string[] }
  | { t: 'patchResult'; serverId: number; ok: boolean; log: string[]; accepted: boolean }
  | { t: 'roundEnd'; state: MatchState }
  | { t: 'error'; message: string };
