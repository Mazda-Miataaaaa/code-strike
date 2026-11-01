import balance from '../../config/balance.json' with { type: 'json' };

export interface MatchConfig {
  playersPerTeam: number;
  prepSeconds: number;
  roundSeconds: number;
  hackCountdownSeconds: number;
  serversToHack: number;
  respawnSeconds: number;
  playerSpeed: number;
  playerRadius: number;
  playerEye: number;
  botAimErrorDeg: number;
  botReactionMs: number;
  pinLength: number;
  scriptTimeoutMs: number;
  totalPoints: number;
}

const m = (balance as any).match;
const h = (balance as any).hack;
const sb = (balance as any).sandbox;
const bud = (balance as any).budget;

export const matchConfig: MatchConfig = {
  playersPerTeam: m.playersPerTeam,
  prepSeconds: m.prepSeconds,
  roundSeconds: m.roundSeconds,
  hackCountdownSeconds: m.hackCountdownSeconds,
  serversToHack: m.serversToHack,
  respawnSeconds: m.respawnSeconds,
  playerSpeed: m.playerSpeed,
  playerRadius: m.playerRadius,
  playerEye: m.playerEye,
  botAimErrorDeg: m.botAimErrorDeg,
  botReactionMs: m.botReactionMs,
  pinLength: h.pinLength,
  scriptTimeoutMs: sb.scriptTimeoutMs,
  totalPoints: bud.totalPoints,
};
