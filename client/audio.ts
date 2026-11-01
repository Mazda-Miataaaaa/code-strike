import type { ServerToClient, MatchState } from '../shared/protocol.js';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let muted = false;
let lastPhase = '';
let lastAlertAt = 0;

export function initAudio(): void {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

export function toggleMute(): boolean {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.5;
  return muted;
}

function tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(Math.max(0.0002, vol), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, freq: number, vol: number, delay = 0): void {
  if (!ctx || !master || !noiseBuf) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.0002, vol), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

function distVol(state: MatchState | null, youId: number, x: number, z: number): number {
  const me = state?.players.find((p) => p.id === youId);
  if (!me) return 1;
  const d = Math.hypot(me.pos.x - x, me.pos.z - z);
  return Math.max(0.08, 1 - d / 45);
}

function shotSound(weapon: string, v: number): void {
  const w = weapon.toUpperCase();
  if (w.includes('AWP')) {
    noise(0.25, 1800, 0.5 * v);
    tone(140, 40, 0.3, 'sawtooth', 0.5 * v);
  } else if (w.includes('CANNON')) {
    noise(0.3, 900, 0.5 * v);
    tone(90, 30, 0.35, 'square', 0.4 * v);
  } else if (w.includes('AK')) {
    tone(200, 60, 0.12, 'sawtooth', 0.3 * v);
    noise(0.1, 3500, 0.35 * v);
  } else {
    noise(0.06, 4500, 0.25 * v);
    tone(300, 90, 0.07, 'square', 0.15 * v);
  }
}

export function handleAudioEvent(msg: ServerToClient, youId: number, state: MatchState | null): void {
  if (!ctx) return;
  switch (msg.t) {
    case 'shot': {
      const v = msg.shooterId === youId ? 1 : distVol(state, youId, msg.from.x, msg.from.z);
      shotSound(msg.weapon, v);
      break;
    }
    case 'hit': {
      if (msg.targetId === youId) {
        tone(180, 70, 0.2, 'sawtooth', 0.4);
        noise(0.12, 1200, 0.3);
      } else {
        const t = state?.players.find((p) => p.id === msg.targetId);
        const v = t ? distVol(state, youId, t.pos.x, t.pos.z) : 0.3;
        tone(900, 600, 0.04, 'triangle', 0.15 * v);
      }
      break;
    }
    case 'died': {
      if (msg.killerId === youId) {
        tone(660, 660, 0.1, 'sine', 0.3);
        tone(880, 880, 0.15, 'sine', 0.3, 0.1);
      } else if (msg.id === youId) {
        tone(300, 50, 0.6, 'sawtooth', 0.4);
      } else {
        const t = state?.players.find((p) => p.id === msg.id);
        const v = t ? distVol(state, youId, t.pos.x, t.pos.z) : 0.3;
        tone(220, 60, 0.3, 'triangle', 0.2 * v);
      }
      break;
    }
    case 'explosion': {
      const v = distVol(state, youId, msg.pos.x, msg.pos.z);
      noise(0.7, 500, 0.7 * v);
      tone(100, 25, 0.6, 'sine', 0.7 * v);
      break;
    }
    case 'exploitResult': {
      if (msg.ok) {
        [440, 554, 659, 880].forEach((f, i) => tone(f, f, 0.12, 'square', 0.2, i * 0.09));
      } else {
        tone(120, 100, 0.25, 'square', 0.25);
      }
      break;
    }
    case 'patchResult': {
      if (msg.accepted) {
        tone(520, 520, 0.1, 'sine', 0.25);
        tone(780, 780, 0.15, 'sine', 0.25, 0.1);
      } else {
        tone(120, 100, 0.25, 'square', 0.25);
      }
      break;
    }
    case 'weaponSaved': {
      if (msg.ok) tone(700, 900, 0.1, 'sine', 0.25);
      else tone(120, 100, 0.25, 'square', 0.25);
      break;
    }
    case 'terminalOpened': {
      tone(1200, 1200, 0.05, 'square', 0.15);
      break;
    }
  }
}

export function audioOnState(state: MatchState, youId: number): void {
  if (!ctx) return;
  const me = state.players.find((p) => p.id === youId);
  if (state.phase !== lastPhase) {
    if (state.phase === 'live') {
      tone(660, 660, 0.12, 'square', 0.25);
      tone(990, 990, 0.2, 'square', 0.25, 0.18);
    } else if (state.phase === 'ended' && state.winner) {
      if (me && me.team === state.winner) {
        [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.18, 'triangle', 0.3, i * 0.14));
      } else {
        tone(300, 150, 0.6, 'sawtooth', 0.3);
      }
    }
    lastPhase = state.phase;
  }
  for (const a of state.hackAlerts) {
    if (a.at > lastAlertAt) {
      lastAlertAt = a.at;
      if (me && a.team !== me.team) {
        tone(880, 880, 0.15, 'square', 0.2);
        tone(660, 660, 0.15, 'square', 0.2, 0.2);
      }
    }
  }
}
