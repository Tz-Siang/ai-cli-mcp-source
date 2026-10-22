// Claude Code statusLine：顯示整台機器上 ai-cli 背景 job 的狀態（不經 MCP，直接讀 job store）。
// 資料來源與 src/core/live-jobs.ts 的 jobStateDir() 相同：
//   $AI_CLI_STATE_DIR 或 ~/.local/state/ai-cli，每個 job 一個 jobs/<jobId>/ 目錄。
//   meta.json = 派工資訊；exit.json = 已結束（exitCode）；lost.json = server GC 判定行程已消失。
// ai-cli 對結束的 job 保留 30 分鐘才刪目錄，所以「最近完成」不需要自己記狀態。
//
// 與 plugins/ai-cli-jobs 面板的分工：面板只列本 session 主對話派的 job，完成後 120 秒消失；
// 這支列全機所有 session（含子代理、其他專案），完成後留 10 分鐘。
//
// 啟用：在 ~/.claude/settings.json 加（路徑換成本檔的絕對路徑，Windows 用正斜線）
//   "statusLine": { "type": "command", "command": "node \"/abs/path/ai-cli-status.mjs\"", "padding": 0, "refreshInterval": 5 }
// refreshInterval 讓 Claude Code 閒置時也每 5 秒重跑，job 跑完不必等下一次對話才更新。
// 已經有 statusLine 的話，這會取代它；要並存就自己寫一支包裝腳本串接兩者的輸出。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const RECENT_MS = 10 * 60 * 1000   // 完成後在狀態列留多久
const QUIET_MS = 5 * 60 * 1000     // 執行中但 stdout 這麼久沒動就標「靜默」
const MAX_RUNNING_SHOWN = 3
const MAX_DONE_SHOWN = 2
const C = { dim: '\x1b[2m', run: '\x1b[36m', ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', off: '\x1b[0m' }
// ? = server 判定行程消失卻沒留下結束狀態（lost.json），不能當成功也不能當失敗。
const GLYPH = { ok: `${C.ok}✓`, bad: `${C.bad}✗`, lost: `${C.warn}?` }

const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
const mtime = path => { try { return statSync(path).mtimeMs } catch { return undefined } }
const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const ago = ms => { const m = Math.floor(ms / 60000); return m < 1 ? '剛剛' : `${m} 分前` }
const norm = p => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

let input = {}
try { if (!process.stdin.isTTY) input = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch {}
const here = norm(input.workspace?.project_dir || input.workspace?.current_dir || input.cwd || process.cwd())

const root = join(process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli'), 'jobs')
let names = []
try { names = readdirSync(root) } catch {}

const now = Date.now()
const running = [], done = []
for (const name of names) {
  const dir = join(root, name)
  const meta = json(join(dir, 'meta.json'))
  if (!meta) continue
  const model = meta.resolvedModel || meta.model || meta.agent || '?'
  const label = `${model}${meta.effort ? `(${meta.effort})` : ''}`
  const project = norm(meta.projectDir || meta.workFolder)
  const tag = project && here && project !== here && !here.startsWith(project + '/') ? ` ${C.dim}[${basename(meta.projectDir || meta.workFolder).slice(0, 12)}]${C.off}` : ''
  const exit = json(join(dir, 'exit.json'))
  const lost = exit ? undefined : json(join(dir, 'lost.json'))
  if (!exit && !lost) {
    const start = Date.parse(meta.startTime) || now
    const last = mtime(join(dir, 'stdout.log'))
    const quiet = last !== undefined && now - last > QUIET_MS ? ` ${C.warn}靜默${Math.floor((now - last) / 60000)}m${C.off}` : ''
    running.push({ start, text: `${label} ${clock(now - start)}${quiet}${tag}` })
    continue
  }
  const end = Date.parse((exit || lost).endTime) || mtime(join(dir, exit ? 'exit.json' : 'lost.json')) || 0
  if (now - end > RECENT_MS) continue
  const kind = lost ? 'lost' : exit.exitCode === 0 && !exit.killed && !exit.timedOut ? 'ok' : 'bad'
  done.push({ end, kind, text: `${GLYPH[kind]}${C.off} ${label} ${C.dim}${ago(now - end)}${C.off}${tag}` })
}

running.sort((a, b) => a.start - b.start)
done.sort((a, b) => b.end - a.end)
const parts = []
if (running.length) {
  const shown = running.slice(0, MAX_RUNNING_SHOWN).map(j => j.text)
  if (running.length > MAX_RUNNING_SHOWN) shown.push(`+${running.length - MAX_RUNNING_SHOWN}`)
  parts.push(`${C.run}⏳ ${running.length} 執行中${C.off}：${shown.join(' · ')}`)
}
if (done.length) {
  const shown = done.slice(0, MAX_DONE_SHOWN).map(j => j.text)
  if (done.length > MAX_DONE_SHOWN) shown.push(`+${done.length - MAX_DONE_SHOWN}`)
  // 計數放標頭：詳列只取最近兩筆，失敗不能因此被收進「+N」裡看不到。
  const counts = ['ok', 'bad', 'lost'].map(k => [k, done.filter(j => j.kind === k).length]).filter(([, n]) => n)
  parts.push(`近 10 分 ${counts.map(([k, n]) => `${GLYPH[k]}${n}${C.off}`).join(' ')}：${shown.join(' · ')}`)
}
process.stdout.write(parts.length ? `ai-cli ▸ ${parts.join('  ｜ ')}` : `${C.dim}ai-cli ▸ 閒置${C.off}`)
