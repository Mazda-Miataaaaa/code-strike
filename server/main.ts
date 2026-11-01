import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Match } from './game/match.js';
import { LuaSandbox } from './sandbox/pool.js';
import { setBudgetConfig, type BudgetConfig } from '../shared/budget.js';
import { WEAPON_TEMPLATES } from '../shared/templates.js';
import { matchConfig } from './game/config.js';
import type { ClientToServer, Team } from '../shared/protocol.js';
import balance from '../config/balance.json' with { type: 'json' };

const PORT = Number(process.env.PORT ?? 8090);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public');

setBudgetConfig(balance as unknown as BudgetConfig);

const sandbox = new LuaSandbox();
const match = new Match(sandbox, matchConfig);

const httpServer = createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url ?? '/';
  file = file.split('?')[0];
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !existsSync(full)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  };
  res.writeHead(200, { 'content-type': types[path.extname(full)] ?? 'application/octet-stream' });
  res.end(readFileSync(full));
});

const wss = new WebSocketServer({ server: httpServer });
const clients = new Map<WebSocket, { id: number }>();

function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

wss.on('connection', (ws) => {
  let playerId = 0;
  ws.on('message', async (data) => {
    let msg: ClientToServer;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.t === 'join') {
      const team: Team = msg.team ?? (match.players.size % 2 === 0 ? 'red' : 'blue');
      const p = match.addPlayer(msg.name.slice(0, 16) || 'player', team, false);
      playerId = p.id;
      clients.set(ws, { id: p.id });
      ws.send(JSON.stringify({
        t: 'joined', youId: p.id, state: match.state(),
        templates: WEAPON_TEMPLATES,
        config: { budget: (balance as any).budget, match: (balance as any).match },
      }));
      return;
    }
    if (!playerId) return;
    switch (msg.t) {
      case 'input':
        match.input(playerId, msg);
        break;
      case 'saveWeapon': {
        const r = await match.saveWeapon(playerId, msg.code);
        ws.send(JSON.stringify({ t: 'weaponSaved', ok: r.ok, error: r.error, report: r.points !== undefined ? { ok: r.ok, total: r.points, rows: [] } : undefined }));
        break;
      }
      case 'openTerminal': {
        const ok = match.openTerminal(playerId, msg.serverId);
        const svc = ok ? match.getServices().get(msg.serverId) : undefined;
        ws.send(JSON.stringify({
          t: 'terminalOpened', serverId: msg.serverId,
          source: svc?.displayedSource ?? '', vulnTypeHint: svc?.vulnTypeHint ?? '',
        }));
        break;
      }
      case 'closeTerminal':
        match.closeTerminal(playerId);
        break;
      case 'submitExploit': {
        const r = await match.submitExploit(playerId, msg.serverId, msg.code);
        ws.send(JSON.stringify({ t: 'exploitResult', serverId: msg.serverId, ok: r.ok, log: r.log }));
        break;
      }
      case 'submitPatch': {
        const r = await match.submitPatch(playerId, msg.serverId, msg.code);
        ws.send(JSON.stringify({ t: 'patchResult', serverId: msg.serverId, ok: r.accepted, log: r.log, accepted: r.accepted }));
        break;
      }
    }
  });
  ws.on('close', () => {
    if (playerId) match.removePlayer(playerId);
    clients.delete(ws);
  });
});

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = now - lastTick;
  lastTick = now;
  match.tick(dt);
  const events = match.takeEvents();
  for (const ev of events) broadcast(ev);
  broadcast({ t: 'state', state: match.state() });
}, 1000 / 20);

if (process.env.BOTS !== '0') {
  match.addPlayer('Bot-Rex', 'red', true);
  match.addPlayer('Bot-Vox', 'blue', true);
  if (match.players.size < 4) {
    match.addPlayer('Bot-Zed', 'blue', true);
  }
}
match.startPrep();

httpServer.listen(PORT, () => {
  console.log(`code-strike server listening on ws://localhost:${PORT} (public dir: ${PUBLIC_DIR})`);
});
