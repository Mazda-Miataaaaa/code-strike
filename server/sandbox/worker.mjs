import { parentPort } from 'node:worker_threads';
import { LuaFactory } from 'wasmoon';

const factory = new LuaFactory();
let engine = null;

async function ensureEngine() {
  if (!engine) {
    engine = await factory.createEngine({ openStandardLibs: true, injectObjects: false, enableProxy: true });
    const g = engine.global;
    g.set('print', () => {});
    for (const lib of ['io', 'os', 'package', 'debug']) {
      try { g.set(lib, undefined); } catch {}
    }
  }
  return engine;
}

parentPort.on('message', async (msg) => {
  const port = parentPort;
  try {
    const eng = await ensureEngine();
    const thread = eng.global.newThread();
    thread.loadString(msg.code, 'script');
    const result = await thread.run(0);
    const value = result.length > 0 ? result[0] : undefined;
    port.postMessage({ id: msg.id, ok: true, value });
  } catch (e) {
    port.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
});
