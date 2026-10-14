/** Windows 真機驗收：獨立 RPC 原值 vs UsageService，並注入 RPC 失敗驗 TUI。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { UsageService, CodexUsageProvider } from '../../dist/plugins/usage-service.js';
import { resolveCodexCommand, stopCodexProcess } from '../../dist/plugins/codex-app-server.js';
const cli = process.argv[2] || 'codex';
const started = Date.now();
const cmd = resolveCodexCommand(cli, ['app-server']);
const child = spawn(cmd.file, cmd.args, { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'], detached: process.platform !== 'win32' });
let direct;
try {
  direct = await new Promise((resolve,reject) => {
    let buffer=''; const timer=setTimeout(()=>reject(Error('direct RPC timeout')),20000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);reject(Error('direct RPC early exit '+code));});
    const send=msg=>child.stdin.write(JSON.stringify(msg)+'\n');child.stderr.resume();child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;let end;
      while((end=buffer.indexOf('\n'))!==-1) {
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
        let r;try {r=JSON.parse(line);}catch(e){clearTimeout(timer);reject(e);return;}
        if(r.error){clearTimeout(timer);reject(Error(r.error.message));return;}
        if(r.id===1) {send({method:'initialized'});send({id:2,method:'account/rateLimits/read',params:null});}
        if(r.id===2){clearTimeout(timer);resolve(r.result);}
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'ai-cli-usage-acceptance',version:'1.0.0'}}});
  });
} finally {await stopCodexProcess(child);}
const summarize = r => ({status:r.status,transport:r.transport,source:r.usage?.source,cliVersion:r.usage?.cliVersion,weekly:r.usage?.weekly,fiveHour:r.usage?.fiveHour,plan:r.usage?.plan,asOf:r.usage?.asOf,resetCreditsAvailable:r.usage?.resetCreditsAvailable,rateLimitReachedType:r.usage?.rateLimitReachedType, fallbackReasons:r.usage?.fallbackReasons,warnings:r.usage?.warnings});
const report={capturedAt:new Date().toISOString(),direct:{primary:direct.rateLimits.primary,secondary:direct.rateLimits.secondary},results:[]};
for(const fresh of [true,false]) {
  const svc=new UsageService({codex:cli});const result=await svc.queryProvider('codex',{refresh:fresh});
  assert.equal(result.status,'ok');assert.equal(result.usage.source,'app-server');assert.equal(result.transport,'stdio');
  for(const w of [direct.rateLimits.primary,direct.rateLimits.secondary].filter(Boolean)) {
    const mapped=w.windowDurationMins===10080?result.usage.weekly:result.usage.fiveHour;
    assert.equal(mapped.percentUsed,w.usedPercent);assert.equal(mapped.percentRemaining,Math.round((100-w.usedPercent)*100)/100);
  }
  report.results.push({fresh,...summarize(result)});console.log(JSON.stringify(report.results.at(-1)));
}
const svc=new UsageService();svc.providers.set('codex',new CodexUsageProvider(cli,undefined,{appServerRead:async()=>{throw Error('acceptance injected app-server failure');}}));
const fallback=await svc.queryProvider('codex',{refresh:true});
assert.equal(fallback.status,'ok');assert.equal(fallback.usage.source,'tui');assert.equal(fallback.usage.cliVersion,'0.162.1');
assert.match(fallback.usage.fallbackReasons.join(' '),/acceptance injected/);assert.equal(fallback.usage.weekly.percentUsed,report.results[0].weekly.percentUsed);
report.fallback=summarize(fallback);report.elapsedMs=Date.now()-started;console.log(JSON.stringify(report.fallback));
if(process.env.AI_CLI_USAGE_ACCEPTANCE_REPORT)writeFileSync(process.env.AI_CLI_USAGE_ACCEPTANCE_REPORT,JSON.stringify(report,null,2)+'\n');
console.log('PASS Codex live RPC fresh=true/false matches direct RPC; injected RPC failure falls back to TUI');
