import type { AiCliJobsJob } from '../types/index'
import { test, expect, mock } from 'claude-code/testing'
import { taskLabel, runPid, elapsed, eventLabel, failureText, inferAgent, POLL_MS, CALL_TIMEOUT_MS, ADOPTED_TASK, DISCOVER_EARLY_MS } from '../hooks/register'

const tree = (text: string) => ({ type: 'Text' as const, props: {}, children: [text] })
const ref = { plugin: 'ai-cli-jobs', key: 'jobs' } as const
const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

test('polls every POLL_MS and advances the spinner each tick', async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 500 } }))
  on('mcp.call', () => {
    calls++
    return { value: { isError: false, content: [], structuredContent: [{ pid: 500, status: 'running' }] } }
  })
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'poll-interval', prompt: 'task' })
  await clock.advance(POLL_MS - 1)
  expect(calls).toBe(0)
  await clock.advance(1)
  expect(calls).toBe(1)
  const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('⠙')
  await ui.unmount()
  await clock.advance(POLL_MS - 1)
  expect(calls).toBe(1)
  await clock.advance(1)
  expect(calls).toBe(2)
  const nextUi = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect((await nextUi.find({ type: 'Text' }))?.text).toContain('⠹')
  await nextUi.unmount()
})

test('band and status rows use Morandi backgrounds and bold dark text on both surfaces', async ($, on) => {
  const clock = mock.clock(on)
  let pid = 300
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: pid++ } }))
  on('mcp.call', () => ({ value: { isError: false, content: [], structuredContent: [
    { pid: 300, status: 'running', elapsedSec: 4 },
    { pid: 301, status: 'completed', elapsedSec: 4 },
    { pid: 302, status: 'failed', elapsedSec: 4 },
    { pid: 303, status: 'killed', elapsedSec: 4 },
    // pid 304 disappears and becomes untracked.
  ] } }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => tree(e.props.tail || ''))
  for (let n = 0; n < 5; n++) await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'color-' + n, model: 'haiku', prompt: 'task' })
  await clock.advance(POLL_MS)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: band })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.map(b => b.props.backgroundColor)).toEqual(['#E8DCB5', '#A8D5CE', '#DDE6A3', '#F4BE86', '#F4BE86', '#F4BE86'])
    expect(boxes[0]?.props.paddingX).toBe(1)
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.length).toBe(5)
    expect(texts.every(t => t.props.color === '#1A1A1A')).toBe(true)
    expect(texts.every(t => t.props.bold === true)).toBe(true)
    expect(texts[3]?.text).toContain('killed')
    expect(texts[4]?.text).toContain('已不追蹤')
    await ui.unmount()
    // The tail stays plain text with no background or foreground styles.
    expect(await $.ui.render({ surface, component: 'PromptHint', requestId: 'color-hint', props: { isDraft: false, isWorking: false, hint: 'base' } })).toEqual(tree('ai-cli ▸ 1 執行中 · 1 完成 · 2 失敗 · 1 已不追蹤'))
  }
})

test('extracts task labels and pid from MCP results', async () => {
  expect(taskLabel({ prompt: '【身分】worker\n不要呼叫任何派工工具\n本節權威優先\n\n# 任務：修驗收工具判定 bug\n詳細說明' })).toBe('修驗收工具判定 bug')
  expect(taskLabel({ prompt_file: 'C:\\tasks\\review.md' })).toBe('review.md')
  expect(taskLabel({ prompt: '長'.repeat(55) }).length).toBe(40)
  expect(runPid({ content: [{ type: 'text', text: '{"pid":123}' }] })).toBe(123)
  expect(runPid({ structuredContent: { pid: 456 } })).toBe(456)
  expect(runPid('pid: 789')).toBe(789)
  expect(runPid({ pid: -1 })).toBeUndefined()
  expect(elapsed(62)).toBe('1:02')
  expect(eventLabel('item.completed file_change')).toBe('file_change')
})

