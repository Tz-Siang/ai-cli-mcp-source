/**
 * Codex 額度讀取：短命 stdio JSON-RPC client，不建立 thread、不呼叫模型。
 * Windows npm shim 解析成 Node + JS argv，避免 shell 字串與含空白路徑的跳脫問題。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, win32 } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { buildWorkerEnv } from '../core/worker-env.js';

const require = createRequire(import.meta.url);
const CLIENT_VERSION: string = require('../../package.json').version;
export const CODEX_APP_SERVER_TIMEOUT_MS = 20_000;
const MAX_FRAME_BYTES = 1024 * 1024;

interface CommandOptions {
  platform?: NodeJS.Platform;
  readFile?: (file: string) => string;
  exists?: (file: string) => boolean;
}

/** 只解析 npm 生成的 Codex JS shim；不執行任意 batch 內容。未知 shim 交由 fallback。 */
export function resolveCodexCommand(cliPath: string, args: string[], options: CommandOptions = {}) {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  if (!cliPath) throw new Error('codex CLI not configured');
  let file = cliPath;
  if (platform === 'win32') {
    if (!/[\\/]/.test(file)) {
      const dirs = (process.env.PATH ?? '').split(delimiter);
      const names = /\.(?:exe|cmd|bat)$/i.test(file) ? [file] : [file + '.exe', file + '.cmd', file + '.bat'];
      file = dirs.flatMap(dir => names.map(name => join(dir.replace(/^"|"$/g, ''), name))).find(exists) ?? file;
    }
    if (/\.(cmd|bat)$/i.test(file)) {
      const text = (options.readFile ?? (p => readFileSync(p, 'utf8')))(file);
      const entry = text.match(/"%(?:dp0|~dp0)%?[\\/]([^"\r\n]*node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js)"\s+%\*/i)?.[1];
      if (!entry) throw new Error('unsupported Codex npm shim');
      const base = win32.dirname(file);
      const script = win32.resolve(base, entry);
      if (!exists(script)) throw new Error('Codex npm shim entry not found');
      const localNode = win32.join(base, 'node.exe');
      return { file: exists(localNode) ? localNode : process.execPath, args: [script, ...args] };
    }
  }
  return { file, args: [...args] };
}

export function codexVersionFromText(text: string): string | null {
  return text.match(/(?:ai-cli\/|codex-cli\s+|codex\/|v)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i)?.[1] ?? null;
}

function readableReset(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** primary / secondary 是服務端的順序；額度分類依視窗長度，不能依欄位位置。 */
export function mapCodexRateLimits(result: any, cliVersion: string | null = null, nowMs = Date.now()) {
  const rl = result?.rateLimits;
  const window = (w: any) => {
    if (!w || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100
      || !Number.isFinite(w.windowDurationMins)) return null;
    const reset = Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000) : null;
    if (reset && !Number.isFinite(reset.getTime())) return null;
    return {
      percentUsed: w.usedPercent,
      percentRemaining: Math.round((100 - w.usedPercent) * 100) / 100,
      basis: 'used' as const,
      resetAt: reset ? readableReset(reset) : null,
      resetAtIso: reset?.toISOString() ?? null,
      windowMinutes: w.windowDurationMins,
    };
  };
  const windows = [window(rl?.primary), window(rl?.secondary)].filter(w => w !== null);
  const weekly = windows.find(w => w.windowMinutes === 10080) ?? null;
  const fiveHour = windows.find(w => w.windowMinutes === 300) ?? null;
  if (!weekly && !fiveHour) throw new Error('app-server returned no recognized quota windows');
  const raw = [[fiveHour, '5h'], [weekly, 'Weekly']].flatMap(([w, label]) => {
    if (!w || typeof w === 'string') return [];
    return [`${label} limit: ${w.percentUsed}% used (${w.percentRemaining}% left)${w.resetAt ? ', resets ' + w.resetAt : ''}`];
  }).join('\n');
  return {
    type: 'rate_limits', source: 'app-server', asOf: new Date(nowMs).toISOString(), cliVersion,
    account: null, model: null, plan: typeof rl.planType === 'string' ? rl.planType : null,
    weekly, fiveHour,
    resetCreditsAvailable: Number.isFinite(result.rateLimitResetCredits?.availableCount) ? result.rateLimitResetCredits.availableCount : null,
    rateLimitReachedType: rl.rateLimitReachedType ?? null, raw,
  };
}

