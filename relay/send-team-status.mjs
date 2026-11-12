#!/usr/bin/env node
/**
 * PixOffice 团队状态推送器（外部业务后端）。
 *
 * 从 team-status.json 读取六人团队的真实状态，按 PixOffice 办公室 HTTP 接入协议
 * （integration/docs/office-integration.md）推送给本仓库自带的 Fastify 服务：
 *   POST <PIXOFFICE_URL>/api/pixoffice/messages
 *   Authorization: Bearer <PIXOFFICE_API_KEY>
 *
 * 成本面板：team-finance.json 为空对象 {} 时不推送 finance 字段（页面显示“暂无”），
 * 有数据时原样带入快照 conversation.finance。字段格式（全部可选，缺失显示“暂无”）：
 *   { updatedAt, relayBalanceUsd, relaySpentUsd, relayBudgetUsd,
 *     byModel: [{ model, calls, costUsd }], byDay: [{ date, costUsd }],
 *     quotaUsedPercent, quotaResetsAt, alert }
 * 注意：旧版 relay/页面（finance 字段上线前的构建）会拒绝含 finance 的快照，
 * 推送真实成本数据前，须先把新构建部署到 relay。
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
const board = JSON.parse(readFileSync(join(root, 'team-tasks.json'), 'utf8'))
const finance = JSON.parse(readFileSync(join(root, 'team-finance.json'), 'utf8'))
const hasFinance = finance && typeof finance === 'object' && Object.keys(finance).length > 0
const WHITEBOARD_TASK_IDS = ['premarket-brief', 'panic-report', 'earnings-analysis']

// 白板只放 3 个常驻任务（协议上限 3 步），进度与状态直接取任务的真实值。
function buildWhiteboard() {
  const stepTasks = WHITEBOARD_TASK_IDS.map(id => board.tasks.find(t => t.id === id)).filter(Boolean)
  const status = stepTasks.some(t => t.status === 'blocked' || t.status === 'failed') ? 'blocked'
    : stepTasks.some(t => t.status === 'running') ? 'running'
    : stepTasks.length > 0 && stepTasks.every(t => t.status === 'completed') ? 'completed'
    : 'queued'
  return {
    template: 'task-board-v1', title: 'AI 团队日常', status,
    description: '盘前简报、恐慌度日报、财报分析、发射监控。', note: '没有真实数据时不填进度。',
    steps: stepTasks.map(t => ({ id: t.id, title: t.title, progress: t.progress ?? -1 })),
  }
}

function snapshot(seq, now) {
  return {
    schemaVersion: '1.0',
    seq,
    workspace: { id: 'office-1', name: 'BOSS' },
    conversations: [{
      id: 'main',
      title: 'AI 团队日常',
      employees: members.map(m => ({
        id: m.id, sceneActorId: m.sceneActorId ?? m.id, name: m.name,
        role: `${m.role} · ${m.room}`, online: m.status !== '暂停',
      })),
      tasks: board.tasks.map(t => ({ ...t, updatedAt: now })),
      events: board.events,
      whiteboard: buildWhiteboard(),
      ...(hasFinance ? { finance } : {}),
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

// 当前 seq 从 SSE 流读取：office.read 在有浏览器连接时会等浏览器作答而超时，
// 反而在用户正看着页面时拿不到 seq。SSE 的 office.sync.complete 自带各办公室 seq。
async function serverSeq() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 75000) // Render 休眠唤醒约 60 秒，留足时间
  try {
    const res = await fetch(`${base}/api/pixoffice/events?workspace=1`, {
      signal: controller.signal, headers: { Accept: 'text/event-stream' },
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      if (buf.includes('office.sync.complete')) break
      if (buf.length > 2_000_000) break
    }
    await reader.cancel().catch(() => {})
    const m = buf.match(/\{"teamId":"office-1","seq":(\d+)\}/)
    return m ? Number(m[1]) : 0
  } catch {
    return -1
  } finally {
    clearTimeout(timer)
  }
}

const [mode, ...args] = process.argv.slice(2)
const now = new Date().toISOString()

if (mode === 'init') {
  await post({ type: 'offices.initialize', offices: [snapshot(1, now)] })
} else if (mode === 'snapshot') {
  const seq = await serverSeq()
  if (seq < 0) {
    console.error('无法读取 relay 当前 seq，取消推送。')
    process.exit(1)
  }
  if (seq === 0) {
    console.log('办公室未初始化，先执行 init。')
    await post({ type: 'offices.initialize', offices: [snapshot(1, now)] })
  } else {
    // 注意：office.snapshot 常返回 408（等浏览器回执超时），但快照可能已入库，以 SSE 核实的 seq 为准。
    const r = await post({ type: 'office.snapshot', teamId: 'office-1', snapshot: snapshot(seq + 1, now) })
    const after = await serverSeq()
    console.log(`推送返回 HTTP ${r.status}，relay 当前 seq=${after}（期望 ${seq + 1}）`)
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