test('infers initial agent from model without an agent argument', async ($, on) => {
  mock.clock(on)
  let held: AiCliJobsJob[] = []
  let pid = 100
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: pid++ } }))
  const cases = [
    ['gpt-6.1-sol', 'codex'], ['codex-mini', 'codex'],
    ['gemini-pro', 'antigravity'], ['agy', 'antigravity'], ['agy-pro', 'antigravity'],
    ['grok-4.7', 'grok'], ['grok-4.7-build-fast', 'grok'],
    ['nv-model', 'direct-api'], ['or-model', 'direct-api'], ['ds-model', 'direct-api'],
    ['custom-model', 'direct-api'], ['provider/model', 'direct-api'],
    ['fable', 'claude'], ['sonnet', 'claude'], ['opus', 'claude'], ['haiku', 'claude'],
    ['claude-ultra', 'claude'], ['claude-sonnet-4', 'claude'], ['unknown', 'claude'], ['', 'claude'],
  ] as const
  for (const [model, agent] of cases) {
    expect(inferAgent(model)).toBe(agent)
    await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'model-' + pid, model, prompt: 'task' })
    expect(held[held.length - 1]?.agent).toBe(agent)
  }
  // Both surfaces show the correct agent before the first poll.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: band })
    expect(await ui.find({ type: 'Text', text: /claude  haiku/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /antigravity  gemini-pro/ })).toBeDefined()
    await ui.unmount()
  }
})

test('unknown terminal statuses and invalid pids do not block other poll updates', async ($, on) => {
  const clock = mock.clock(on)
  let held: AiCliJobsJob[] = []
  let pid = 200
  let calls = 0
  let done = false
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: pid++ } }))
  on('mcp.call', () => {
    calls++
    return { value: { isError: false, content: [], structuredContent: [
      { pid: 'invalid', status: 'running' }, null,
      { pid: 200, agent: 'poll-authority', status: done ? 'completed' : 'running', elapsedSec: 9, lastEvent: 'item.completed file_change' },
      { pid: 201, status: 'completed', elapsedSec: 4 },
      { pid: 202, status: 'failed', elapsedSec: 4, lastEvent: 'error' },
      { pid: 203, status: 'killed', elapsedSec: 4, lastEvent: 'signal SIGTERM' },
      { pid: 204, status: 'cancelled', elapsedSec: 4 },
    ] } }
  })
  for (let n = 0; n < 5; n++) await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'status-' + n, model: 'haiku', prompt: 'task' })
  await clock.advance(POLL_MS)
  expect(held.map(j => j.status)).toEqual(['running', 'completed', 'failed', 'failed', 'failed'])
  expect(held[0]?.agent).toBe('poll-authority')
  expect(held[0]?.lastEvent).toBe('item.completed file_change')
  expect(held[3]?.lastEvent).toBe('killed signal SIGTERM')
  expect(held[4]?.lastEvent).toBe('cancelled')
  expect(held.slice(1).every(j => j.finishedAt === POLL_MS)).toBe(true)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: band })
    expect((await ui.find({ type: 'Text', text: /killed/ }))?.text).toContain('✗')
    expect((await ui.find({ type: 'Text', text: /cancelled/ }))?.text).toContain('✗')
    expect(await ui.find({ type: 'Text', text: /✓/ })).toBeDefined()
    await ui.unmount()
  }
  done = true
  await clock.advance(POLL_MS)
  expect(held[0]?.status).toBe('completed')
  await clock.advance(120000)
  expect(held).toEqual([])
  expect(calls).toBe(2)
})

