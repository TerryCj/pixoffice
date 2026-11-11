/**
 * PixOffice office chat backend — Vercel Serverless Function (Node runtime).
 *
 * Implements the four chat operations the office frontend expects on
 * POST /api/pixoffice/chat (see packages/protocol/src/chat.ts):
 *   send    — start a turn, stream the reply back as NDJSON
 *   history — page stored turns as JSON
 *   resume  — re-attach to a running turn, first event is a snapshot
 *   cancel  — stop a running turn, JSON
 *
 * The single "办公室助手" persona answers via the XXTF relay
 * (https://xxtf.baby) on model claude-haiku-5-5, streaming SSE deltas
 * converted to NDJSON delta events.
 *
 * Auth: the XXTF key is read from the XXTF_API_KEY environment variable at
 * runtime. It must never be written into code, a .env file, or the repo.
 * Turn history lives in function-instance memory (v1 scope): a cold start
 * or a different instance loses it. Rate limit: 20 turns per IP per hour.
 *
 * Passphrase gate (CHAT_PASSPHRASE env var, set by the owner in Vercel):
 * when set, only the owner's IP gets model replies. Sending a message whose
 * trimmed content exactly equals the passphrase authenticates that IP for
 * 24 hours; the passphrase itself is never stored — the unlock turn keeps a
 * placeholder instead. Other messages from unauthenticated IPs get a short
 * denial reply and never reach the model, so they cost nothing. When the
 * variable is unset there is no gate (local development). Auth is keyed by
 * IP, not conversationId, because the frontend shares one conversationId
 * ("main") across visitors.
 */

// 2026-11-12 redeploy trigger: force a fresh Production build so the
// newly set CHAT_PASSPHRASE env var is picked up (no logic change).
import type { IncomingMessage, ServerResponse } from 'node:http'

export const runtime = 'nodejs'
export const maxDuration = 60

const XXTF_BASE = 'https://xxtf.baby'
const MODEL = 'claude-haiku-5-5'
const MAX_TOKENS = 800
const UPSTREAM_TIMEOUT_MS = 120_000
const STREAM_CAP_MS = 55_000
const MAX_REPLY_CHARS = 50_000
const MAX_REQUEST_BYTES = 524_288
const MAX_HISTORY_TURNS = 200
const RATE_LIMIT_TURNS = 20
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const AUTH_TTL_MS = 24 * 60 * 60 * 1000
const UNLOCK_PLACEHOLDER = '（口令验证）'
const UNLOCK_REPLY = '认出你了，开始吧'
const DENIAL_REPLY = '这个办公室只回主人的消息，请先发口令。'

const SYSTEM_PROMPT =
  '你是 AI 团队办公室的办公室助手。你所在的团队有 6 位 AI 成员：' +
  'Muse（总管）、Claude（首席分析师）、ChatGPT（情报官）、' +
  'Gemini（副分析师）、Grok（实时情报员）、Codex（程序员）。' +
  '团队当前有 4 项任务，全部待开始：盘前简报（Muse 负责）、' +
  '恐慌度日报（Claude 负责）、财报分析·NVDA Q3（Claude 负责）、' +
  '发射监控·Starship Flight 15（Grok 负责）。' +
  '用简体中文回答，简洁直接，先说结论。' +
  '用户问任务进展时，如实说任务尚未开始、没有真实进度，不要编造数字。' +
  '你只是聊天助手，不能执行交易、下单或操作任何真实系统。'

type TurnState = 'pending' | 'complete' | 'stopped' | 'error'

type ChatEvent =
  | { type: 'status'; phase: 'thinking' | 'streaming' }
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'snapshot'; text: string; state: TurnState; message: string }

type ChatTurn = { role: 'user' | 'assistant'; content: string }

type Turn = {
  id: string
  user: string
  assistant: string
  state: TurnState
  error: string
  listeners: Set<(event: ChatEvent) => void>
  abort: AbortController | null
  capTimer: ReturnType<typeof setTimeout> | null
}

type Conversation = { turns: Turn[] }

const conversations = new Map<string, Conversation>()
const rateLimits = new Map<string, { count: number; windowStart: number }>()
const authenticatedIps = new Map<string, number>()

class HttpError extends Error {
  readonly status: number
  readonly reasonCode: string
  constructor(status: number, reasonCode: string, message: string) {
    super(message)
    this.status = status
    this.reasonCode = reasonCode
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNull(value: unknown): boolean {
  if (value === null) return true
  if (Array.isArray(value)) return value.some(hasNull)
  if (isRecord(value)) return Object.values(value).some(hasNull)
  return false
}

function isString(value: unknown, min = 1, max = 100): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function checkKeys(body: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, 'INVALID_MESSAGE', `不支持的字段：${key}`)
  }
  for (const key of allowed) {
    if (!optional.includes(key) && !(key in body)) throw new HttpError(400, 'INVALID_MESSAGE', `缺少字段：${key}`)
  }
}

