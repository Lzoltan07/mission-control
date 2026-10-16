/**
 * Agent OS (fork addition): status data for the "Funkciók" dashboard and the "Ágensfigyelő" widget.
 * Read-only queries on the Mission Control database plus a few local checks (vault files, runner
 * lock files, voice servers). Nothing here writes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDatabase } from '@/lib/db'
import { calendarProvider } from '@/lib/agent-os/calendar'
import { FUNCTIONS, type AgentWatch, type FunctionStatus } from '@/lib/agent-os/functions-catalog'

const AOS_HOME = process.env.AOS_HOME || path.join(os.homedir(), '.agent-os')
const iso = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString() : undefined)
const num = (n: number) => n.toLocaleString('hu-HU')
const DAY = 86400

type Row = Record<string, any>

function one(sql: string, ...args: unknown[]): Row {
  try { return (getDatabase().prepare(sql).get(...args) as Row) || {} } catch { return {} }
}
function all(sql: string, ...args: unknown[]): Row[] {
  try { return getDatabase().prepare(sql).all(...args) as Row[] } catch { return [] }
}

function vaultStats(): { files: number; latest: number } | null {
  const root = process.env.OPENCLAW_MEMORY_DIR
  if (!root || !fs.existsSync(root)) return null
  let files = 0, latest = 0, seen = 0
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++seen > 20000) return
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) { files++; latest = Math.max(latest, fs.statSync(p).mtimeMs) }
    }
  }
  try { walk(root) } catch {}
  return { files, latest }
}

async function reachable(url: string | undefined): Promise<boolean> {
  if (!url) return false
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.status < 500
  } catch { return false }
}

function isRunning(agent: string): boolean {
  return fs.existsSync(path.join(AOS_HOME, 'agents', agent, '.run.lock'))
}

export async function functionStatuses(workspaceId: number, localMode: boolean): Promise<FunctionStatus[]> {
  const now = Math.floor(Date.now() / 1000)
  const out = new Map<string, FunctionStatus>()
  const set = (s: FunctionStatus) => out.set(s.id, s)

  // Tasks (recurring templates excluded)
  const taskWhere = "workspace_id = ? AND json_extract(metadata, '$.recurrence.cron_expr') IS NULL"
  const byStatus = Object.fromEntries(all(`SELECT status, COUNT(*) c FROM tasks WHERE ${taskWhere} GROUP BY status`, workspaceId).map(r => [r.status, r.c]))
  const total = Object.values(byStatus).reduce((a: number, b) => a + Number(b), 0)
  const done = Number(byStatus.done || 0)
  const open = total - done - Number(byStatus.failed || 0)
  const lastTask = one(`SELECT MAX(updated_at) t FROM tasks WHERE ${taskWhere}`, workspaceId).t
  const label: Record<string, string> = { inbox: 'Bejövő', backlog: 'Várólista', assigned: 'Kiosztva', in_progress: 'Folyamatban', review: 'Ellenőrzés', quality_review: 'Minőségellenőrzés', done: 'Kész', failed: 'Hibás' }
  set({
    id: 'tasks', state: byStatus.failed ? 'warn' : open > 0 ? 'ok' : 'idle',
    summary: `${num(open)} nyitott, ${num(done)} kész`, progress: total ? done / total : undefined, lastChange: iso(lastTask),
    details: Object.entries(byStatus).map(([k, v]) => ({ label: label[k] || k, value: num(Number(v)) })),
  })

  // Agents
  const agents = all('SELECT name FROM agents WHERE workspace_id = ? AND hidden = 0', workspaceId)
  const running = agents.filter(a => isRunning(a.name)).map(a => a.name)
  const lastAgentAct = one("SELECT MAX(created_at) t FROM activities WHERE workspace_id = ? AND actor LIKE 'agent:%'", workspaceId).t
  const expiring = one('SELECT COUNT(*) c FROM agent_api_keys WHERE workspace_id = ? AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?', workspaceId, now + 14 * DAY).c || 0
  set({
    id: 'agents', state: expiring ? 'warn' : running.length ? 'ok' : 'idle',
    summary: running.length ? `${running.length} dolgozik most` : `${agents.length} ágens, egyik sem fut`, lastChange: iso(lastAgentAct),
    details: [
      { label: 'Ágensek', value: num(agents.length) },
      { label: 'Most fut', value: running.join(', ') || '–' },
      { label: '14 napon belül lejáró kulcs', value: num(expiring) },
    ],
  })

  // Overview
  set({ id: 'overview', state: 'ok', summary: `${num(open)} nyitott feladat, ${running.length} futó ágens`, lastChange: iso(Math.max(lastTask || 0, lastAgentAct || 0) || null), details: [] })

  // Activity
  const act = one('SELECT COUNT(*) c, MAX(created_at) t FROM activities WHERE workspace_id = ? AND created_at > ?', workspaceId, now - DAY)
  const lastAct = one('SELECT created_at t, description d FROM activities WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', workspaceId)
  set({ id: 'activity', state: act.c ? 'ok' : 'idle', summary: `${num(act.c || 0)} esemény az elmúlt 24 órában`, lastChange: iso(lastAct.t),
    details: lastAct.d ? [{ label: 'Utolsó', value: String(lastAct.d).slice(0, 120) }] : [] })

  // Chat
  const chat = one('SELECT COUNT(*) c, MAX(created_at) t FROM messages WHERE workspace_id = ?', workspaceId)
  set({ id: 'chat', state: chat.c ? 'ok' : 'idle', summary: chat.c ? `${num(chat.c)} üzenet` : 'Még nincs üzenet', lastChange: iso(chat.t), details: [] })

  // Skills
  const skills = one('SELECT COUNT(*) c, MAX(updated_at) t FROM skills', )
  set({ id: 'skills', state: skills.c ? 'ok' : 'idle', summary: `${num(skills.c || 0)} skill`, lastChange: iso(typeof skills.t === 'number' ? skills.t : null), details: [] })

  // Memory (vault)
  const vault = vaultStats()
  set(vault
    ? { id: 'memory', state: 'ok', summary: `${num(vault.files)} jegyzet a vaultban`, lastChange: vault.latest ? new Date(vault.latest).toISOString() : undefined, details: [{ label: 'Utolsó mentés', value: vault.latest ? new Date(vault.latest).toLocaleString('hu-HU') : '–' }] }
    : { id: 'memory', state: 'off', summary: 'Nincs vault beállítva (OPENCLAW_MEMORY_DIR)', details: [] })

  // Weekly plan
  try {
    const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 7)
    const week = await Promise.race([
      calendarProvider().week(monday.toISOString(), sunday.toISOString()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    const agentBlocks = week.blocks.filter(b => b.source === 'agent').length
    set({ id: 'heti-terv', state: week.connected ? 'ok' : 'warn', summary: `${week.blocks.length} blokk a héten`,
      details: [
        { label: 'Naptár', value: `${week.calendarName} (${week.provider === 'google' ? 'Google' : 'helyi'})` },
        { label: 'Összekötve', value: week.connected ? 'igen' : 'nem' },
        { label: 'Ágens / saját blokk', value: `${agentBlocks} / ${week.blocks.length - agentBlocks}` },
        { label: 'Foglalt idősávok', value: num(week.busy.length) },
      ] })
  } catch {
    set({ id: 'heti-terv', state: 'warn', summary: 'A naptár most nem érhető el', details: [] })
  }

  // Voice
  const wake = process.env.AOS_WAKE_URL || 'http://127.0.0.1:8177/inference'
  const whisper = process.env.AOS_WHISPER_URL || 'http://127.0.0.1:8178/inference'
  const piper = (process.env.AOS_PIPER_URL || 'http://127.0.0.1:8179').replace(/\/+$/, '') + '/voices'
  const origin = (u: string) => { try { return new URL(u).origin } catch { return undefined } }
  const [wakeOk, whisperOk, piperOk] = await Promise.all([reachable(origin(wake)), reachable(origin(whisper)), reachable(piper)])
  const voiceUp = [wakeOk, whisperOk, piperOk].filter(Boolean).length
  set({ id: 'hang', state: voiceUp === 3 ? 'ok' : voiceUp ? 'warn' : 'off', summary: voiceUp === 3 ? 'Minden hangszerver fut' : `${voiceUp}/3 hangszerver fut`,
    details: [
      { label: 'Ébresztőszó (Jarvis)', value: wakeOk ? 'fut' : 'nem fut' },
      { label: 'Parancsok leírása', value: whisperOk ? 'fut' : 'nem fut' },
      { label: 'Felolvasás (Piper)', value: piperOk ? 'fut' : 'nem fut' },
    ] })

  // Cost
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const cost = one('SELECT COALESCE(SUM(cost_usd),0) usd, COALESCE(SUM(input_tokens+output_tokens),0) tok, MAX(created_at) t FROM token_usage WHERE workspace_id = ? AND created_at >= ?', workspaceId, Math.floor(today.getTime() / 1000) - 29 * DAY)
  set({ id: 'cost-tracker', state: cost.tok ? 'ok' : 'idle', summary: `${Number(cost.usd || 0).toFixed(2)} USD az elmúlt 30 napban`, lastChange: iso(cost.t),
    details: [{ label: 'Token', value: num(Number(cost.tok || 0)) }] })

  // Webhooks, alerts, GitHub
  const wh = one('SELECT COUNT(*) c, SUM(enabled) e, MAX(last_fired_at) t, SUM(consecutive_failures > 0) f FROM webhooks WHERE workspace_id = ?', workspaceId)
  set({ id: 'webhooks', state: wh.f ? 'warn' : wh.e ? 'ok' : 'idle', summary: wh.c ? `${wh.e || 0}/${wh.c} bekapcsolva` : 'Nincs webhook', lastChange: iso(wh.t), details: wh.f ? [{ label: 'Hibázó', value: num(wh.f) }] : [] })
  const al = one('SELECT COUNT(*) c, SUM(enabled) e, MAX(last_triggered_at) t FROM alert_rules WHERE workspace_id = ?', workspaceId)
  set({ id: 'alerts', state: al.e ? 'ok' : 'idle', summary: al.c ? `${al.e || 0}/${al.c} szabály aktív` : 'Nincs szabály', lastChange: iso(al.t), details: [] })
  const gh = one('SELECT COUNT(*) c, MAX(last_synced_at) t, SUM(status = \'error\') e FROM github_syncs WHERE workspace_id = ?', workspaceId)
  set({ id: 'github', state: gh.e ? 'warn' : gh.c ? 'ok' : 'idle', summary: gh.c ? `${gh.c} szinkron` : 'Nincs GitHub-szinkron', lastChange: iso(gh.t), details: [] })

  // Security, users, audit
  const sec = one("SELECT COUNT(*) c, SUM(severity IN ('high','critical')) h, MAX(created_at) t FROM security_events WHERE created_at > ?", now - DAY)
  set({ id: 'security', state: sec.h ? 'warn' : 'ok', summary: `${num(sec.c || 0)} esemény 24 órában`, lastChange: iso(sec.t), details: [{ label: 'Magas/kritikus', value: num(sec.h || 0) }] })
  const users = one('SELECT COUNT(*) c, MAX(last_login_at) t FROM users')
  set({ id: 'users', state: 'ok', summary: `${num(users.c || 0)} felhasználó`, lastChange: iso(users.t), details: [{ label: 'Utolsó belépés', value: users.t ? new Date(users.t * 1000).toLocaleString('hu-HU') : '–' }] })
  const audit = one('SELECT COUNT(*) c, MAX(created_at) t FROM audit_log')
  set({ id: 'audit', state: 'ok', summary: `${num(audit.c || 0)} bejegyzés`, lastChange: iso(audit.t), details: [] })

  // Integrations: progress of the Agent OS integration tasks (tag "integracio")
  const integ = all(`SELECT status, title FROM tasks WHERE ${taskWhere} AND EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE value = 'integracio')`, workspaceId)
  const integDone = integ.filter(t => t.status === 'done').length
  set({ id: 'integrations', state: integ.length ? 'ok' : 'idle', summary: integ.length ? `${integDone}/${integ.length} integráció kész` : 'Nincs integrációs feladat',
    progress: integ.length ? integDone / integ.length : undefined,
    details: integ.filter(t => t.status !== 'done').slice(0, 6).map(t => ({ label: label[t.status] || t.status, value: String(t.title).replace(/^Integráció: /, '') })) })

  // Everything else: available, no tracked state
  for (const f of FUNCTIONS) {
    if (out.has(f.id)) continue
    if (f.gatewayOnly && localMode) set({ id: f.id, state: 'off', summary: 'Gateway nélkül nem elérhető (4. fázis)', details: [] })
    else set({ id: f.id, state: 'idle', summary: 'Elérhető', details: [] })
  }
  return FUNCTIONS.map(f => out.get(f.id)!)
}

export function agentNames(workspaceId: number): Array<{ name: string; role: string | null }> {
  return all('SELECT name, role FROM agents WHERE workspace_id = ? AND hidden = 0 ORDER BY name', workspaceId).map(r => ({ name: r.name, role: r.role }))
}

export function agentWatch(workspaceId: number, names: string[]): AgentWatch[] {
  return names.map(name => {
    const agent = one('SELECT name, role FROM agents WHERE workspace_id = ? AND name = ?', workspaceId, name)
    const current = one("SELECT id, title, status FROM tasks WHERE workspace_id = ? AND assigned_to = ? AND status NOT IN ('done','failed','inbox','backlog') ORDER BY updated_at DESC LIMIT 1", workspaceId, name)
    const counts = one("SELECT COUNT(*) total, SUM(status = 'done') done FROM tasks WHERE workspace_id = ? AND assigned_to = ?", workspaceId, name)
    const last = one('SELECT created_at t, description d FROM activities WHERE workspace_id = ? AND (actor = ? OR actor = ?) ORDER BY created_at DESC, id DESC LIMIT 1', workspaceId, `agent:${name}`, name)
    const key = one('SELECT MIN(k.expires_at) e FROM agent_api_keys k JOIN agents a ON a.id = k.agent_id WHERE a.name = ? AND a.workspace_id = ? AND k.revoked_at IS NULL', name, workspaceId)
    return {
      name,
      role: agent.role ?? null,
      running: isRunning(name),
      currentTask: current.id ? { id: current.id, title: current.title, status: current.status } : null,
      done: Number(counts.done || 0),
      total: Number(counts.total || 0),
      lastActivity: last.t ? { at: iso(last.t)!, text: String(last.d || '') } : null,
      keyExpires: iso(key.e) ?? null,
    }
  })
}
