import type { DashboardAction, DashboardConversation, DashboardSnapshot, OfficeDataSource, OfficeMemberInput } from '@pixoffice/protocol/dashboard'
import { maxOfficeMembers, officeMemberInputSchema, officeMemberLimitMessage, officeMemberOccupancy, parseDashboardSnapshot } from '@pixoffice/protocol/dashboard'
import { emptyWhiteboard } from '@pixoffice/protocol/office-ui'
import { dashboardWhiteboardTaskBoard } from './whiteboard.ts'
import { notifySubscribers } from '../notifications.ts'
import { demoAgentInsights } from './demoInsights.ts'

const initialEmployees: DashboardSnapshot['employees'] = [
  { id: 'office-lead', sceneActorId: 'office-lead', name: 'Muse', role: '总管 · 枢堂', online: true },
  { id: 'code-agent', sceneActorId: 'code-agent', name: 'Claude', role: '首席分析师 · 衡斋', online: true },
  { id: 'file-agent', sceneActorId: 'file-agent', name: 'ChatGPT', role: '情报官 · 闻阁', online: true },
  { id: 'app-agent', sceneActorId: 'app-agent', name: 'Gemini', role: '副分析师 · 参斋', online: true },
  { id: 'review-agent', sceneActorId: 'review-agent', name: 'Grok', role: '实时情报员 · 望阁', online: true },
  { id: 'data-agent', sceneActorId: 'data-agent', name: 'Codex', role: '程序员 · 算斋', online: true },
  // 财务总监没有 3D 场景人物，sceneActorId 留空（非空且不存在的人物 ID 会导致快照被拒）。
  { id: 'finance-agent', sceneActorId: 'finance-agent', name: 'CFO', role: '财务总监 · 数堂', online: true },
]

export type ExampleOfficeSeed = {
  workspace?: DashboardSnapshot['workspace']
  roles?: Record<string, string>
  employees?: DashboardSnapshot['employees']
  tasks?: Array<Omit<DashboardSnapshot['tasks'][number], 'updatedAt'>>
  whiteboard?: DashboardSnapshot['whiteboard']
  conversationTitle?: string
  conversations?: DashboardConversation[]
  insightDomain?: 'commerce' | 'civic'
}

export class ExampleOfficeDataSource implements OfficeDataSource {
  readonly kind = 'example'
  private listeners = new Set<() => void>()
  private snapshot: DashboardSnapshot
  private conversations = new Map<string, DashboardSnapshot>()
  private conversationTitles = new Map<string, string>()
  private readonly generatedWhiteboard: boolean
  private readonly insightAt: Date
  private readonly insightDomain?: 'commerce' | 'civic'