type Operation =
  | { type: 'send'; turnId: string; teamId: string; conversationId: string; messages: ChatTurn[] }
  | { type: 'history'; teamId: string; conversationId: string; cursor: string; limit: number }
  | { type: 'resume'; teamId: string; conversationId: string; turnId: string }
  | { type: 'cancel'; teamId: string; conversationId: string; turnId: string }

function parseMessages(value: unknown): ChatTurn[] {
  if (!Array.isArray(value) || value.length > 21) {
    throw new HttpError(400, 'INVALID_MESSAGE', 'messages 必须是最多 21 条的数组')
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new HttpError(400, 'INVALID_MESSAGE', '消息格式无效')
    checkKeys(item, ['role', 'content'])
    if (item.role !== 'user' && item.role !== 'assistant') {
      throw new HttpError(400, 'INVALID_MESSAGE', '消息角色无效')
    }
    if (typeof item.content !== 'string' || item.content.length > 50_000) {
      throw new HttpError(400, 'INVALID_MESSAGE', '消息内容过长')
    }
    return { role: item.role, content: item.content }
  })
}

function parseOperation(body: unknown): Operation {
  if (!isRecord(body) || hasNull(body)) {
    throw new HttpError(400, 'INVALID_MESSAGE', '请求体无效')
  }
  if (body.version !== '1.0') throw new HttpError(400, 'INVALID_MESSAGE', 'version 必须为 1.0')
  if (!isString(body.teamId) || !isString(body.conversationId)) {
    throw new HttpError(400, 'INVALID_MESSAGE', 'teamId 与 conversationId 不能为空')
  }
  const teamId = body.teamId
  const conversationId = body.conversationId
  switch (body.type) {
    case 'send': {
      checkKeys(body, ['version', 'type', 'turnId', 'teamId', 'conversationId', 'messages'])
      if (!isString(body.turnId)) throw new HttpError(400, 'INVALID_MESSAGE', 'turnId 不能为空')
      return { type: 'send', turnId: body.turnId, teamId, conversationId, messages: parseMessages(body.messages) }
    }
    case 'history': {
      checkKeys(body, ['version', 'type', 'teamId', 'conversationId', 'cursor', 'limit'], ['cursor', 'limit'])
      const cursor = body.cursor === undefined ? '' : body.cursor
      const limit = body.limit === undefined ? 20 : body.limit
      if (typeof cursor !== 'string' || cursor.length > 500) {
        throw new HttpError(400, 'INVALID_MESSAGE', 'cursor 无效')
      }
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new HttpError(400, 'INVALID_MESSAGE', 'limit 必须在 1–50 之间')
      }
      return { type: 'history', teamId, conversationId, cursor, limit }
    }
    case 'resume':
    case 'cancel': {
      checkKeys(body, ['version', 'type', 'teamId', 'conversationId', 'turnId'])
      if (!isString(body.turnId)) throw new HttpError(400, 'INVALID_MESSAGE', 'turnId 不能为空')
      return { type: body.type, teamId, conversationId, turnId: body.turnId }
    }
    default:
      throw new HttpError(400, 'INVALID_MESSAGE', 'type 必须是 send、history、resume 或 cancel')
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const preParsed = (req as { body?: unknown }).body
  if (preParsed !== undefined) {
    if (typeof preParsed === 'string') return JSON.parse(preParsed) as unknown
    if (Buffer.isBuffer(preParsed)) return JSON.parse(preParsed.toString('utf-8')) as unknown
    return preParsed
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, 'INVALID_MESSAGE', '请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  if (!text.trim()) throw new HttpError(400, 'INVALID_MESSAGE', '请求体为空')
  return JSON.parse(text) as unknown
}

function getConversation(teamId: string, conversationId: string): Conversation {
  const key = JSON.stringify([teamId, conversationId])
  let conversation = conversations.get(key)
  if (!conversation) {
    conversation = { turns: [] }
    conversations.set(key, conversation)
  }
  return conversation
}

const emit = (turn: Turn, event: ChatEvent): void => {
  for (const send of [...turn.listeners]) {
    try {
      send(event)
    } catch {
      // A broken listener must not stop the others.
    }
  }
}

const snapshot = (turn: Turn): ChatEvent => ({
  type: 'snapshot',
  text: turn.assistant,
  state: turn.state,
  message: turn.error,
})

const view = (turn: Turn) => ({
  id: turn.id,
  user: turn.user.slice(0, 4000),
  assistant: turn.assistant,
  state: turn.state,
  error: turn.error,
})

function completeTurn(turn: Turn): void {
  if (turn.state !== 'pending') return
  if (turn.capTimer) clearTimeout(turn.capTimer)
  turn.capTimer = null
  turn.abort = null
  turn.state = 'complete'
  emit(turn, { type: 'done' })
}

function failTurn(turn: Turn, message: string): void {
  if (turn.state !== 'pending') return
  if (turn.capTimer) clearTimeout(turn.capTimer)
  turn.capTimer = null
  turn.abort = null
  turn.state = 'error'
  turn.error = message.slice(0, 1000)
  emit(turn, { type: 'error', message: turn.error })
}

function stopTurn(turn: Turn): void {
  if (turn.state !== 'pending') return
  if (turn.capTimer) clearTimeout(turn.capTimer)
  turn.capTimer = null
  turn.abort?.abort()
  turn.abort = null
  turn.state = 'stopped'
  emit(turn, snapshot(turn))
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()
  if (first) return first
  const realIp = req.headers['x-real-ip']
  if (typeof realIp === 'string' && realIp) return realIp
  return req.socket.remoteAddress ?? 'unknown'
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  if (rateLimits.size > 5000) {
    for (const [key, entry] of rateLimits) {
      if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) rateLimits.delete(key)
    }
  }
  const entry = rateLimits.get(ip)
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= RATE_LIMIT_TURNS) return false
  entry.count += 1
  return true
}

