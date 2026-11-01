import * as THREE from 'three';
import type { ServerToClient, MatchState, WeaponScriptFile, BudgetReport } from '../shared/protocol.js';
import { initAudio, toggleMute, handleAudioEvent, audioOnState } from './audio.js';

const $ = <T extends HTMLElement = HTMLDivElement>(id: string) => document.getElementById(id) as T;

let ws: WebSocket;
let youId = 0;
let state: MatchState | null = null;
let templates: WeaponScriptFile[] = [];
let budgetCfg: any = null;
let matchCfg: any = null;
let inTerminal = -1;
let lastWeaponReport: { report?: BudgetReport } | null = null;

const TRACERS: { line: THREE.Line; until: number }[] = [];
const EXPLOSIONS: { mesh: THREE.Mesh; start: number; dur: number; radius: number }[] = [];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10131a);
scene.fog = new THREE.Fog(0x10131a, 30, 80);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
$('app').appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0x9fb6ff, 0x20242e, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(10, 30, 10);
scene.add(dir);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshLambertMaterial({ color: 0x1b2130 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(40, 40, 0x2d3648, 0x232c3d);
grid.position.y = 0.01;
scene.add(grid);

const wallMat = new THREE.MeshLambertMaterial({ color: 0x2b3346 });
const walls3d: { mesh: THREE.Mesh }[] = [];
const WALLS = [
  [-20, -20, 20, -19], [-20, 19, 20, 20], [-20, -20, -19, 20], [19, -20, 20, 20],
  [-6, -4, -1, -3], [-6, 3, -1, 4], [1, -4, 6, -3], [1, 3, 6, 4], [-1, -1, 1, 1],
];
for (const [x0, z0, x1, z1] of WALLS) {
  const w = x1 - x0, d = z1 - z0;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w || 0.6, 3, d || 0.6), wallMat);
  mesh.position.set((x0 + x1) / 2, 1.5, (z0 + z1) / 2);
  scene.add(mesh);
  walls3d.push({ mesh });
}

const TERMINALS = [{ x: -12, z: 0 }, { x: 12, z: 0 }];
const terminalMeshes: THREE.Mesh[] = [];
for (const t of TERMINALS) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1.8, 0.6), new THREE.MeshLambertMaterial({ color: 0x0e6b4f }));
  m.position.set(t.x, 0.9, t.z);
  scene.add(m);
  terminalMeshes.push(m);
}

const playerMeshes = new Map<number, THREE.Group>();
function playerMesh(team: string) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 4, 8), new THREE.MeshLambertMaterial({ color: team === 'red' ? 0xb04545 : 0x4577b0 }));
  body.position.y = 0.85;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), new THREE.MeshLambertMaterial({ color: 0xd8c0a0 }));
  head.position.y = 1.55;
  g.add(head);
  scene.add(g);
  return g;
}

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onopen = () => {
    const name = ($('name') as HTMLInputElement).value || 'player';
    ws.send(JSON.stringify({ t: 'join', name }));
  };
  ws.onclose = () => setTimeout(connect, 1500);
}

function send(msg: any) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg: ServerToClient) {
  handleAudioEvent(msg, youId, state);
  switch (msg.t) {
    case 'joined':
      youId = msg.youId;
      templates = msg.templates ?? [];
      budgetCfg = (msg.config as any)?.budget;
      matchCfg = (msg.config as any)?.match;
      $('menu').style.display = 'none';
      break;
    case 'state':
      state = msg.state;
      renderState();
      break;
    case 'weaponSaved':
      lastWeaponReport = msg as any;
      if (msg.ok) showLog('weapon saved & equipped');
      else showLog('weapon rejected: ' + (msg as any).error);
      break;
    case 'terminalOpened':
      openTerminalUI(msg.serverId, msg.source, msg.vulnTypeHint);
      break;
    case 'exploitResult':
      showLog('exploit ' + (msg.ok ? 'SUCCESS — server going down!' : 'failed') + ' :: ' + (msg.log ?? []).join(' | '));
      if (msg.ok) closeEditor();
      break;
    case 'patchResult':
      showLog('patch ' + (msg.accepted ? 'deployed' : 'rejected') + ' :: ' + (msg.log ?? []).join(' | '));
      break;
    case 'shot': {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(msg.from.x, msg.from.y, msg.from.z),
        new THREE.Vector3(msg.to.x, msg.to.y, msg.to.z),
      ]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe08a }));
      scene.add(line);
      TRACERS.push({ line, until: performance.now() + 90 });
      break;
    }
    case 'explosion': {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.8 }),
      );
      mesh.position.set(msg.pos.x, Math.max(0.5, msg.pos.y), msg.pos.z);
      mesh.scale.setScalar(0.1);
      scene.add(mesh);
      EXPLOSIONS.push({ mesh, start: performance.now(), dur: 350, radius: msg.radius });
      break;
    }
    case 'died':
      if (msg.id === youId) showLog('you were eliminated — respawning…');
      break;
    case 'error':
      showLog(msg.message);
      break;
  }
}

