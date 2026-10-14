/** Codex 額度 RPC、fallback 與回顯握手回歸；不用真 vendor、不呼叫模型。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const rpc = await import('../dist/plugins/codex-app-server.js').catch(() => ({}));
const us = await import('../dist/plugins/usage-service.js');
let failures = 0, passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch(e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } }
const fixture = { rateLimits: { limitId:'codex', primary:{ usedPercent:0, windowDurationMins:10080, resetsAt:1792578971 }, secondary:null, credits:{hasCredits:false,unlimited:false,balance:'0'}, spendControlReached:false, planType:'prolite', rateLimitReachedType:null }, rateLimitResetCredits:{availableCount:0,credits:[]}, accountId:'redacted' };
const variant = structuredClone(fixture); variant.rateLimits.primary.usedPercent = 23.5;
variant.rateLimits.secondary = {usedPercent:42,windowDurationMins:300,resetsAt:1792578000};
function fakeSpawn(responder) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough(); child.pid = 2147483647; child.exitCode = null; child.signalCode = null;
  const requests = [], kills = [];
  child.stdin.on('data', data => { const msg=JSON.parse(data.toString()); requests.push(msg); queueMicrotask(()=>responder(msg,child)); });
  return {child,requests,kills,spawnFn:(file,args,opts)=>{assert.equal(opts.shell,false); assert.equal(opts.windowsHide,true); return child;}, killTree:async(pid)=>kills.push(pid)};
}
const reply=(child,msg)=>child.stdout.write(JSON.stringify(msg)+'\n');
await test('RPC used and remaining semantics',()=>{
  const r=rpc.mapCodexRateLimits(variant,'0.162.1',0);
  assert.equal(r.type,'rate_limits'); assert.equal(r.weekly.percentUsed,23.5); assert.equal(r.weekly.percentRemaining,76.5);
  assert.equal(r.weekly.basis,'used'); assert.equal(r.fiveHour.percentUsed,42); assert.equal(r.fiveHour.percentRemaining,58);
  assert.equal(r.weekly.resetAtIso,new Date(1792578971000).toISOString()); assert.match(r.raw,/23.5% used \(76.5% left\)/);
  assert.equal(r.source,'app-server'); assert.equal(r.cliVersion,'0.162.1'); assert.equal(r.plan,'prolite');
  assert.equal(r.resetCreditsAvailable,0); assert.equal(r.rateLimitReachedType,null);
  const noSecond=rpc.mapCodexRateLimits(fixture,'0.162.1',0); assert.equal(noSecond.fiveHour,null); assert.equal(noSecond.weekly.percentRemaining,100);
  const reversed=structuredClone(variant); [reversed.rateLimits.primary,reversed.rateLimits.secondary]=[reversed.rateLimits.secondary,reversed.rateLimits.primary];
  assert.equal(rpc.mapCodexRateLimits(reversed).weekly.percentUsed,23.5);
});
await test('RPC rejects unavailable or malformed quota',()=>{
  assert.equal(typeof rpc.mapCodexRateLimits,'function');
  for(const value of [null,{}, {rateLimits:null}, {rateLimits:{primary:{usedPercent:1,windowDurationMins:60}}}, {rateLimits:{primary:{usedPercent:NaN,windowDurationMins:300}}}]) assert.throws(()=>rpc.mapCodexRateLimits(value));
});
await test('RPC initialize notification and split JSON frames',async()=>{
  const fake=fakeSpawn((msg,c)=>{
    if(msg.method==='initialize') { reply(c,{method:'remoteControl/status/changed',params:{}}); reply(c,{id:1,result:{userAgent:'ai-cli/0.162.1 (Windows 11)'}}); }
    if(msg.method==='account/rateLimits/read') {
      reply(c,{method:'account/updated',params:{}}); const text=JSON.stringify({id:2,result:fixture})+'\n';
      c.stdout.write(text.slice(0,17)); c.stdout.write(text.slice(17));
    }
  });
  const r=await rpc.readCodexAppServerUsage('codex',{...fake,timeoutMs:200});
  assert.equal(r.cliVersion,'0.162.1'); assert.equal(r.weekly.percentUsed,0);
  assert.deepEqual(fake.requests.map(r=>r.method),['initialize','initialized','account/rateLimits/read']);
  assert.equal(fake.requests[2].params,null); assert.deepEqual(fake.kills,[fake.child.pid]);
});
await test('RPC errors non JSON EOF and timeout clean owned tree',async()=>{
  for(const kind of ['method','login','json','exit','timeout','oversize','stdin']) {
    const fake=fakeSpawn((msg,c)=>{
      if(kind==='timeout') return;
      if(kind==='json') {c.stdout.write('not JSON\n');return;}
      if(kind==='oversize') {c.stdout.write('x'.repeat(1024*1024+1));return;}
      if(kind==='exit') {c.emit('close',1);return;}
      if(kind==='stdin') {c.stdin.emit('error',new Error('EPIPE'));return;}
      reply(c,{id:msg.id,error:{code:kind==='method'?-32601:-32000,message:kind==='method'?'method not found':'not logged in'}});
    });
    await assert.rejects(rpc.readCodexAppServerUsage('codex',{...fake,timeoutMs:25})); assert.deepEqual(fake.kills,[fake.child.pid]);
  }
});
await test('Windows cmd shim uses node argv with spaces',()=>{
  const text='@echo off\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*';
  const r=rpc.resolveCodexCommand('C:\\Program Files\\Codex\\codex.CMD',['app-server'],{platform:'win32',readFile:()=>text,exists:()=>true});
  assert.equal(r.file,'C:\\Program Files\\Codex\\node.exe'); assert.deepEqual(r.args,['C:\\Program Files\\Codex\\node_modules\\@openai\\codex\\bin\\codex.js','app-server']);
  const fallback=rpc.resolveCodexCommand('C:\\a & b\\codex.cmd',['--version'],{platform:'win32',readFile:()=>text,exists:p=>!p.endsWith('node.exe')}); assert.equal(fallback.file,process.execPath); assert.equal(fallback.args[1],'--version');
  assert.throws(()=>rpc.resolveCodexCommand('x.cmd',[],{platform:'win32',readFile:()=> 'echo unsupported',exists:()=>true}),/shim/);
  assert.deepEqual(rpc.resolveCodexCommand('/tmp/codex',['app-server'],{platform:'linux'}),{file:'/tmp/codex',args:['app-server']});
});
class FakeProvider extends us.CodexUsageProvider {
  constructor({app,session,tui,version='0.162.1'}) {
    const calls=[]; super('not-real',()=>{throw Error('unexpected PTY');},{appServerRead:async()=>{calls.push('app'); if(app instanceof Error)throw app; return app;},sessionRead:()=>{calls.push('session');return session;},versionRead:async()=>version});
    this.calls=calls; this.panel=tui;
  }
  async _run(){this.calls.push('tui'); if(this.panel instanceof Error)throw this.panel;return {output:this.panel||'',timedOut:false};}
}
await test('RPC first for both fresh settings',async()=>{
  for(const fresh of [false,true]) {const p=new FakeProvider({app:{type:'rate_limits',source:'app-server'}}); assert.equal((await p.query({fresh})).source,'app-server');assert.deepEqual(p.calls,['app']);}
});
await test('RPC fallback order and reasons',async()=>{
  const p=new FakeProvider({app:Error('method not found'),session:{type:'rate_limits',source:'session-file'}});
  const r=await p.query();assert.equal(r.source,'session-file');assert.deepEqual(p.calls,['app','session']);assert.match(r.fallbackReasons[0],/app-server.*method not found/);
  const fresh=new FakeProvider({app:Error('not logged in'),session:{type:'rate_limits'},tui:'Weekly limit: 80% left'});
  const t=await fresh.query({fresh:true});assert.equal(t.source,'tui');assert.deepEqual(fresh.calls,['app','tui']);assert.match(t.fallbackReasons.join(' '),/not logged in/);
  const missing=new FakeProvider({app:Error('bad JSON'),session:null,tui:'Weekly limit: 70% left'});
  const m=await missing.query();assert.deepEqual(missing.calls,['app','session','tui']); assert.equal(m.fallbackReasons.length,2);
});
await test('RPC failure must never return ok without quota',async()=>{
  for(const tui of ['Ask Codex to do anything','90% context left',Error('PTY failure')]) {
    const p=new FakeProvider({app:Error('timeout'),session:null,tui});const svc=new us.UsageService();svc.providers.set('codex',p);
    const r=await svc.queryProvider('codex',{refresh:true});assert.equal(r.status,'error');assert.match(r.usage.fallbackReasons.join(' '),/app-server.*timeout/);
  }
});
await test('TUI version warning only on untested fallback',async()=>{
  for(const version of ['0.162.1','0.163.0',null]) {
    const p=new FakeProvider({app:Error('unsupported'),tui:'Weekly limit: 100% left',version});const r=await p.query({fresh:true});
    assert.equal(r.cliVersion,version);assert.equal(!!r.warnings?.length,version!=='0.162.1');
  }
});
await test('TUI waits for rendered status echo',()=>{
  const dir=join(ROOT,'tests','fixtures','codex-0.162.1');const before=readFileSync(join(dir,'before.ansi'),'utf8'),echo=readFileSync(join(dir,'echo.ansi'),'utf8'),panel=readFileSync(join(dir,'panel.ansi'),'utf8');
  assert.deepEqual(us.codexStatusWrites(us.renderTerminal(before)),['/status']);
  assert.deepEqual(us.codexStatusWrites(us.renderTerminal(before+echo)),['\r']);
  assert.equal(us.parseCodexUsage(before+echo+panel).type,'rate_limits');
  assert.deepEqual(us.codexStatusWrites('› /status\n/status Show quota\nfooter'),['\r']);
});
await test('TUI handshake retries once and clears pending input',()=>{
  const s=us.createCodexStatusHandshake();const ready='Ask Codex to do anything\n›\n? for shortcuts';
  assert.deepEqual(s.next(ready,2000,2000),['/status']);assert.deepEqual(s.next(ready,9000,2000),[]);
  assert.deepEqual(s.next(ready,12500,2000),['\x15/status']);assert.deepEqual(s.next(ready,24000,2000),[]);
  assert.deepEqual(s.next('› /status\n/status Show quota\nfooter',25000,1000),['\r']);
  assert.deepEqual(s.next('› /status\nfooter',25001,1000),[]);
  assert.deepEqual(s.next('› /status\nfooter',28000,1000),['\r']);
});
await test('TUI provider waits echo and closes owned PTY once',async()=>{
  const cp=createRequire(import.meta.url)('node:child_process'),original=cp.spawn;
  cp.spawn=(file,args)=>{assert.equal(file,'taskkill');assert.deepEqual(args,['/PID','2147483647','/T','/F']);const e=new EventEmitter();queueMicrotask(()=>e.emit('close',0));return e;};syncBuiltinESMExports();
  let deliver,kills=0,echoed=false;const writes=[];
  const folder=join(ROOT,'tests','fixtures','codex-0.162.1');
  const before=readFileSync(join(folder,'before.ansi'),'utf8'),echo=readFileSync(join(folder,'echo.ansi'),'utf8'),panel=readFileSync(join(folder,'panel.ansi'),'utf8');
  const pty={spawn(file,args,opts){assert.equal(opts.cols,200);assert.equal(opts.rows,50);
    return {pid:2147483647,onExit(){},onData(fn){deliver=fn;fn(before);},kill(){kills++;},write(keys){writes.push(keys);
      if(keys==='/status')setTimeout(()=>{assert(!writes.includes('\r'),'Enter before echo');echoed=true;deliver(echo);},700);
      else if(keys==='\r'){assert(echoed,'Enter before echo');deliver(panel);}
    }};
  }};
  try {
    const p=new us.CodexUsageProvider('fake',()=>pty,{appServerRead:async()=>{throw Error('RPC failed');},versionRead:async()=> '0.162.1'});
    const r=await p.query({fresh:true});assert.equal(r.type,'rate_limits');assert.deepEqual(writes,['/status','\r']);
    await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(kills,1,'PTY kill must not be reentered');
  } finally {cp.spawn=original;syncBuiltinESMExports();}
});
console.log(`codex-app-server: ${passed} passed, ${failures} failed`);process.exitCode=failures?1:0;