function isAuthenticated(ip: string): boolean {
  const expiresAt = authenticatedIps.get(ip)
  if (!expiresAt) return false
  if (Date.now() >= expiresAt) {
    authenticatedIps.delete(ip)
    return false
  }
  return true
}

function authenticateIp(ip: string): void {
  if (authenticatedIps.size > 5000) {
    const now = Date.now()
    for (const [key, expiresAt] of authenticatedIps) {
      if (now >= expiresAt) authenticatedIps.delete(key)
    }
  }
  authenticatedIps.set(ip, Date.now() + AUTH_TTL_MS)
}

function readPassphrase(): string {
  // The owner typed the variable name on an iPhone and autocapitalise
  // turned it into "Chat_passphrase"; match the key case-insensitively
  // so the gate works regardless of the exact casing used in Vercel.
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'chat_passphrase') return (value ?? '').trim()
  }
  return ''
}

/** Normalize browser context for the model: alternate roles, end with the user turn, cap total size. */
function normalizeMessages(messages: ChatTurn[]): ChatTurn[] {
  const merged: ChatTurn[] = []
  for (const message of messages) {
    const last = merged.at(-1)
    if (last && last.role === message.role) last.content += `\n${message.content}`
    else merged.push({ role: message.role, content: message.content })
  }
  while (merged.length && merged[0]?.role !== 'user') merged.shift()
  while (merged.length && merged.at(-1)?.role === 'assistant') merged.pop()
  let total = merged.reduce((sum, message) => sum + message.content.length, 0)
  while (merged.length > 2 && total > 100_000) {
    const removed = merged.shift()
    total -= removed?.content.length ?? 0
  }
  return merged.map((message) => ({ ...message, content: message.content.slice(0, 50_000) }))
}

function appendText(turn: Turn, text: string): void {
  if (!text || turn.state !== 'pending') return
  const room = MAX_REPLY_CHARS - turn.assistant.length
  if (room <= 0) return
  const piece = text.slice(0, room)
  turn.assistant += piece
  emit(turn, { type: 'delta', text: piece })
}

function parseSsePayload(payload: string, turn: Turn): boolean {
  // Returns true when the upstream stream is finished.
  let data: Record<string, unknown>
  try {
    data = JSON.parse(payload) as Record<string, unknown>
  } catch {
    return false
  }
  if (data.type === 'message_stop') return true
  if (data.type === 'error') {
    const message = isRecord(data.error) && typeof data.error.message === 'string' ? data.error.message : '模型服务返回错误'
    throw new Error(message)
  }
  if (data.type === 'content_block_delta') {
    const delta = data.delta
    if (isRecord(delta) && delta.type === 'text_delta' && typeof delta.text === 'string') appendText(turn, delta.text)
    return false
  }
  if (data.type === 'message_delta') {
    const delta = data.delta
    if (isRecord(delta) && typeof delta.stop_reason === 'string') return true
    return false
  }
  if (Array.isArray(data.choices)) {
    const choice = data.choices[0]
    if (isRecord(choice)) {
      const delta = choice.delta
      if (isRecord(delta) && typeof delta.content === 'string') appendText(turn, delta.content)
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) return true
    }
  }
  return false
}

