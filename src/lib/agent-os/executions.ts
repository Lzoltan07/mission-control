/**
 * Agent OS (fork addition): execution log – which device sent an instruction, which machine/agent
 * works on it and how far it got. Own tables (created on first use, not part of upstream migrations):
 *   aos_devices       one row per browser (random id kept in its localStorage), optional name
 *   aos_device_seen   heartbeats (one per minute while Mission Control is open; kept 7 days) – used
 *                     to tell which device was active when a task was assigned on the board
 *   aos_executions    one row per run (voice question, agent task run), updated while it runs; since
 *                     2026-10-20 also what the run consumed (Claude Code's own report: turns, tokens,
 *                     API-equivalent USD – on the subscription this is no bill, it measures how much of
 *                     the usage allowance a run takes) and why it ended (ok, max_turns, limit, auth, error)
 */
import os from 'node:os'
import { getDatabase } from '@/lib/db'

export type ExecStatus = 'running' | 'done' | 'failed'
export type EndReason = 'ok' | 'max_turns' | 'limit' | 'auth' | 'error'

export interface RunUsage {
  model: string | null
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  durationMs: number
  endReason: EndReason
}

export interface Execution {
  id: number
  kind: 'hang' | 'feladat'
  title: string
  taskId: number | null
  sourceUser: string | null
  sourceDevice: string | null
  sourceEstimated: boolean
  agent: string | null
  workerDevice: string
  status: ExecStatus
  progress: string | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  usage: RunUsage | null
}

export const THIS_MACHINE = process.env.AOS_DEVICE_NAME || os.hostname()
const now = () => Math.floor(Date.now() / 1000)
const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null)

