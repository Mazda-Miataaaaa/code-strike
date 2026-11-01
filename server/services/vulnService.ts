import type { LuaSandbox } from '../sandbox/pool.js';

export interface ServiceRequest { path: string; body: Record<string, any> }
export interface ServiceResponse { status: number; body: Record<string, any> }

export interface ExploitOutcome { ok: boolean; blocked: boolean; log: string[] }

export interface GameService {
  id: number;
  name: string;
  displayedSource: string;
  vulnTypeHint: string;
  patchCode: string | null;
  isDown: boolean;
  downAt: number | null;
  hackAttempts: { at: number; team: string; detail: string; caught: boolean }[];
  applyPatch(sandbox: LuaSandbox, code: string): Promise<{ accepted: boolean; log: string[] }>;
  runExploit(sandbox: LuaSandbox, code: string, fromTeam: string): Promise<ExploitOutcome>;
  reset(): void;
}

export function makeAuthService(id: number, pinLength: number): GameService {
  const pin = String(Math.floor(Math.random() * Math.pow(10, pinLength))).padStart(pinLength, '0');
  const state = {
    patchCode: null as string | null,
    isDown: false,
    downAt: null as number | null,
    hackAttempts: [] as { at: number; team: string; detail: string; caught: boolean }[],
  };

  const displayedSource = `-- services/auth/service.lua :: session & door auth
-- functions callable from an exploit: login(user, pin), checkPin(pin)
local db = {
  { user = "admin", pin = "????", role = "root" },
  { user = "guest", pin = "0000", role = "user" },
}

function login(user, pin)
  -- the auth "query" is built by raw string concatenation:
  local q = "SELECT role FROM users WHERE user='" .. user .. "' AND pin='" .. pin .. "'"
  for _, r in ipairs(db) do
    if r.user == user and r.pin == pin then
      return { ok = true, role = r.role }
    end
  end
  -- an injected OR inside the query matches every row:
  if string.find(user, "' OR '1'='1") then
    return { ok = true, role = "root" }
  end
  return { ok = false, err = "bad credentials" }
end

local pinTries = 0 -- counted but NEVER limited
function checkPin(pin)
  pinTries = pinTries + 1
  if pin == "????" then return { ok = true } end
  return { ok = false }
end
`;

  const runtimePrelude = `local db = {
  { user = "admin", pin = "${pin}", role = "root" },
  { user = "guest", pin = "0000", role = "user" },
}
function login(user, pin)
  local q = "SELECT role FROM users WHERE user='" .. user .. "' AND pin='" .. pin .. "'"
  for _, r in ipairs(db) do
    if r.user == user and r.pin == pin then
      return { ok = true, role = r.role }
    end
  end
  if string.find(user, "' OR '1'='1") then
    return { ok = true, role = "root" }
  end
  return { ok = false, err = "bad credentials" }
end
local pinTries = 0
function checkPin(pin)
  pinTries = pinTries + 1
  if pin == "${pin}" then return { ok = true } end
  return { ok = false }
end
`;

  function patchWrap(patch: string): string {
    return `
do
  local __login, __check = login, checkPin
  ${patch}
  if validate then
    login = function(u, p)
      if not validate(u) or not validate(p) then return { ok = false, err = "invalid input" } end
      return __login(u, p)
    end
  end
  if rate then
    checkPin = function(p)
      if not rate("pin:" .. tostring(p)) then return { ok = false, err = "rate limited" } end
      return __check(p)
    end
  end
end
`;
  }

  const harness = `
local __flags = { login_ok = false, pin_ok = false, blocked = false, error = nil }
do
  local __login, __check = login, checkPin
  login = function(u, p)
    local r = __login(u, p)
    if r and r.ok then __flags.login_ok = true end
    if r and (r.err == "invalid input" or r.err == "rate limited") then __flags.blocked = true end
    return r
  end
  checkPin = function(p)
    local r = __check(p)
    if r and r.ok then __flags.pin_ok = true end
    return r
  end
end
`;

  async function run(sandbox: LuaSandbox, script: string, timeoutMs = 1000) {
    return sandbox.run(script, { timeoutMs });
  }

  function recordAttempt(team: string, detail: string, caught: boolean) {
    state.hackAttempts.push({ at: Date.now(), team, detail, caught });
    if (state.hackAttempts.length > 100) state.hackAttempts.shift();
  }

  return {
    id,
    name: 'auth',
    displayedSource,
    vulnTypeHint: 'SQL injection in login(); no rate limit on checkPin() brute force',
    get patchCode() { return state.patchCode; },
    get isDown() { return state.isDown; },
    get downAt() { return state.downAt; },
    get hackAttempts() { return state.hackAttempts; },

    async applyPatch(sandbox, code) {
      const log: string[] = [];
      if (!/validate|rate|limit/.test(code)) {
        return { accepted: false, log: ['patch must define validate() or rate-limit the endpoints'] };
      }
      if (/function\s+validate\s*\([^)]*\)\s*return\s+false/.test(code)) {
        return { accepted: false, log: ['self-check failed: patch rejects every legitimate user, patch rejected'] };
      }
      const selfCheck = `
${runtimePrelude}
${patchWrap(code)}
local a = login("admin", "${pin}")
local g = login("guest", "0000")
local i = login("admin' OR '1'='1", "x")
return { admin = a.ok, guest = g.ok, injected_blocked = not i.ok }
`;
      const r = await run(sandbox, selfCheck);
      if (!r.ok) {
        return { accepted: false, log: ['patch error: ' + (r.killed ? 'instruction budget exceeded' : r.error)] };
      }
      const v = r.value as any;
      if (!v || !v.admin || !v.guest) {
        return { accepted: false, log: ['self-check failed: legitimate login broken, patch rejected'] };
      }
      state.patchCode = code;
      log.push('self-check passed: legitimate logins work');
      if (v.injected_blocked) log.push('injection blocked by validate()');
      else log.push('note: validate() does not block the injection — attackers may still get through');
      return { accepted: true, log };
    },

    async runExploit(sandbox, code, fromTeam) {
      const script = `
${runtimePrelude}
${state.patchCode ? patchWrap(state.patchCode) : ''}
${harness}
local ok, err = pcall(function()
${code}
end)
if not ok then __flags.error = tostring(err) end
return __flags
`;
      const r = await run(sandbox, script);
      if (!r.ok) {
        return {
          ok: false, blocked: false,
          log: [r.killed ? 'exploit killed: instruction budget exceeded' : `exploit error: ${r.error}`],
        };
      }
      const v = r.value as any;
      if (v && v.error) {
        return { ok: false, blocked: false, log: ['exploit error: ' + v.error] };
      }
      const success = !!v && (!!v.login_ok || !!v.pin_ok);
      const blocked = !!v && !!v.blocked;
      if (success && !blocked) {
        recordAttempt(fromTeam, 'exploit succeeded: service compromised', false);
        state.isDown = true;
        state.downAt = Date.now();
        return { ok: true, blocked: false, log: ['vulnerability triggered — service going down'] };
      }
      if (blocked) {
        recordAttempt(fromTeam, 'exploit blocked by defense patch', true);
        return { ok: false, blocked: true, log: ['defense patch blocked the exploit'] };
      }
      recordAttempt(fromTeam, 'exploit ran but triggered nothing', false);
      return { ok: false, blocked: false, log: ['exploit did not trigger any vulnerability'] };
    },

    reset() {
      state.isDown = false;
      state.downAt = null;
      state.patchCode = null;
      state.hackAttempts = [];
    },
  } as GameService;
}

export interface GameServiceMap {
  services: GameService[];
  get(id: number): GameService | undefined;
  resetAll(): void;
}

export function makeServiceMap(count: number, pinLength: number): GameServiceMap {
  const services = Array.from({ length: count }, (_, i) => makeAuthService(i, pinLength));
  return {
    services,
    get: (id) => services[id],
    resetAll: () => services.forEach((s) => s.reset()),
  };
}
