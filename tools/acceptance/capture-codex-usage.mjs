/** 真機素材擷取：只開 /status，不呼叫模型；畫面回顯後才按 Enter。 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { renderTerminal, isCodexTuiReady, parseCodexUsage } from '../../dist/plugins/usage-service.js';
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pty = createRequire(import.meta.url)('@homebridge/node-pty-prebuilt-multiarch');
const cli = process.argv[2] || 'codex';
const p = pty.spawn(cli, ['--no-daemon', '-c', 'check_for_update_on_startup=false'],
  { name: 'xterm-color', cols: 200, rows: 50, cwd: homedir(), env: process.env });
let output = '', last = Date.now(), sent = false, echo = false, retried = false, sentAt = 0;
const chunks = {};
const started = Date.now();
const folder = join(ROOT, 'tests', 'fixtures', 'codex-0.162.1');
mkdirSync(folder, { recursive: true });
p.onData(d => { output += d; last = Date.now(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  while (Date.now() - started < 60000) {
    await sleep(200);
    const screen = renderTerminal(output);
    if (!sent && isCodexTuiReady(screen, Date.now() - last)) {
      chunks.before = output; sent = true; sentAt = Date.now(); p.write('/status');
    } else if (sent && !echo && /^›\s*\/status\s*$/m.test(screen)) {
      chunks.echo = output.slice(chunks.before.length); echo = true; p.write('\r');
    } else if (sent && !echo && !retried && Date.now() - sentAt > 10000) {
      // 清空可能已收到但尚未回顯的文字，避免重複疊字。
      retried = true; p.write('\x15/status');
    }
    if (echo && parseCodexUsage(output).type === 'rate_limits' && Date.now() - last > 800) {
      chunks.panel = output.slice(chunks.before.length + chunks.echo.length);
      // 遮罩 email 與 OSC 視窗標題；保留控制碼、字元寬度與原始重繪順序。
      const redact = raw => raw.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g)
        .map(part => part.startsWith('\x1b') ? part : part.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]+/g, m => 'x'.repeat(m.length))).join('')
        .replace(/(\x1b\]0;)([^\x07\x1b]*)(\x07|\x1b\\)/g, (_,start,title,end)=>start+title.replace(/[A-Za-z0-9]/g,'x')+end);
      for (const [name, raw] of Object.entries(chunks)) writeFileSync(join(folder, name + '.ansi'), redact(raw));
      writeFileSync(join(folder, 'capture.json'), JSON.stringify({ cliVersion: '0.162.1', capturedAt: new Date().toISOString(), cols: 200, rows: 50, elapsedMs: Date.now() - started, emailRedacted: true, titlesRedacted: true }, null, 2) + '\n');
      console.log(JSON.stringify({ elapsedMs: Date.now() - started, type: parseCodexUsage(output).type, bytes: Object.fromEntries(Object.entries(chunks).map(([k,v])=>[k,v.length])) }));
      break;
    }
  }
  if (!chunks.panel) throw new Error('capture timed out before quota panel');
} finally {
  if (process.platform === 'win32') await new Promise(resolve => {
    const killer = spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', shell: false, windowsHide: true });
    const timer = setTimeout(() => { try { killer.kill(); } catch {} resolve(); }, 3000);
    const done = () => { clearTimeout(timer); resolve(); };
    killer.on('error', done); killer.on('close', done);
  });
  else { try { p.kill(); } catch {} }
  try { p.kill(); } catch {} // ConPTY helper handles also belong to the PTY object
}