async function pumpSseStream(body: ReadableStream<Uint8Array>, turn: Turn, signal: AbortSignal): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') return
          if (payload && parseSsePayload(payload, turn)) return
        }
        newline = buffer.indexOf('\n')
      }
      if (done) {
        if (buffer.trim().startsWith('data:')) {
          const payload = buffer.trim().slice(5).trim()
          if (payload && payload !== '[DONE]') parseSsePayload(payload, turn)
        }
        return
      }
      signal.throwIfAborted()
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * Calls XXTF and pumps the SSE reply into the turn. Resolves true once the
 * upstream accepted the request (HTTP 200 with a stream); resolves false if
 * the upstream rejected it before streaming started, so the caller can still
 * answer with a plain 502 instead of a half-open stream.
 */
async function beginGeneration(turn: Turn, messages: ChatTurn[]): Promise<boolean> {
  const apiKey = process.env.XXTF_API_KEY ?? ''
  const controller = new AbortController()
  turn.abort = controller
  turn.capTimer = setTimeout(() => {
    if (turn.state === 'pending') {
      controller.abort()
      failTurn(turn, '回复超时，请重试')
    }
  }, STREAM_CAP_MS)
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
  const normalized = normalizeMessages(messages)
  const isClaude = MODEL.startsWith('claude-')
  const url = `${XXTF_BASE}${isClaude ? '/v1/messages' : '/v1/chat/completions'}`
  const requestBody = isClaude
    ? { model: MODEL, max_tokens: MAX_TOKENS, stream: true, system: SYSTEM_PROMPT, messages: normalized }
    : { model: MODEL, max_tokens: MAX_TOKENS, stream: true, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...normalized] }
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
      signal,
    })
  } catch {
    if (turn.capTimer) clearTimeout(turn.capTimer)
    turn.capTimer = null
    turn.abort = null
    return false
  }
  if (!response.ok || !response.body) {
    if (turn.capTimer) clearTimeout(turn.capTimer)
    turn.capTimer = null
    turn.abort = null
    return false
  }
  emit(turn, { type: 'status', phase: 'streaming' })
  void pumpSseStream(response.body, turn, signal)
    .then(() => completeTurn(turn))
    .catch((error: unknown) => {
      if (turn.state !== 'pending') return
      if (error instanceof Error && error.name === 'AbortError') {
        if (turn.state === 'pending') failTurn(turn, '回复超时，请重试')
        return
      }
      failTurn(turn, '模型服务暂时不可用，请稍后再试')
    })
  return true
}

function jsonResponse(res: ServerResponse, status: number, code: number, msg: string, data: Record<string, unknown>): void {
  const payload = JSON.stringify({ code, msg, data })
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(payload)
}

function attachStream(res: ServerResponse, turn: Turn, firstEvents: ChatEvent[]): void {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
  let ended = false
  const send = (event: ChatEvent): void => {
    if (ended || res.destroyed || res.writableEnded) return
    if (res.writableLength > 524_288) {
      res.destroy()
      return
    }
    res.write(`${JSON.stringify(event)}\n`)
    if (event.type === 'done' || event.type === 'error' || (event.type === 'snapshot' && event.state !== 'pending')) {
      ended = true
      res.end()
    }
  }
  turn.listeners.add(send)
  res.once('close', () => {
    turn.listeners.delete(send)
  })
  for (const event of firstEvents) send(event)
}

function handleHistory(op: Extract<Operation, { type: 'history' }>, res: ServerResponse): void {
  const conversation = getConversation(op.teamId, op.conversationId)
  const turns = conversation.turns
  const end = op.cursor ? turns.findIndex((turn) => turn.id === op.cursor) : turns.length
  if (end < 0) throw new HttpError(400, 'INVALID_CURSOR', '找不到该历史游标')
  const start = Math.max(0, end - op.limit)
  const selected = turns.slice(start, end)
  jsonResponse(res, 200, 200, 'OK', {
    turns: selected.map(view),
    nextCursor: start > 0 ? turns[start]?.id ?? '' : '',
    hasMore: start > 0,
    activeTurnId: selected.find((turn) => turn.state === 'pending')?.id ?? '',
  })
}

