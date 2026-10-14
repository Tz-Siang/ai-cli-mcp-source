/** 有本機 Codex 才檢查協定 schema；不登入、不呼叫模型。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexCommand } from '../dist/plugins/codex-app-server.js';
// 不載入 catalog-test-env：只讀 CLI schema，沿用本機安裝位置。沒有 CLI 才 skip。
const name = process.env.CODEX_CLI_NAME || 'codex';
const probe = process.platform === 'win32'
  ? spawnSync('where.exe',[name],{encoding:'utf8',shell:false,windowsHide:true})
  : spawnSync('/bin/sh',['-c','command -v "$1"','sh',name],{encoding:'utf8',shell:false});
const installed = existsSync(name) || probe.status === 0;
if (!installed) console.log('SKIP Codex usage schema: 本機找不到 codex CLI（' + name + '）');
else {
  const folder = mkdtempSync(join(tmpdir(),'ai-cli-usage-schema-'));
  try {
    const paths = probe.stdout.trim().split(/\r?\n/);
    const detected = process.platform === 'win32' ? paths.find(p=>/\.(?:exe|cmd|bat)$/i.test(p)) : paths[0];
    const cmd=resolveCodexCommand(existsSync(name)?name:detected||name,['app-server','generate-json-schema','--out',folder]);
    const r=spawnSync(cmd.file,cmd.args,{encoding:'utf8',shell:false,windowsHide:true,timeout:20000,maxBuffer:1024*1024});
    assert.ifError(r.error);assert.equal(r.status,0,'schema generator must finish successfully: '+r.stderr);
    const request=JSON.parse(readFileSync(join(folder,'ClientRequest.json'),'utf8'));
    const hasMethod=value=>value==='account/rateLimits/read'||(value&&typeof value==='object'&&Object.values(value).some(hasMethod));
    assert.ok(hasMethod(request),'ClientRequest must contain account/rateLimits/read');
    console.log('PASS Codex ClientRequest contains account/rateLimits/read');
  } catch(e) { console.log('FAIL Codex usage schema: '+e.message);process.exitCode=1; }
  finally {rmSync(folder,{recursive:true,force:true});}
}