test('records dispatch, polls, renders on both surfaces, expires and stops polling', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let calls = 0
  let completed = false
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { content: [{ type: 'text', text: '{"pid":123}' }] }, text: 'unchanged', ref: 7 }))
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('ai-cli')
    expect(e.tool).toBe('list_processes')
    calls++
    return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ processes: [{ pid: 123, agent: 'codex', status: completed ? 'completed' : 'running', elapsedSec: 62, sinceLastOutputSec: 1, lastEvent: 'item.completed file_change' }] }) }] } }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => tree('BASE'))
  on('ui.render', { component: 'PromptHint' }, ($, e) => tree(e.props.tail || 'BASE'))
  const result = await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'run-1', agent: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'high', prompt: '【身分】worker\n\n# 任務：修驗收工具判定 bug' })
  expect(result).toEqual({ result: { content: [{ type: 'text', text: '{"pid":123}' }] }, text: 'unchanged', ref: 7 })
  expect(held).toEqual([expect.objectContaining({ pid: 123, model: 'gpt-6.1-sol', reasoningEffort: 'high', startedAt: 0, task: '修驗收工具判定 bug', status: 'running' })])
  await clock.advance(POLL_MS)
  expect(calls).toBe(1)
  expect(held?.[0]?.lastEvent).toBe('item.completed file_change')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: band })
    expect((await ui.find({ type: 'Text', text: /修驗收工具/ }))?.text).toContain('1:02  file_change')
    await ui.unmount()
    const survey = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: { ...band, hasSurvey: true } })
    expect(await survey.find({ type: 'Text', text: /修驗收工具/ })).toBeUndefined()
    await survey.unmount()
  }
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'running-hint', props: { isDraft: false, isWorking: false, hint: 'base' } })).toEqual(tree('ai-cli ▸ 1 執行中'))
  completed = true
  await clock.advance(POLL_MS)
  expect(held?.[0]?.status).toBe('completed')
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'hint', props: { isDraft: false, isWorking: false, hint: 'base', tail: 'existing' } })).toEqual(tree('existing · ai-cli ▸ 1 完成'))
  await clock.advance(119999)
  expect(held?.length).toBe(1)
  await clock.advance(1)
  expect(held).toEqual([])
  expect(calls).toBe(2)
})

test('empty jobs pass both UI sites through', async ($, on) => {
  mock.clock(on)
  on('ui.render', () => tree('BASE'))
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await $.ui.render({ surface, component: 'AbovePrompt', requestId: 'empty', props: band })).toEqual(tree('BASE'))
    expect(await $.ui.render({ surface, component: 'PromptHint', requestId: 'empty-hint', props: { isDraft: false, isWorking: false, hint: 'base' } })).toEqual(tree('BASE'))
  }
})

test('mixed summary, failed/untracked retention, reconnect errors, and restart', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let pid = 10
  let mode = 'error'
  let calls = 0
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: pid++ } }))
  on('mcp.call', () => {
    calls++
    if (mode === 'error') return { value: { isError: true, content: [] } }
    return { value: { isError: false, content: [], structuredContent: mode === 'malformed' ? {} : [{ pid: 10, agent: 'codex', status: mode === 'done' ? 'completed' : 'running', elapsedSec: 8, lastEvent: '' }, { pid: 11, agent: 'codex', status: 'failed', elapsedSec: 4, lastEvent: 'error' }] } }
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => tree(e.props.tail || ''))
  for (let n = 0; n < 3; n++) await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'r' + n, prompt_file: '/tasks/job.md' })
  await clock.advance(POLL_MS)
  expect(held?.every(j => j.status === 'running')).toBe(true)
  mode = 'malformed'; await clock.advance(POLL_MS)
  expect(held?.length).toBe(3)
  mode = 'ok'; await clock.advance(POLL_MS)
  expect(held?.map(j => j.status)).toEqual(['running', 'failed', 'untracked'])
  mode = 'done'; await clock.advance(POLL_MS)
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'mixed', props: { isDraft: false, isWorking: false, hint: '' } })).toEqual(tree('ai-cli ▸ 1 完成 · 1 失敗 · 1 已不追蹤'))
  await clock.advance(120000)
  expect(held).toEqual([])
  const previous = calls
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'restart', prompt: 'new job' })
  await clock.advance(POLL_MS)
  expect(calls).toBe(previous + 1)
})

