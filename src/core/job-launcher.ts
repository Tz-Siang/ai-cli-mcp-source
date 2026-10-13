/** Windows 短命 launcher：交回 runner PID 後退出，讓 server 的 tree kill 列舉不到 runner。 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.argv[2];
const report = (value: unknown) => writeFileSync(join(directory, 'launcher.json'), JSON.stringify(value) + '\n', { mode: 0o600 });
try {
  // env 已由 JobStore buildWorkerEnv；stdio 不保留 server 的 pipe，也不等待 runner 完成。
  const runner = spawn(process.execPath, [fileURLToPath(new URL('./job-runner.js', import.meta.url)), directory, '--wait-launcher'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: process.env,
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  runner.once('error', error => { report({ error: error.message }); process.exitCode = 1; });
  runner.once('spawn', () => {
    try { report({ pid: runner.pid, launcherPid: process.pid }); }
    catch (error) { console.error('ai-cli launcher:', error); process.exitCode = 1; }
    runner.unref();
  });
} catch (error) {
  report({ error: (error as Error).message }); process.exitCode = 1;
}
