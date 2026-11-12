#!/usr/bin/env node
/**
 * 办公室任务状态更新器：更新 team-tasks.json（任务/动态），再推送一次快照。
 *
 * 用法：
 *   node relay/task.mjs <taskId> <status> "<summary>" [--title 标题] [--assignee 成员id] [--progress 0-100] [--event 动态文字] [--no-event]
 *   node relay/task.mjs --event-only <employeeId> "<动态文字>"
 *
 * status 只能是 queued / running / blocked / completed / failed（协议枚举）。
 * 新任务必须给 --title；已有任务只更新给出的字段。
 * 默认同时追加一条动态（只留最新 8 条）；--no-event 不追加。
 * 环境变量与 send-team-status.mjs 相同：PIXOFFICE_URL、PIXOFFICE_API_KEY。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const boardPath = join(root, 'team-tasks.json')
const STATUSES = ['queued', 'running', 'blocked', 'completed', 'failed']
const STATUS_TEXT = { queued: '待开始', running: '进行中', blocked: '受阻', completed: '已完成', failed: '失败' }
const MAX_EVENTS = 8

const argv = process.argv.slice(2)
const now = new Date().toISOString()

function fail(msg) { console.error(msg); process.exit(2) }

const board = JSON.parse(readFileSync(boardPath, 'utf8'))
if (!Array.isArray(board.tasks) || !Array.isArray(board.events)) fail('team-tasks.json 格式不对：需要 tasks 与 events 数组。')

function pushEvent(employeeId, summary) {
  board.events.push({ id: `event-${Date.now()}`, kind: 'note', employeeId, summary: summary.slice(0, 300), occurredAt: now })
  while (board.events.length > MAX_EVENTS) board.events.shift()
}

function save() {
  const tmp = boardPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n', 'utf8')
  renameSync(tmp, boardPath)
}

function push() {
  let out = ''
  let failed = false
  try {
    out = execFileSync('node', [join(root, 'relay', 'send-team-status.mjs'), 'snapshot'], {
      env: process.env, timeout: 240000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    })
  } catch (e) {
    failed = true
    out = (e.stdout ?? '').toString()
  }
  const lines = out.split('\n').filter(l => l.trim() !== '')
  for (const l of lines.slice(0, 2)) console.log(l.slice(0, 200))
  const tail = lines.length ? lines[lines.length - 1].slice(0, 300) : ''
  if (tail && lines[lines.length - 1] !== lines[0] && lines[lines.length - 1] !== lines[1]) console.log(tail)
  if (failed) {
    console.error('推送命令失败（team-tasks.json 已更新，下次推送会带上）。')
    process.exit(1)
  }
}

if (argv[0] === '--event-only') {
  const [, employeeId, text] = argv
  if (!employeeId || !text) fail('用法：node relay/task.mjs --event-only <employeeId> "<动态文字>"')
  pushEvent(employeeId, text)
  save()
  console.log(`动态已追加：${text}`)
  push()
} else {
  const [taskId, status, summary, ...rest] = argv
  if (!taskId || !status || !summary) fail('用法：node relay/task.mjs <taskId> <status> "<summary>" [--title 标题] [--assignee 成员id] [--progress N] [--event 动态] [--no-event]')
  if (!STATUSES.includes(status)) fail(`status 只能是 ${STATUSES.join(' / ')}，收到：${status}`)
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--no-event') { flags.noEvent = true; continue }
    if (rest[i].startsWith('--')) { flags[rest[i].slice(2)] = rest[i + 1]; i++; continue }
    fail(`不认识的参数：${rest[i]}`)
  }
  let task = board.tasks.find(t => t.id === taskId)
  if (!task) {
    if (!flags.title) fail(`新任务 ${taskId} 必须给 --title。`)
    task = { id: taskId, title: flags.title, assigneeId: flags.assignee ?? 'office-lead', status, progress: 0, summary }
    board.tasks.push(task)
  } else {
    task.status = status
    task.summary = summary
    if (flags.title) task.title = flags.title
    if (flags.assignee) task.assigneeId = flags.assignee
    if (flags.progress !== undefined) {
      const p = Number(flags.progress)
      if (!Number.isInteger(p) || p < 0 || p > 100) fail(`--progress 须为 0–100 的整数，收到：${flags.progress}`)
      task.progress = p
    }
  }
  if (!flags.noEvent) pushEvent(task.assigneeId, flags.event ?? `${task.title}：${STATUS_TEXT[status]}——${summary}`)
  save()
  console.log(`任务已更新：${task.id} ${task.title} ${status}`)
  push()
}
