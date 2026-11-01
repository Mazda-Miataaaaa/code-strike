import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface LuaResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  killed?: boolean;
  log?: string[];
}

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));

export class LuaSandbox {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: LuaResult) => void; timer: NodeJS.Timeout }>();
  private startPromise: Promise<Worker> | null = null;
  private warmed = false;
  private debugLog: string[] = [];

  private async start(): Promise<Worker> {
    if (!this.startPromise) {
      this.startPromise = new Promise<Worker>((resolve, reject) => {
        const w = new Worker(WORKER_PATH);
        w.once('online', () => { this.worker = w; resolve(w); });
        w.once('error', reject);
        w.on('message', (msg: any) => this.onMessage(msg));
      });
    }
    return this.startPromise;
  }

  private onMessage(msg: any) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve({
      ok: msg.ok,
      value: msg.value,
      error: msg.error,
      killed: msg.killed,
      log: this.debugLog.splice(0),
    });
  }

  async run(code: string, options: { timeoutMs: number } = { timeoutMs: 200 }): Promise<LuaResult> {
    const worker = await this.start();
    const id = this.nextId++;
    const timeoutMs = this.warmed ? options.timeoutMs : Math.max(options.timeoutMs * 5, 3000);
    this.warmed = true;
    this.debugLog.push(`[lua] run ${id} (${code.length} bytes)`);
    return new Promise<LuaResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.worker) this.killWorker();
        resolve({ ok: false, killed: true, error: 'instruction budget exceeded', log: this.debugLog.splice(0) });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      worker.postMessage({ id, code });
    });
  }

  private killWorker() {
    if (!this.worker) return;
    this.worker.terminate().catch(() => {});
    this.worker = null;
    this.startPromise = null;
    this.warmed = false;
  }

  async close() {
    this.killWorker();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: 'sandbox closed' });
      this.pending.delete(id);
    }
  }
}
