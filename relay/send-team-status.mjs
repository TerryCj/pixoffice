#!/usr/bin/env node
/**
 * PixOffice 团队状态推送器（外部业务后端）。
 *
 * 从 team-status.json 读取六人团队的真实状态，按 PixOffice 办公室 HTTP 接入协议
 * （integration/docs/office-integration.md）推送给本仓库自带的 Fastify 服务：
 *   POST <PIXOFFICE_URL>/api/pixoffice/messages
 *   Authorization: Bearer <PIXOFFICE_API_KEY>
 *
 * 用法（先启动服务：npm run build:full && npm start，默认监听 127.0.0.1:8765）：
 *   node relay/send-team-status.mjs init      # offices.initialize，seq=1
 *   node relay/send-team-status.mjs snapshot  # office.snapshot，seq 自动 +1
 *   node relay/send-team-status.mjs say <actorId> <text>  # 场景指令：让某人说一句话
 *
 * 环境变量：PIXOFFICE_URL（默认 http://127.0.0.1:8765）、PIXOFFICE_API_KEY（默认 pixoffice-demo-key）。
 * 注意：pixoffice-demo-key 是公开演示值，仅限本地使用；公网部署前务必更换。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = (process.env.PIXOFFICE_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '')
const apiKey = process.env.PIXOFFICE_API_KEY ?? 'pixoffice-demo-key'
const members = JSON.parse(readFileSync(join(root, 'team-status.json'), 'utf8'))

const tasks = [
  { id: 'premarket-brief', title: '盘前简报', assigneeId: 'office-lead', status: 'queued', progress: 0, summary: '每日 22:00 推送，暂无进行中内容。' },
  { id: 'panic-report', title: '恐慌度日报', assigneeId: 'code-agent', status: 'queued', progress: 0, summary: 'A 股/美股恐慌度日报，暂无进行中内容。' },
  { id: 'earnings-analysis', title: '财报分析', assigneeId: 'code-agent', status: 'queued', progress: 0, summary: 'NVDA Q3 财报 11/17，提醒 11/16 08:30。' },
  { id: 'launch-watch', title: '发射监控', assigneeId: 'review-agent', status: 'queued', progress: 0, summary: 'Flight 15 窗口 11/14 06:45–08:00（北京），暂无新进展。' },
]

function snapshot(seq, now) {
  return {
    schemaVersion: '1.0',
    seq,
    workspace: { id: 'office-1', name: 'AI 团队办公室' },
    conversations: [{
      id: 'main',
      title: 'AI 团队日常',
      employees: members.map(m => ({
        id: m.id, sceneActorId: m.id, name: m.name,
        role: `${m.role} · ${m.room}`, online: m.status !== '暂停',
      })),
      tasks: tasks.map(t => ({ ...t, updatedAt: now })),
      events: [
        { id: 'team-note-1', kind: 'note', employeeId: 'office-lead', summary: '办公室改版进行中：六人团队就位。', occurredAt: now },
      ],
      whiteboard: {
        template: 'task-board-v1', title: 'AI 团队日常', status: 'queued',
        description: '盘前简报、恐慌度日报、财报分析、发射监控。', note: '没有真实数据时不填进度。',
        steps: [
          { id: 'premarket-brief', title: '盘前简报' },
          { id: 'panic-report', title: '恐慌度日报' },
          { id: 'earnings-analysis', title: '财报分析' },
        ],
      },
    }],
  }
}

async function post(body) {
  const res = await fetch(`${base}/api/pixoffice/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  console.log(`HTTP ${res.status}`)
  console.log(text)
  return { status: res.status, text }
}

async function currentSeq() {
  const res = await fetch(`${base}/api/pixoffice/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'office.read', teamId: 'office-1' }),
  })
  if (res.status === 404) return 0
  const data = JSON.parse(await res.text())
  return data?.data?.snapshot?.seq ?? 0
}

const [mode, ...args] = process.argv.slice(2)
const now = new Date().toISOString()

if (mode === 'init') {
  await post({ type: 'offices.initialize', offices: [snapshot(1, now)] })
} else if (mode === 'snapshot') {
  const seq = await currentSeq()
  if (seq === 0) {
    console.log('办公室未初始化，先执行 init。')
    await post({ type: 'offices.initialize', offices: [snapshot(1, now)] })
  } else {
    await post({ type: 'office.snapshot', teamId: 'office-1', snapshot: snapshot(seq + 1, now) })
  }
} else if (mode === 'say') {
  const [actorId, text] = args
  if (!actorId || !text) {
    console.error('用法：node relay/send-team-status.mjs say <actorId> <text>')
    process.exit(2)
  }
  await post({
    teamId: 'office-1',
    command: {
      protocolVersion: '2.0', sceneId: 'office-1', commandId: `say-${Date.now()}`,
      type: 'activity.start', capability: 'scene.say',
      participants: [{ entityId: actorId, role: 'actor' }],
      params: { text, durationMs: 4000 },
    },
  })
} else {
  console.error('用法：node relay/send-team-status.mjs <init|snapshot|say>')
  process.exit(2)
}