/** Windows 先殺樹再關 root，避免 root 提早退出使子孫失聯；只用本次 child 的 PID。 */
export async function stopCodexProcess(child: ReturnType<typeof spawn>, platform = process.platform): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    await new Promise<void>(resolve => {
      let killer: ReturnType<typeof spawn>;
      try { killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false, windowsHide: true }); }
      catch { try { child.kill('SIGKILL'); } catch {} resolve(); return; }
      const timer = setTimeout(() => { try { killer.kill(); child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} done(); });
      killer.once('close', code => { if (code !== 0) { try { child.kill('SIGKILL'); } catch {} } done(); });
    });
  } else {
    // detached:true 建立自己的 process group，不能波及 client 或其他 Codex。
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

export interface CodexRpcOptions {
  spawnFn?: typeof spawn;
  timeoutMs?: number;
  killTree?: (pid: number, child: ReturnType<typeof spawn>) => Promise<unknown>;
}

export async function readCodexAppServerUsage(cliPath: string, options: CodexRpcOptions = {}) {
  const command = resolveCodexCommand(cliPath, ['app-server']);
  const child = (options.spawnFn ?? spawn)(command.file, command.args, {
    cwd: homedir(), env: buildWorkerEnv(), stdio: ['pipe', 'pipe', 'pipe'],
    shell: false, windowsHide: true, detached: process.platform !== 'win32',
  });
  let cliVersion: string | null = null;
  try {
    return await new Promise<ReturnType<typeof mapCodexRateLimits>>((resolve, reject) => {
      let buffer = '', settled = false, initialized = false;
      const timer = setTimeout(() => fail(`app-server timed out after ${options.timeoutMs ?? CODEX_APP_SERVER_TIMEOUT_MS}ms`), options.timeoutMs ?? CODEX_APP_SERVER_TIMEOUT_MS);
      const done = () => { settled = true; clearTimeout(timer); };
      const fail = (message: string) => { if (settled) return; done(); reject(Object.assign(new Error(message), { cliVersion })); };
      const send = (msg: unknown) => {
        if (settled) return;
        try { child.stdin!.write(JSON.stringify(msg) + '\n'); } catch (e) { fail(`app-server stdin: ${String(e)}`); }
      };
      child.once('error', e => fail(`app-server spawn: ${e.message}`));
      child.once('close', code => fail(`app-server exited before quota response (exit ${code})`));
      child.stdin!.on('error', e => fail(`app-server stdin: ${e.message}`));
      child.stdout!.on('error', e => fail(`app-server stdout: ${e.message}`));
      child.stdout!.setEncoding('utf8');
      child.stderr!.resume(); // drain without leaking account/token diagnostics into the result
      child.stderr!.on('error', e => fail(`app-server stderr: ${e.message}`));
      child.stdout!.on('data', (chunk: string) => {
        if (settled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { fail('app-server JSON frame exceeds 1 MiB'); return; }
        let end: number;
        while (!settled && (end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { fail('app-server stdout is not JSON'); return; }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { fail('app-server invalid JSON-RPC message'); return; }
          if (msg.id !== (initialized ? 2 : 1)) continue; // notifications and unrelated messages
          if (msg.error) { fail(`app-server RPC ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown error'}`); return; }
          if (!initialized) {
            if (!msg.result || typeof msg.result !== 'object') { fail('app-server invalid initialize response'); return; }
            cliVersion = codexVersionFromText(msg.result.userAgent ?? '');
            initialized = true;
            send({ jsonrpc: '2.0', method: 'initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null });
          } else {
            try { const usage = mapCodexRateLimits(msg.result, cliVersion); done(); resolve(usage); }
            catch (e) { fail(`app-server quota: ${(e as Error).message}`); }
          }
        }
      });
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'ai-cli', version: CLIENT_VERSION } } });
    });
  } finally {
    if (child.pid) {
      if (options.killTree) await options.killTree(child.pid, child);
      else await stopCodexProcess(child);
    }
  }
}

/** RPC 不支援／啟動失敗時仍取得版本，用於最後手段的 TUI 預警。 */
export async function readCodexCliVersion(cliPath: string): Promise<string | null> {
  let child: ReturnType<typeof spawn>;
  try {
    const command = resolveCodexCommand(cliPath, ['--version']);
    child = spawn(command.file, command.args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  } catch { return null; }
  let text = '';
  try {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5000);
      const done = () => { clearTimeout(timer); resolve(); };
      child.once('error', done); child.once('close', done);
      child.stdout!.on('error', done);
      child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (d: string) => { if (text.length < 4096) text += d; });
    });
    return codexVersionFromText(text);
  } finally { await stopCodexProcess(child); }
}