/** Creates an already-complete turn (no model call) and streams its terminal snapshot. */
function replyInstantly(conversation: Conversation, turnId: string, userText: string, assistantText: string, res: ServerResponse): void {
  const turn: Turn = {
    id: turnId,
    user: userText,
    assistant: assistantText,
    state: 'complete',
    error: '',
    listeners: new Set(),
    abort: null,
    capTimer: null,
  }
  conversation.turns.push(turn)
  while (conversation.turns.length > MAX_HISTORY_TURNS) {
    const index = conversation.turns.findIndex((candidate) => candidate.state !== 'pending')
    if (index < 0) break
    conversation.turns.splice(index, 1)
  }
  attachStream(res, turn, [snapshot(turn)])
}

async function handleSend(op: Extract<Operation, { type: 'send' }>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const conversation = getConversation(op.teamId, op.conversationId)
  const existing = conversation.turns.find((turn) => turn.id === op.turnId)
  const lastUser = op.messages.at(-1)
  if (existing) {
    if (lastUser?.content !== existing.user) {
      throw new HttpError(409, 'TURN_CONFLICT', '该轮次 ID 已对应不同的输入')
    }
    attachStream(res, existing, existing.state === 'pending'
      ? [{ type: 'status', phase: 'thinking' }, snapshot(existing)]
      : [snapshot(existing)])
    return
  }
  if (lastUser?.role !== 'user' || !lastUser.content.trim()) {
    throw new HttpError(400, 'INVALID_MESSAGE', '需要一条用户消息')
  }
  if (conversation.turns.some((turn) => turn.state === 'pending')) {
    throw new HttpError(409, 'CHAT_BUSY', '已有回复正在生成')
  }
  const ip = clientIp(req)
  if (!checkRateLimit(ip)) {
    throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试')
  }
  const passphrase = readPassphrase()
  if (passphrase) {
    const content = lastUser.content.trim()
    if (content === passphrase) {
      authenticateIp(ip)
      replyInstantly(conversation, op.turnId, UNLOCK_PLACEHOLDER, UNLOCK_REPLY, res)
      return
    }
    if (!isAuthenticated(ip)) {
      replyInstantly(conversation, op.turnId, lastUser.content, DENIAL_REPLY, res)
      return
    }
  }
  if (!process.env.XXTF_API_KEY) {
    throw new HttpError(503, 'CHAT_NOT_CONFIGURED', '聊天服务尚未配置')
  }
  const turn: Turn = {
    id: op.turnId,
    user: lastUser.content,
    assistant: '',
    state: 'pending',
    error: '',
    listeners: new Set(),
    abort: null,
    capTimer: null,
  }
  conversation.turns.push(turn)
  while (conversation.turns.length > MAX_HISTORY_TURNS) {
    const index = conversation.turns.findIndex((candidate) => candidate.state !== 'pending')
    if (index < 0) break
    conversation.turns.splice(index, 1)
  }
  const started = await beginGeneration(turn, op.messages)
  if (!started) {
    failTurn(turn, '模型服务暂时不可用，请稍后再试')
    jsonResponse(res, 502, 502, '模型服务暂时不可用', { reasonCode: 'CHAT_UPSTREAM_ERROR' })
    return
  }
  attachStream(res, turn, [{ type: 'status', phase: 'thinking' }, snapshot(turn)])
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== 'POST') {
      jsonResponse(res, 405, 405, '仅支持 POST', { reasonCode: 'INVALID_MESSAGE' })
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, 'INVALID_MESSAGE', '请求体不是合法 JSON')
    }
    const op = parseOperation(body)
    if (op.type === 'history') {
      handleHistory(op, res)
      return
    }
    if (op.type === 'cancel') {
      const conversation = getConversation(op.teamId, op.conversationId)
      const turn = conversation.turns.find((candidate) => candidate.id === op.turnId)
      if (turn) stopTurn(turn)
      jsonResponse(res, 200, 200, 'OK', { stopped: true })
      return
    }
    if (op.type === 'resume') {
      const conversation = getConversation(op.teamId, op.conversationId)
      const turn = conversation.turns.find((candidate) => candidate.id === op.turnId)
      if (!turn) throw new HttpError(404, 'TURN_NOT_FOUND', '找不到该轮对话')
      attachStream(res, turn, [snapshot(turn)])
      return
    }
    await handleSend(op, req, res)
  } catch (error) {
    if (res.headersSent) {
      res.end()
      return
    }
    if (error instanceof HttpError) {
      jsonResponse(res, error.status, error.status, error.message, { reasonCode: error.reasonCode })
      return
    }
    jsonResponse(res, 500, 500, '服务器内部错误', { reasonCode: 'INTERNAL_ERROR' })
  }
}