  constructor(now = new Date(), seed: ExampleOfficeSeed = {}) {
    this.generatedWhiteboard = !seed.whiteboard
    this.insightAt = now; this.insightDomain = seed.insightDomain
    const at = now.toISOString()
    this.snapshot = parseDashboardSnapshot({
      schemaVersion: '1.0', workspace: { id: 'office-1', name: 'BOSS' },
      employees: initialEmployees,
      tasks: [
        { id: 'premarket-brief', title: '盘前简报', assigneeId: 'office-lead', status: 'queued', progress: 0, updatedAt: at, summary: '每日 22:00 推送，暂无进行中内容。' },
        { id: 'panic-report', title: '恐慌度日报', assigneeId: 'code-agent', status: 'queued', progress: 0, updatedAt: at, summary: 'A 股/美股恐慌度日报，暂无进行中内容。' },
        { id: 'earnings-analysis', title: '财报分析', assigneeId: 'code-agent', status: 'queued', progress: 0, updatedAt: at, summary: 'NVDA Q3 财报 11/17，提醒 11/16 08:30。' },
        { id: 'launch-watch', title: '发射监控', assigneeId: 'review-agent', status: 'queued', progress: 0, updatedAt: at, summary: 'Flight 15 窗口 11/14 06:45–08:00（北京），暂无新进展。' },
      ],
      events: [
        { id: 'example-1', kind: 'note', employeeId: 'office-lead', taskId: 'premarket-brief', summary: '办公室改版进行中', occurredAt: at },
        { id: 'example-2', kind: 'note', employeeId: 'review-agent', taskId: 'launch-watch', summary: 'Flight 15 发射窗口待 FAA 最终许可', occurredAt: at },
      ],
    })
    if (seed.workspace) this.snapshot.workspace = { ...seed.workspace }
    if (seed.employees) this.snapshot.employees = structuredClone(seed.employees)
    if (seed.roles) this.snapshot.employees = this.snapshot.employees.map(employee => ({ ...employee, role: seed.roles![employee.id] ?? employee.role }))
    if (seed.tasks) {
      this.snapshot.tasks = seed.tasks.map(task => ({ ...task, updatedAt: at }))
      this.snapshot.events = this.snapshot.tasks.filter(task => task.status === 'running').map(task => ({
        id: `${this.snapshot.workspace.id}-${task.id}`, kind: 'task.started', taskId: task.id,
        employeeId: task.assigneeId, summary: `正在执行${task.title}`, occurredAt: at,
      }))
    }
    this.snapshot = parseDashboardSnapshot(this.snapshot)
    // 不自动附加演示洞察：洞察须用真实业务历史，缺失时页面显示“暂无历史统计”。
    this.snapshot.conversationId = 'main'
    this.snapshot.whiteboard = seed.whiteboard ?? dashboardWhiteboardTaskBoard(this.snapshot)
    this.conversations.set('main', this.snapshot)
    this.conversationTitles.set('main', seed.conversationTitle ?? this.snapshot.whiteboard?.title ?? this.snapshot.workspace.name)
    for (const conversation of seed.conversations ?? []) {
      this.conversations.set(conversation.id, this.conversationSnapshot(conversation))
      this.conversationTitles.set(conversation.id, conversation.title)
    }
  }

  private conversationSnapshot(conversation: DashboardConversation) {
    return parseDashboardSnapshot({ ...this.snapshot, conversationId: conversation.id, employees: conversation.employees.map((employee, index) => ({ ...employee,
      insights: employee.insights ?? demoAgentInsights(index, this.insightAt, conversation.id, this.insightDomain) })),
      tasks: conversation.tasks, events: conversation.events, whiteboard: conversation.whiteboard })
  }
  protected replaceConversations(conversations: readonly DashboardConversation[]) {
    for (const conversation of conversations) {
      this.conversations.set(conversation.id, this.conversationSnapshot(conversation))
      this.conversationTitles.set(conversation.id, conversation.title)
    }
    const selected = this.conversations.get(this.snapshot.conversationId ?? 'main')
    if (selected) this.snapshot = selected
    notifySubscribers(this.listeners, 'ExampleOfficeDataSource')
  }