let ready = false
function db() {
  const d = getDatabase()
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS aos_devices (
        id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, username TEXT NOT NULL,
        name TEXT, ua_label TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS aos_device_seen (
        device_id TEXT NOT NULL, username TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS aos_device_seen_user_at ON aos_device_seen (username, at);
      CREATE TABLE IF NOT EXISTS aos_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL, task_id INTEGER, source_user TEXT, source_device_id TEXT,
        source_estimated INTEGER NOT NULL DEFAULT 0, agent TEXT, worker_device TEXT NOT NULL,
        status TEXT NOT NULL, progress TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS aos_executions_ws ON aos_executions (workspace_id, started_at);
    `)
    // Usage columns (added 2026-10-20; older databases get them here).
    const have = new Set((d.prepare('PRAGMA table_info(aos_executions)').all() as Array<{ name: string }>).map(c => c.name))
    for (const [col, type] of [['model', 'TEXT'], ['turns', 'INTEGER'], ['input_tokens', 'INTEGER'], ['output_tokens', 'INTEGER'],
      ['cache_read_tokens', 'INTEGER'], ['cache_write_tokens', 'INTEGER'], ['cost_usd', 'REAL'], ['duration_ms', 'INTEGER'], ['end_reason', 'TEXT']]) {
      if (!have.has(col)) d.exec(`ALTER TABLE aos_executions ADD COLUMN ${col} ${type}`)
    }
    ready = true
  }
  return d
}

/** "Windows · Chrome", "iPhone · Safari", ... from a User-Agent header. */
export function uaLabel(ua: string | null | undefined): string {
  const s = ua || ''
  const osName = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'ismeretlen'
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl|node|undici/i.test(s) ? 'program' : 'böngésző'
  return `${osName} · ${browser}`
}

export const validDeviceId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{8,64}$/.test(id)

export function touchDevice(workspaceId: number, username: string, deviceId: string, name: string | null, ua: string | null) {
  const d = db(), t = now()
  const cleanName = name ? name.replace(/\s+/g, ' ').trim().slice(0, 40) || null : null
  d.prepare(`INSERT INTO aos_devices (id, workspace_id, username, name, ua_label, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, aos_devices.name), ua_label = excluded.ua_label, last_seen = excluded.last_seen, username = excluded.username`)
    .run(deviceId, workspaceId, username, cleanName, uaLabel(ua), t, t)
  d.prepare('INSERT INTO aos_device_seen (device_id, username, at) VALUES (?, ?, ?)').run(deviceId, username, t)
  d.prepare('DELETE FROM aos_device_seen WHERE at < ?').run(t - 7 * 86400)
}

export function renameDevice(workspaceId: number, deviceId: string, name: string) {
  db().prepare('UPDATE aos_devices SET name = ? WHERE id = ? AND workspace_id = ?').run(name.replace(/\s+/g, ' ').trim().slice(0, 40) || null, deviceId, workspaceId)
}

/** The device of `username` that was active closest before `at` (within 5 minutes). */
function deviceActiveAt(username: string, at: number): string | null {
  const row = db().prepare('SELECT device_id FROM aos_device_seen WHERE username = ? AND at BETWEEN ? AND ? ORDER BY at DESC LIMIT 1')
    .get(username, at - 300, at + 90) as { device_id: string } | undefined
  return row?.device_id ?? null
}

export function startExecution(input: {
  workspaceId: number; kind: Execution['kind']; title: string; taskId?: number | null; agent?: string | null
  sourceUser?: string | null; sourceDeviceId?: string | null; workerDevice?: string | null; progress?: string | null
}): number {
  let sourceUser = input.sourceUser ?? null
  let sourceDevice = input.sourceDeviceId ?? null
  let estimated = false
  // A board task: the source is whoever assigned it to the agent, on the device active at that moment.
  if (input.taskId && input.agent && !sourceDevice) {
    const act = db().prepare(`SELECT actor, created_at FROM activities WHERE entity_type = 'task' AND entity_id = ? AND workspace_id = ?
                              AND ((type = 'task_updated' AND data LIKE ?) OR (type = 'task_created' AND data LIKE ?))
                              ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(input.taskId, input.workspaceId, `%→ ${input.agent}%`, `%"assigned_to":"${input.agent}"%`) as { actor: string; created_at: number } | undefined
    if (act) {
      sourceUser = act.actor
      sourceDevice = deviceActiveAt(act.actor, act.created_at)
      estimated = true
    }
  }
  const t = now()
  const res = db().prepare(`INSERT INTO aos_executions (workspace_id, kind, title, task_id, source_user, source_device_id, source_estimated, agent, worker_device, status, progress, started_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`)
    .run(input.workspaceId, input.kind, input.title.slice(0, 200), input.taskId ?? null, sourceUser, sourceDevice, estimated ? 1 : 0,
      input.agent ?? null, (input.workerDevice || THIS_MACHINE).slice(0, 64), input.progress?.slice(0, 200) ?? null, t, t)
  return Number(res.lastInsertRowid)
}

/** Updates a run; returns false when it does not exist (or belongs to another agent). */
export function updateExecution(id: number, workspaceId: number, change: { status?: ExecStatus; progress?: string | null; usage?: RunUsage | null }, agent?: string): boolean {
  const row = db().prepare('SELECT agent FROM aos_executions WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as { agent: string | null } | undefined
  if (!row || (agent && row.agent !== agent)) return false
  const t = now()
  db().prepare(`UPDATE aos_executions SET status = COALESCE(?, status), progress = COALESCE(?, progress), updated_at = ?,
                finished_at = CASE WHEN ? IN ('done','failed') THEN ? ELSE finished_at END WHERE id = ?`)
    .run(change.status ?? null, change.progress?.slice(0, 200) ?? null, t, change.status ?? null, t, id)
  if (change.usage) setUsage(id, change.usage)
  return true
}

function setUsage(id: number, u: RunUsage) {
  db().prepare(`UPDATE aos_executions SET model = ?, turns = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
                cache_write_tokens = ?, cost_usd = ?, duration_ms = ?, end_reason = ? WHERE id = ?`)
    .run(u.model, u.turns, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.costUsd, u.durationMs, u.endReason, id)
}

const END_REASONS: EndReason[] = ['ok', 'max_turns', 'limit', 'auth', 'error']
const nonNeg = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0)

/** Validates a usage report from an agent runner (its own numbers, never trusted beyond sane bounds). */
export function parseUsage(v: unknown): RunUsage | null {
  if (!v || typeof v !== 'object') return null
  const u = v as Record<string, unknown>
  return {
    model: typeof u.model === 'string' ? u.model.slice(0, 80) : null,
    turns: Math.round(nonNeg(u.turns, 1000)),
    inputTokens: Math.round(nonNeg(u.inputTokens, 1e10)),
    outputTokens: Math.round(nonNeg(u.outputTokens, 1e10)),
    cacheReadTokens: Math.round(nonNeg(u.cacheReadTokens, 1e11)),
    cacheWriteTokens: Math.round(nonNeg(u.cacheWriteTokens, 1e11)),
    costUsd: nonNeg(u.costUsd, 10_000),
    durationMs: Math.round(nonNeg(u.durationMs, 86_400_000)),
    endReason: END_REASONS.includes(u.endReason as EndReason) ? u.endReason as EndReason : 'error',
  }
}

/** A finished run recorded afterwards (back-filling older run logs). Returns the new id. */
export function recordExecution(input: {
  workspaceId: number; title: string; taskId: number | null; agent: string; workerDevice: string | null
  status: ExecStatus; progress: string | null; startedAt: number; finishedAt: number; usage: RunUsage
}): number {
  const res = db().prepare(`INSERT INTO aos_executions (workspace_id, kind, title, task_id, agent, worker_device, status, progress, started_at, updated_at, finished_at)
                            VALUES (?, 'feladat', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.workspaceId, input.title.slice(0, 200), input.taskId, input.agent, (input.workerDevice || THIS_MACHINE).slice(0, 64),
      input.status, input.progress?.slice(0, 200) ?? null, input.startedAt, input.finishedAt, input.finishedAt)
  const id = Number(res.lastInsertRowid)
  setUsage(id, input.usage)
  return id
}

function usageOf(r: Record<string, any>): RunUsage | null {
  if (r.end_reason == null) return null
  return {
    model: r.model, turns: r.turns || 0, inputTokens: r.input_tokens || 0, outputTokens: r.output_tokens || 0,
    cacheReadTokens: r.cache_read_tokens || 0, cacheWriteTokens: r.cache_write_tokens || 0, costUsd: r.cost_usd || 0,
    durationMs: r.duration_ms || 0, endReason: r.end_reason,
  }
}

// ---- consumption summary (Tevékenység page, notifier) -------------------------------------------------

export interface UsageWindow { runs: number; costUsd: number; tokens: number; maxTurns: number; limits: number }

export interface UsageSummary {
  today: UsageWindow
  week: UsageWindow
  month: UsageWindow
  byAgent: Array<{ agent: string; runs: number; costUsd: number; tokens: number }>
  top: Array<{ id: number; title: string; taskId: number | null; agent: string | null; costUsd: number; turns: number; endReason: string; finishedAt: string | null }>
  /** Interactive Claude Code sessions on this machine (incl. these chats) active in the last 30 days. */
  interactive: { sessions: number; costUsd: number; tokens: number }
  alertUsd: number
}

function startOfToday(): number {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

export function usageSummary(workspaceId: number): UsageSummary {
  const d = db()
  const window = (since: number): UsageWindow => {
    const r = d.prepare(`SELECT COUNT(*) runs, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),0) tok,
                         COALESCE(SUM(end_reason = 'max_turns'),0) mt, COALESCE(SUM(end_reason = 'limit'),0) lim
                         FROM aos_executions WHERE workspace_id = ? AND end_reason IS NOT NULL AND started_at >= ?`).get(workspaceId, since) as Record<string, number>
    return { runs: r.runs, costUsd: r.cost, tokens: r.tok, maxTurns: r.mt, limits: r.lim }
  }
  const today = startOfToday()
  const month = today - 29 * 86400
  const byAgent = (d.prepare(`SELECT COALESCE(agent,'?') agent, COUNT(*) runs, COALESCE(SUM(cost_usd),0) cost,
                              COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),0) tok
                              FROM aos_executions WHERE workspace_id = ? AND end_reason IS NOT NULL AND started_at >= ?
                              GROUP BY agent ORDER BY cost DESC`).all(workspaceId, month) as Array<Record<string, any>>)
    .map(r => ({ agent: r.agent, runs: r.runs, costUsd: r.cost, tokens: r.tok }))
  const top = (d.prepare(`SELECT id, title, task_id, agent, cost_usd, turns, end_reason, finished_at FROM aos_executions
                          WHERE workspace_id = ? AND end_reason IS NOT NULL AND started_at >= ? ORDER BY cost_usd DESC LIMIT 5`).all(workspaceId, month) as Array<Record<string, any>>)
    .map(r => ({ id: r.id, title: r.title, taskId: r.task_id, agent: r.agent, costUsd: r.cost_usd || 0, turns: r.turns || 0, endReason: r.end_reason, finishedAt: iso(r.finished_at) }))
  let interactive = { sessions: 0, costUsd: 0, tokens: 0 }
  try {
    const r = d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(estimated_cost),0) cost, COALESCE(SUM(input_tokens+output_tokens),0) tok
                         FROM claude_sessions WHERE last_message_at >= ?`).get(new Date(month * 1000).toISOString()) as Record<string, number>
    interactive = { sessions: r.n, costUsd: r.cost, tokens: r.tok }
  } catch { /* the session scanner is off */ }
  return { today: window(today), week: window(today - 6 * 86400), month: window(month), byAgent, top, interactive, alertUsd: costAlertUsd() }
}

