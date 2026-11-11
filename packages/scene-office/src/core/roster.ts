export type AgentRosterEntry = {
  id: string
  name: string
  color: number
  task: string
  room: string
}

/** 6 位 AI 团队成员（名册序号 1–6） */
export const OFFICE_ROSTER: AgentRosterEntry[] = [
  {
    id: 'office-lead',
    name: 'Muse',
    color: 0xe85d4a,
    task: '总管：正在改办公室',
    room: '枢堂',
  },
  {
    id: 'code-agent',
    name: 'Claude',
    color: 0x4a90d9,
    task: '分析：待命',
    room: '衡斋',
  },
  {
    id: 'file-agent',
    name: 'ChatGPT',
    color: 0x9b6dd7,
    task: '情报：待命',
    room: '闻阁',
  },
  {
    id: 'app-agent',
    name: 'Gemini',
    color: 0xf5c542,
    task: '分析：待命',
    room: '参斋',
  },
  {
    id: 'review-agent',
    name: 'Grok',
    color: 0xf97316,
    task: '情报：待命',
    room: '望阁',
  },
  {
    id: 'data-agent',
    name: 'Codex',
    color: 0x4ecdc4,
    task: '开发：待命',
    room: '算斋',
  },
]