  async getSnapshot() { return structuredClone(this.snapshot) }
  getConversations(): DashboardConversation[] {
    return [...this.conversations].map(([id, snapshot]) => ({ id, title: this.conversationTitles.get(id) || snapshot.workspace.name,
      employees: structuredClone(snapshot.employees), tasks: structuredClone(snapshot.tasks), events: structuredClone(snapshot.events), whiteboard: structuredClone(snapshot.whiteboard) }))
  }
  selectConversation(id: string) {
    if ((this.snapshot.conversationId ?? '') === id) return
    let snapshot = this.conversations.get(id)
    if (!snapshot) {
      snapshot = { schemaVersion: '1.0', workspace: { ...this.snapshot.workspace }, ...(id ? { conversationId: id } : {}), employees: [], tasks: [], events: [], whiteboard: emptyWhiteboard() }
    }
    this.snapshot = snapshot
    notifySubscribers(this.listeners, 'ExampleOfficeDataSource')
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  async createEmployee(input: OfficeMemberInput) {
    const member = officeMemberInputSchema.parse(input)
    const occupancy = officeMemberOccupancy([...this.conversations.values()])
    if (occupancy.memberIds.size >= maxOfficeMembers) throw new Error(officeMemberLimitMessage)
    if (!initialEmployees.some(employee => employee.sceneActorId === member.sceneActorId)) throw new Error('绑定的人物不存在')
    if (occupancy.actorIds.has(member.sceneActorId)) throw new Error('这个人物和工位已有成员，请选择空闲工位')
    const employee = { ...member, id: crypto.randomUUID(), online: true }
    const next = parseDashboardSnapshot({ ...this.snapshot, employees: [...this.snapshot.employees, employee],
      events: [{ id: crypto.randomUUID(), kind: 'note', employeeId: employee.id, summary: `${employee.name}加入了团队`, occurredAt: new Date().toISOString() }, ...this.snapshot.events].slice(0, 100) })
    this.conversations.set(next.conversationId ?? 'main', next)
    this.snapshot = next
    notifySubscribers(this.listeners, 'ExampleOfficeDataSource')
  }

  async execute(action: DashboardAction) {
    const task = this.snapshot.tasks.find(item => item.id === action.taskId)
    if (!task) throw new Error('任务不存在')
    const employee = action.type === 'task.assign' ? this.snapshot.employees.find(item => item.id === action.assigneeId) : undefined
    if (action.type === 'task.assign' && !employee) throw new Error('员工不存在')
    if (action.type === 'task.start' && (task.status !== 'queued' && task.status !== 'blocked')) throw new Error('只有待开始或阻塞的任务可以启动')
    if (action.type === 'task.block' && task.status !== 'running') throw new Error('只有运行中的任务可以标记为阻塞')
    if (action.type === 'task.complete' && !['running', 'blocked'].includes(task.status)) throw new Error('任务尚未开始')
    if (action.type === 'task.assign' && (task.assigneeId === employee!.id || task.status === 'completed')) throw new Error('任务无需重新分配')

    if (action.type === 'task.assign') {
      task.assigneeId = employee!.id
      task.status = 'queued'
      task.progress = 0
    } else if (action.type === 'task.start') task.status = 'running'
    else if (action.type === 'task.block') task.status = 'blocked'
    else { task.status = 'completed'; task.progress = 100 }
    task.updatedAt = new Date().toISOString()
    this.snapshot.events.unshift({
      id: globalThis.crypto.randomUUID(),
      kind: action.type === 'task.assign' ? 'task.assigned' : action.type === 'task.start' ? 'task.started' : action.type === 'task.block' ? 'task.blocked' : 'task.completed',
      taskId: task.id, employeeId: task.assigneeId, fromEmployeeId: action.type === 'task.assign' ? 'office-lead' : undefined,
      summary: action.type === 'task.assign' ? `任务已交给${employee!.name}` : action.type === 'task.start' ? '开始执行任务' : action.type === 'task.block' ? '任务遇到阻塞' : '任务已完成',
      occurredAt: task.updatedAt,
    })
    this.snapshot.events = this.snapshot.events.slice(0, 100)
    if (this.snapshot.conversationId === 'main' && this.generatedWhiteboard) this.snapshot.whiteboard = dashboardWhiteboardTaskBoard(this.snapshot)
    else if (this.snapshot.whiteboard) {
      const tasks = this.snapshot.tasks
      this.snapshot.whiteboard = { ...this.snapshot.whiteboard,
        status: tasks.length && tasks.every(task => task.status === 'completed') ? 'completed' : tasks.some(task => task.status === 'running') ? 'running'
          : tasks.some(task => task.status === 'blocked') ? 'blocked' : tasks.some(task => task.status === 'failed') ? 'failed' : 'queued',
        steps: (this.snapshot.whiteboard.steps ?? []).map(step => ({ ...step, progress: tasks.find(task => task.id === step.id)?.progress ?? -1 })) }
    }
    notifySubscribers(this.listeners, 'ExampleOfficeDataSource')
  }
}