function showLog(text: string) {
  const el = $('log');
  el.innerHTML = `${new Date().toLocaleTimeString()} — ${text}<br>` + el.innerHTML;
  if (el.innerHTML.split('<br>').length > 8) el.innerHTML = el.innerHTML.split('<br>').slice(0, 8).join('<br>');
}

function renderState() {
  if (!state) return;
  audioOnState(state, youId);
  const phase = $('phase');
  const remain = Math.max(0, Math.ceil((state.phaseEndsAt - Date.now()) / 1000));
  phase.textContent = `${state.phase} ${remain}s`;
  $('score').innerHTML = `<span class="red">RED ${state.score.red}</span> : <span class="blue">${state.score.blue} BLUE</span>`;

  const you = state.players.find((p) => p.id === youId);
  if (you) {
    $('hpval').textContent = String(you.hp);
    $('hpbar').style.width = (100 * you.hp / you.maxHp) + '%';
    $('wname').textContent = you.weaponName;
    $('wammo').textContent = `${you.ammo}/${you.magazine}`;
    camera.position.set(you.pos.x, 1.6, you.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = you.yaw + Math.PI;
    camera.rotation.x = pitch;
  }

  const seen = new Set<number>();
  for (const p of state.players) {
    seen.add(p.id);
    let g = playerMeshes.get(p.id);
    if (!g) { g = playerMesh(p.team); playerMeshes.set(p.id, g); }
    g.visible = p.alive;
    g.position.set(p.pos.x, 0, p.pos.z);
    g.rotation.y = p.yaw;
  }
  for (const [id, g] of playerMeshes) {
    if (!seen.has(id)) { scene.remove(g); playerMeshes.delete(id); }
  }

  const sbEl = $('serversbox');
  sbEl.innerHTML = state.servers.map((s) =>
    `<div class="server ${s.hacked ? 'hacked' : 'secure'}">server-${s.id}: ${s.hacked ? 'HACKED' : 'online'}</div>`
  ).join('');

  const alerts = state.hackAlerts.filter((a) => Date.now() - a.at < 4000);
  $('alert').textContent = alerts.length
    ? `⚠ team ${alerts[alerts.length - 1].team} is hacking server-${alerts[alerts.length - 1].serverId}!`
    : '';

  if (state.phase === 'ended' && state.winner) {
    $('winner').style.display = 'flex';
    $('winner-text').innerHTML = `<span class="${state.winner}">${state.winner.toUpperCase()} WINS</span> by ${state.winReason}`;
    $('board').innerHTML =
      '<tr><th>player</th><th>team</th><th>kills</th><th>deaths</th><th>hacks</th></tr>' +
      state.players.map((p) =>
        `<tr><td>${p.name}</td><td class="${p.team}">${p.team}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.hacks}</td></tr>`
      ).join('');
  } else {
    $('winner').style.display = 'none';
  }
}

let keys: Record<string, boolean> = {};
let mouseDown = false;
let pointerLocked = false;
let yaw = 0, pitch = 0;

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Tab') { e.preventDefault(); openEditor('weapon'); }
  if (e.code === 'KeyE') tryInteract();
  if (e.code === 'KeyM' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
    showLog(toggleMute() ? 'sound off' : 'sound on');
  }
  if (e.code === 'Escape') { closeEditor(); closeTerminal(); }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
renderer.domElement.addEventListener('mousedown', (e) => {
  initAudio();
  mouseDown = true;
  if (!pointerLocked) renderer.domElement.requestPointerLock();
});
addEventListener('mouseup', () => { mouseDown = false; });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) {
    yaw -= e.movementX * 0.0022;
    pitch = Math.max(-1.2, Math.min(1.2, pitch - e.movementY * 0.0022));
  }
});