export function costAlertUsd(): number {
  const v = Number(process.env.AOS_COST_ALERT_USD)
  return Number.isFinite(v) && v > 0 ? v : 2
}

/** Runs with usage that finished after `since` (unix seconds) – the notifier's input for alerts. */
export function finishedRunsSince(workspaceId: number, since: number) {
  return (db().prepare(`SELECT id, title, task_id, agent, kind, cost_usd, turns, duration_ms, end_reason, finished_at FROM aos_executions
                        WHERE workspace_id = ? AND end_reason IS NOT NULL AND finished_at > ? ORDER BY finished_at`).all(workspaceId, since) as Array<Record<string, any>>)
    .map(r => ({ id: r.id, title: r.title, taskId: r.task_id, agent: r.agent, kind: r.kind, costUsd: r.cost_usd || 0, turns: r.turns || 0,
      durationMs: r.duration_ms || 0, endReason: r.end_reason as EndReason, finishedAt: r.finished_at as number }))
}

export function listExecutions(workspaceId: number, limit = 100): { executions: Execution[]; devices: Array<{ id: string; name: string | null; uaLabel: string; lastSeen: string }> } {
  const d = db()
  const devices = d.prepare('SELECT id, name, ua_label, last_seen FROM aos_devices WHERE workspace_id = ? ORDER BY last_seen DESC').all(workspaceId) as Array<Record<string, any>>
  const byId = new Map(devices.map(x => [x.id, x]))
  const rows = d.prepare('SELECT * FROM aos_executions WHERE workspace_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(workspaceId, limit) as Array<Record<string, any>>
  return {
    executions: rows.map(r => {
      const dev = r.source_device_id ? byId.get(r.source_device_id) : undefined
      return {
        id: r.id, kind: r.kind, title: r.title, taskId: r.task_id, sourceUser: r.source_user,
        sourceDevice: dev ? (dev.name ? `${dev.name} (${dev.ua_label})` : dev.ua_label) : null,
        sourceEstimated: !!r.source_estimated, agent: r.agent, workerDevice: r.worker_device, status: r.status,
        progress: r.progress, startedAt: iso(r.started_at)!, updatedAt: iso(r.updated_at)!, finishedAt: iso(r.finished_at),
        usage: usageOf(r),
      }
    }),
    devices: devices.map(x => ({ id: x.id, name: x.name, uaLabel: x.ua_label, lastSeen: iso(x.last_seen)! })),
  }
}