test('a poll that never answers times out, shows why, and the next poll finishes the job', async ($, on) => {
  let held: AiCliJobsJob[] = []
  const seen: string[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; seen.push(...held.map(j => j.lastEvent)); return next(e) })
  const clock = mock.clock(on)
  let calls = 0
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 700 } }))
  on('mcp.call', () => {
    calls++
    if (calls === 1) return new Promise<never>(() => {})
    return { value: { isError: false, content: [], structuredContent: [{ pid: 700, agent: 'grok', status: 'completed', elapsedSec: 84 }] } }
  })
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'hang', model: 'grok-4.7', prompt: 'task' })
  expect(held[0]?.agent).toBe('grok')
  await clock.advance(POLL_MS)
  await clock.advance(CALL_TIMEOUT_MS - 1)
  // The unanswered call holds later ticks back, but only until it times out.
  expect(calls).toBe(1)
  expect(held[0]?.status).toBe('running')
  await clock.advance(1 + POLL_MS)
  expect(seen).toContain(`輪詢失敗：逾時 ${CALL_TIMEOUT_MS / 1000}s`)
  expect(held[0]).toEqual(expect.objectContaining({ status: 'completed', agent: 'grok', elapsedSec: 84 }))
  expect(calls).toBe(2)
})

test('an isError poll result is shown on the running row', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 800 } }))
  on('mcp.call', () => ({ value: { isError: true, content: [{ type: 'text', text: 'server not connected' }] } }))
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'err', model: 'haiku', prompt: 'task' })
  await clock.advance(POLL_MS)
  expect(held[0]).toEqual(expect.objectContaining({ status: 'running', lastEvent: '輪詢失敗：server not connected' }))
})

test('engine refusals and missing servers turn into the fix, shown in full on the row', async ($, on) => {
  expect(failureText('ai-cli-jobs: $.mcp.call(ai-cli, list_processes) refused: Auto mode classifier unavailable'))
    .toBe('輪詢被拒：把 mcp__ai-cli__list_processes 加進 permissions.allow（原因：Auto mode classifier unavailable）')
  expect(failureText('ai-cli-jobs: $.mcp.call(ai-cli, list_processes) refused: Permission denied by a deny rule'))
    .toContain('（原因：Permission denied by a deny rule）')
  expect(failureText('ai-cli-jobs: $.mcp.call: no connected MCP tool "list_processes" on a server named "ai-cli"'))
    .toBe('輪詢失敗：找不到 mcp__ai-cli__list_processes：ai-cli 未連線（用 /mcp 重連，server 名稱須為 ai-cli），或被 permissions.deny 擋下')
  expect(failureText('server not connected')).toBe('輪詢失敗：server not connected')
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 900 } }))
  // The harness cannot raise the engine's own refusal: a deny from a test hook comes back as "$.mcp.call: <deny>",
  // while Claude Code 2.1.296 throws "<plugin>: $.mcp.call(<server>, <tool>) refused: <deny>" (read from the binary).
  // Feed that exact text through the isError path, which reaches the same failureText as a thrown error.
  on('mcp.call', () => ({ value: { isError: true, content: [{ type: 'text', text: 'ai-cli-jobs: $.mcp.call(ai-cli, list_processes) refused: Auto mode classifier unavailable' }] } }))
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'refused', model: 'haiku', prompt: 'task' })
  await clock.advance(POLL_MS)
  expect(held[0]).toEqual(expect.objectContaining({ status: 'running', lastEvent: '輪詢被拒：把 mcp__ai-cli__list_processes 加進 permissions.allow（原因：Auto mode classifier unavailable）' }))
  const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('把 mcp__ai-cli__list_processes 加進 permissions.allow（原因：Auto mode classifier unavailable）')
  await ui.unmount()
})