let lastInput = performance.now();
setInterval(() => {
  if (!state || state.phase !== 'live') return;
  if ($('editor').style.display === 'flex' || inTerminal >= 0) return;
  const now = performance.now();
  const dt = (now - lastInput) / 1000;
  lastInput = now;
  const move = { x: 0, z: 0 };
  if (keys['KeyW']) move.z += 1;
  if (keys['KeyS']) move.z -= 1;
  if (keys['KeyA']) move.x -= 1;
  if (keys['KeyD']) move.x += 1;
  send({ t: 'input', seq: 0, dt, move, yaw, pitch, shoot: mouseDown, interact: false });
}, 50);

function tryInteract() {
  if (!state || inTerminal >= 0 || editorMode) return;
  const you = state.players.find((p) => p.id === youId);
  if (!you) return;
  for (const s of state.servers) {
    const d = Math.hypot(you.pos.x - s.pos.x, you.pos.z - s.pos.z);
    if (d < 3) {
      send({ t: 'openTerminal', serverId: s.id });
      return;
    }
  }
  showLog('no terminal in range');
}

const HELP_WEAPON = `Weapon script: return a table with
  name          string
  hp            20..100  (your body!)
  damage        > 0
  fireIntervalMs >= 50
  hitscan       true|false
  projectileSpeed (when hitscan=false)
  magazine      >= 1
  reloadMs      >= 300
  recoil        0..3 (low = cheap)
  spreadDeg     0.05..10
  knockback     0..3
  slow          0..1 (seconds)
  aoeRadius     0..5 (area damage)
  aoeDamageFalloff 0..1

Budget: ${'${total}'} points total, shown live on save.
Templates on the right — click to load.`;

const HELP_EXPLOIT = `Read the server source on the left of the game screen (walk to the terminal, press E).
Two known vulnerability classes:
1) SQL injection in login() — the query is built with "..".
2) No rate limit on checkPin() brute force.

Your exploit runs sandboxed on the server.
Call the service functions and trigger the flaw.`;

const HELP_PATCH = `You are DEFENSE. Write a patch that:
  validate(s)  -- sanitize inputs (reject quotes/semicolons)
  rate(key)    -- rate-limit repeated attempts
A patch that breaks legitimate login is REJECTED by self-check.`;

let editorMode: 'weapon' | 'exploit' | 'patch' | null = null;
let editingServer = -1;

function openEditor(mode: 'weapon' | 'exploit' | 'patch', serverId = -1) {
  editorMode = mode;
  editingServer = serverId;
  $('editor').style.display = 'flex';
  const title = $('ed-title');
  const help = $('ed-help');
  const save = $('ed-save');
  if (mode === 'weapon') {
    title.textContent = 'weapon editor';
    help.innerHTML = HELP_WEAPON.replace('${total}', budgetCfg?.totalPoints ?? 100);
    if (templates.length && !$('ed-code').value.trim()) $('ed-code').value = templates[0].code;
    save.textContent = 'save & equip';
    addTemplateButtons();
  } else if (mode === 'exploit') {
    title.textContent = `exploit editor — server-${serverId}`;
    help.textContent = HELP_EXPLOIT;
    save.textContent = 'run exploit';
  } else {
    title.textContent = `defense patch — server-${serverId}`;
    help.textContent = HELP_PATCH;
    save.textContent = 'deploy patch';
  }
}

function addTemplateButtons() {
  const help = $('ed-help');
  for (const tpl of templates) {
    const b = document.createElement('button');
    b.textContent = 'load ' + tpl.name;
    b.className = 'ghost';
    b.style.display = 'block';
    b.style.margin = '6px 0';
    b.onclick = () => { $('ed-code').value = tpl.code; };
    if (![...help.children].some((c) => (c as HTMLElement).textContent === b.textContent)) help.appendChild(b);
  }
}

function closeEditor() {
  $('editor').style.display = 'none';
  editorMode = null;
}

$('ed-close').onclick = closeEditor;
$('ed-save').onclick = () => {
  const code = ($('ed-code') as HTMLTextAreaElement).value;
  if (editorMode === 'weapon') {
    send({ t: 'saveWeapon', code });
  } else if (editorMode === 'exploit') {
    send({ t: 'submitExploit', serverId: editingServer, code });
  } else if (editorMode === 'patch') {
    send({ t: 'submitPatch', serverId: editingServer, code });
  }
};

function openTerminalUI(serverId: number, source: string, hint: string) {
  inTerminal = serverId;
  const box = $('sourcebox');
  box.style.display = 'block';
  box.textContent = `-- server-${serverId} source (${hint})\n\n` + source;
  document.exitPointerLock?.();
  const mode: 'exploit' | 'patch' = (state?.players.find((p) => p.id === youId)?.team) === 'blue' ? 'patch' : 'exploit';
  openEditor(mode, serverId);
  const tabs = document.createElement('div');
  tabs.style.cssText = 'position:fixed;top:8px;right:8px;display:flex;gap:8px;z-index:60';
  tabs.innerHTML = `<button id="tab-exploit" class="ghost">exploit</button><button id="tab-patch" class="ghost">defense patch</button>`;
  document.body.appendChild(tabs);
  const setMode = (m: 'exploit' | 'patch') => {
    (document.getElementById('tab-exploit') as HTMLButtonElement).style.background = m === 'exploit' ? '#2b6cb0' : '#232c3d';
    (document.getElementById('tab-patch') as HTMLButtonElement).style.background = m === 'patch' ? '#2b6cb0' : '#232c3d';
    openEditor(m, serverId);
    ($('ed-code') as HTMLTextAreaElement).value = m === 'exploit'
      ? `local r = login("admin' OR '1'='1", "x")\nif r.ok then print("root access") end`
      : `function validate(s)\n  return type(s) == "string" and not s:find("[';]");\nend\nlocal seen = {}\nfunction rate(key)\n  seen[key] = (seen[key] or 0) + 1\n  return seen[key] <= 5\nend`;
  };
  (document.getElementById('tab-exploit') as HTMLButtonElement).onclick = () => setMode('exploit');
  (document.getElementById('tab-patch') as HTMLButtonElement).onclick = () => setMode('patch');
  setMode(mode);
}

function closeTerminal() {
  if (inTerminal < 0) return;
  send({ t: 'closeTerminal' });
  inTerminal = -1;
  $('sourcebox').style.display = 'none';
  closeEditor();
  document.querySelectorAll('#tab-exploit, #tab-patch').forEach((el) => (el as HTMLElement).remove());
  const tabs = document.querySelector('div[style*="z-index:60"]');
  if (tabs) tabs.remove();
}

$('join').onclick = () => { initAudio(); connect(); };

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  for (let i = TRACERS.length - 1; i >= 0; i--) {
    if (now > TRACERS[i].until) {
      scene.remove(TRACERS[i].line);
      TRACERS[i].line.geometry.dispose();
      TRACERS.splice(i, 1);
    }
  }
  for (let i = EXPLOSIONS.length - 1; i >= 0; i--) {
    const ex = EXPLOSIONS[i];
    const k = (now - ex.start) / ex.dur;
    if (k >= 1) {
      scene.remove(ex.mesh);
      ex.mesh.geometry.dispose();
      (ex.mesh.material as THREE.Material).dispose();
      EXPLOSIONS.splice(i, 1);
    } else {
      ex.mesh.scale.setScalar(Math.max(0.1, ex.radius * k));
      (ex.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k);
    }
  }
  renderer.render(scene, camera);
}
animate();