test('jobs the server adopted from an ended session show up once, with their model', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let adoptedStatus = 'running'
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 1100 } }))
  on('mcp.call', () => ({ value: { isError: false, content: [], structuredContent: [
    { pid: 1100, agent: 'claude', status: 'running', elapsedSec: 1 },
    { pid: 1200, jobId: 'job-1200', agent: 'codex', model: 'gpt-6.1-sol', status: adoptedStatus, elapsedSec: 300, lastEvent: 'item.completed file_change', adopted: true },
    { pid: 1300, jobId: 'job-1300', agent: 'claude', status: 'running', elapsedSec: 5, recovered: true },
  ] } }))
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'own', model: 'haiku', prompt: 'own task' })
  await clock.advance(POLL_MS)
  expect(held.map(j => j.pid)).toEqual([1100, 1200])
  expect(held[1]).toEqual(expect.objectContaining({ agent: 'codex', model: 'gpt-6.1-sol', task: ADOPTED_TASK, status: 'running', elapsedSec: 300, lastEvent: 'item.completed file_change' }))
  const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect((await ui.find({ type: 'Text', text: /接管自前一個 session/ }))?.text).toContain('5:00')
  await ui.unmount()
  await clock.advance(POLL_MS)
  expect(held.filter(j => j.pid === 1200)).toHaveLength(1)
  adoptedStatus = 'completed'
  await clock.advance(POLL_MS)
  expect(held[1]?.status).toBe('completed')
  // Pruned after retention, and not brought back although the server still lists it.
  await clock.advance(120_000)
  expect(held.map(j => j.pid)).toEqual([1100])
})

test('an adoption that lands after the first look shows up within seconds, not a minute later', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let adopted = false
  on('mcp.call', () => ({ value: { isError: false, content: [], structuredContent: adopted
    ? [{ pid: 1700, jobId: 'job-1700', agent: 'codex', model: 'gpt-6.1-sol', status: 'running', elapsedSec: 400, adopted: true }]
    : [] } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(DISCOVER_EARLY_MS[0])
  expect(held).toEqual([])
  // On Windows the server finished adopting 7–11 s after the session started; the row is up by 15 s.
  await clock.advance(11_000 - DISCOVER_EARLY_MS[0])
  adopted = true
  await clock.advance(4_000)
  expect(held.map(j => j.pid)).toEqual([1700])
  expect(held[0]?.task).toBe(ADOPTED_TASK)
})

test('adopted rows need a jobId, and one already held is never brought back after it is pruned', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let ownStatus = 'running'
  on('tool.call', { tool: 'mcp__ai-cli__run' }, ($, e) => ({ result: { pid: (e as { tool_use_id: string }).tool_use_id === 'keep' ? 1400 : 1500 } }))
  on('mcp.call', () => ({ value: { isError: false, content: [], structuredContent: [
    { pid: 1400, jobId: 'job-1400', agent: 'claude', status: 'running', elapsedSec: 1 },
    // Dispatched here, then adopted back by this session's new principal (a resumed session keeps its rows).
    { pid: 1500, jobId: 'job-1500', agent: 'codex', status: ownStatus, elapsedSec: 2, adopted: true },
    { pid: 1600, agent: 'codex', status: 'running', elapsedSec: 3, adopted: true },
  ] } }))
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'keep', model: 'haiku', prompt: 'keeps polling alive' })
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'own', model: 'gpt-6.1-sol', prompt: 'own job' })
  await clock.advance(POLL_MS)
  expect(held.map(j => j.pid)).toEqual([1400, 1500])
  expect(held[1]?.task).toBe('own job')
  ownStatus = 'completed'
  await clock.advance(POLL_MS)
  await clock.advance(120_000)
  expect(held.map(j => j.pid)).toEqual([1400])
})
