/**
 * Agent OS – weekly plan calendar (fork addition, not upstream).
 *
 * The plan lives in ONE dedicated calendar ("Agent OS – heti terv"). Two providers:
 *   - local  (default): JSON file in the data dir; for trials and offline use.
 *   - google: a secondary Google calendar created by this app. OAuth scopes are the narrowest
 *             available: calendar.app.created (only calendars this app created) and
 *             calendar.freebusy (busy slots of the user's other calendars, no details).
 *
 * Env: AOS_CALENDAR_PROVIDER=local|google, AOS_GCAL_CLIENT_ID, AOS_GCAL_CLIENT_SECRET,
 *      AOS_GCAL_BUSY_CALENDARS (extra calendar ids for free/busy, comma-separated; 'primary' is always used),
 *      AOS_TIMEZONE (default Europe/Budapest)
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '@/lib/config'

export const CALENDAR_NAME = 'Agent OS – heti terv'
export const TIMEZONE = process.env.AOS_TIMEZONE || 'Europe/Budapest'
// openid + email only identify which Google account consented, so the callback can reject any
// account other than AOS_GCAL_ALLOWED_EMAIL (the app is in production, but single-user).
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.freebusy',
]

export interface PlanBlock {
  id: string
  title: string
  description: string
  start: string // ISO 8601
  end: string
  source: 'agent' | 'user' | 'sync'
  createdBy: string
  link?: string
  allDay?: boolean
}

export interface BusySlot { start: string; end: string }

export interface WeekView {
  provider: 'local' | 'google'
  connected: boolean
  calendarName: string
  timezone: string
  busy: BusySlot[]
  blocks: PlanBlock[]
}

export interface BlockInput { title: string; description?: string; start: string; end: string }

export class CalendarError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateBlockInput(input: unknown, partial = false): Partial<BlockInput> {
  if (!input || typeof input !== 'object') throw new CalendarError('Invalid body')
  const b = input as Record<string, unknown>
  const out: Partial<BlockInput> = {}
  if (b.title !== undefined || !partial) {
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw new CalendarError('title: 1–200 characters')
    out.title = b.title.trim()
  }
  if (b.description !== undefined) {
    if (typeof b.description !== 'string' || b.description.length > 4000) throw new CalendarError('description: max 4000 characters')
    out.description = b.description
  }
  for (const k of ['start', 'end'] as const) {
    if (b[k] !== undefined || !partial) {
      if (typeof b[k] !== 'string' || Number.isNaN(Date.parse(b[k] as string))) throw new CalendarError(`${k}: ISO 8601 date-time required`)
      out[k] = new Date(b[k] as string).toISOString()
    }
  }
  if (out.start && out.end) {
    const ms = Date.parse(out.end) - Date.parse(out.start)
    if (ms <= 0) throw new CalendarError('end must be after start')
    if (ms > 12 * 3600_000) throw new CalendarError('a block can be at most 12 hours')
  }
  return out
}

export function parseRange(fromRaw: string | null, toRaw: string | null): { from: string; to: string } {
  if (!fromRaw || !toRaw || Number.isNaN(Date.parse(fromRaw)) || Number.isNaN(Date.parse(toRaw))) {
    throw new CalendarError('from and to (ISO 8601) are required')
  }
  const from = new Date(fromRaw), to = new Date(toRaw)
  if (to <= from || to.getTime() - from.getTime() > 31 * 86400_000) throw new CalendarError('range must be 1–31 days')
  return { from: from.toISOString(), to: to.toISOString() }
}

// ---------------------------------------------------------------------------
// Local provider (JSON file)
// ---------------------------------------------------------------------------

const localFile = () => path.join(config.dataDir, 'agent-os-calendar.json')

function readLocal(): { blocks: PlanBlock[]; busy: BusySlot[] } {
  try {
    const data = JSON.parse(fs.readFileSync(localFile(), 'utf8'))
    return { blocks: data.blocks || [], busy: data.busy || [] }
  } catch {
    return { blocks: [], busy: [] }
  }
}

function writeLocal(data: { blocks: PlanBlock[]; busy: BusySlot[] }) {
  fs.writeFileSync(localFile(), JSON.stringify(data, null, 2), { mode: 0o600 })
}

const overlaps = (s: string, e: string, from: string, to: string) => Date.parse(s) < Date.parse(to) && Date.parse(e) > Date.parse(from)

const local = {
  async week(from: string, to: string): Promise<WeekView> {
    const d = readLocal()
    return {
      provider: 'local', connected: true, calendarName: CALENDAR_NAME, timezone: TIMEZONE,
      busy: d.busy.filter(b => overlaps(b.start, b.end, from, to)),
      blocks: d.blocks.filter(b => overlaps(b.start, b.end, from, to)).sort((a, b) => a.start.localeCompare(b.start)),
    }
  },
  async create(input: BlockInput, source: 'agent' | 'user', createdBy: string): Promise<PlanBlock> {
    const d = readLocal()
    const block: PlanBlock = { id: crypto.randomUUID(), title: input.title, description: input.description || '', start: input.start, end: input.end, source, createdBy }
    d.blocks.push(block)
    writeLocal(d)
    return block
  },
  async update(id: string, patch: Partial<BlockInput>): Promise<PlanBlock> {
    const d = readLocal()
    const block = d.blocks.find(b => b.id === id)
    if (!block) throw new CalendarError('Block not found', 404)
    Object.assign(block, patch)
    if (Date.parse(block.end) <= Date.parse(block.start)) throw new CalendarError('end must be after start')
    writeLocal(d)
    return block
  },
  async remove(id: string): Promise<void> {
    const d = readLocal()
    const next = d.blocks.filter(b => b.id !== id)
    if (next.length === d.blocks.length) throw new CalendarError('Block not found', 404)
    writeLocal({ ...d, blocks: next })
  },
}

// ---------------------------------------------------------------------------
// Google provider
// ---------------------------------------------------------------------------

const googleFile = () => path.join(config.dataDir, 'agent-os-gcal.json')
interface GoogleState { refresh_token?: string; calendar_id?: string }
let cachedToken: { value: string; expires: number } | null = null

function readGoogle(): GoogleState {
  try { return JSON.parse(fs.readFileSync(googleFile(), 'utf8')) } catch { return {} }
}
function writeGoogle(state: GoogleState) {
  fs.writeFileSync(googleFile(), JSON.stringify(state, null, 2), { mode: 0o600 })
}

export function clientCreds() {
  const id = process.env.AOS_GCAL_CLIENT_ID, secret = process.env.AOS_GCAL_CLIENT_SECRET
  if (!id || !secret) throw new CalendarError('AOS_GCAL_CLIENT_ID / AOS_GCAL_CLIENT_SECRET not set', 500)
  return { id, secret }
}

export function googleAuthUrl(redirectUri: string, state: string): string {
  const { id } = clientCreds()
  const q = new URLSearchParams({
    client_id: id, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
}

export async function googleExchangeCode(code: string, redirectUri: string): Promise<void> {
  const { id, secret } = clientCreds()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })
  const json = await res.json()
  if (!res.ok || !json.refresh_token) throw new CalendarError(`Google token exchange failed: ${json.error || res.status}`, 502)

  // Single-user lock: only the configured Google account may connect. The id_token comes straight
  // from Google's token endpoint over TLS, so its claims can be trusted without a signature check.
  const allowed = (process.env.AOS_GCAL_ALLOWED_EMAIL || '').trim().toLowerCase()
  if (!allowed) {
    await revokeGoogleToken(json.refresh_token)
    throw new CalendarError('AOS_GCAL_ALLOWED_EMAIL is not set; refusing to connect', 500)
  }
  const claims = decodeJwtPayload(json.id_token)
  const email = String(claims.email || '').toLowerCase()
  if (!claims.email_verified || email !== allowed) {
    await revokeGoogleToken(json.refresh_token)
    throw new CalendarError('This Google account is not allowed to connect to Agent OS', 403)
  }

  writeGoogle({ ...readGoogle(), refresh_token: json.refresh_token })
  cachedToken = { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 }
  await ensureGoogleCalendar()
}

export function decodeJwtPayload(jwt: unknown): Record<string, unknown> {
  if (typeof jwt !== 'string' || jwt.split('.').length !== 3) return {}
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    })
  } catch {
    // best effort: the token is never stored either way
  }
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value
  const { refresh_token } = readGoogle()
  if (!refresh_token) throw new CalendarError('Google Calendar is not connected', 409)
  const { id, secret } = clientCreds()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token, client_id: id, client_secret: secret, grant_type: 'refresh_token' }),
  })
  const json = await res.json()
  if (!res.ok) throw new CalendarError(`Google token refresh failed: ${json.error || res.status}`, 502)
  cachedToken = { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 }
  return cachedToken.value
}

async function gapi(method: string, url: string, body?: unknown) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${url}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return null
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new CalendarError(`Google Calendar: ${json.error?.message || res.status}`, res.status === 404 ? 404 : 502)
  return json
}

async function ensureGoogleCalendar(): Promise<string> {
  const state = readGoogle()
  if (state.calendar_id) return state.calendar_id
  const cal = await gapi('POST', '/calendars', { summary: CALENDAR_NAME, timeZone: TIMEZONE, description: 'Az Agent OS heti terve. Szerkeszthető; az ágens csak új blokkot ad hozzá.' })
  writeGoogle({ ...readGoogle(), calendar_id: cal.id })
  return cal.id
}

function fromGoogleEvent(e: any): PlanBlock {
  const priv = e.extendedProperties?.private || {}
  return {
    id: e.id,
    title: e.summary || '(cím nélkül)',
    description: e.description || '',
    // All-day events carry a date: read it as local midnight (not UTC), so it lands on the right day.
    start: (e.start?.dateTime ? new Date(e.start.dateTime) : new Date(`${e.start?.date}T00:00:00`)).toISOString(),
    end: (e.end?.dateTime ? new Date(e.end.dateTime) : new Date(`${e.end?.date}T00:00:00`)).toISOString(),
    allDay: !e.start?.dateTime,
    source: priv.aosSource === 'agent' ? 'agent' : priv.aosSource === 'sync' ? 'sync' : 'user',
    createdBy: priv.aosCreatedBy || 'google',
    link: e.htmlLink,
  }
}

const google = {
  async week(from: string, to: string): Promise<WeekView> {
    const base = { provider: 'google' as const, calendarName: CALENDAR_NAME, timezone: TIMEZONE }
    if (!readGoogle().refresh_token) return { ...base, connected: false, busy: [], blocks: [] }
    const calId = await ensureGoogleCalendar()
    const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' })
    const events = await gapi('GET', `/calendars/${encodeURIComponent(calId)}/events?${q}`)
    const busyIds = ['primary', ...(process.env.AOS_GCAL_BUSY_CALENDARS || '').split(',').map(s => s.trim()).filter(Boolean)]
    const fb = await gapi('POST', '/freeBusy', { timeMin: from, timeMax: to, timeZone: TIMEZONE, items: busyIds.map(id => ({ id })) })
    const busy: BusySlot[] = Object.values(fb.calendars || {}).flatMap((c: any) => c.busy || [])
    return { ...base, connected: true, busy, blocks: (events.items || []).filter((e: any) => e.status !== 'cancelled').map(fromGoogleEvent) }
  },
  async create(input: BlockInput, source: 'agent' | 'user', createdBy: string): Promise<PlanBlock> {
    const calId = await ensureGoogleCalendar()
    const e = await gapi('POST', `/calendars/${encodeURIComponent(calId)}/events`, {
      summary: input.title, description: input.description || '',
      start: { dateTime: input.start, timeZone: TIMEZONE }, end: { dateTime: input.end, timeZone: TIMEZONE },
      extendedProperties: { private: { aosSource: source, aosCreatedBy: createdBy } },
    })
    return fromGoogleEvent(e)
  },
  async update(id: string, patch: Partial<BlockInput>): Promise<PlanBlock> {
    const calId = await ensureGoogleCalendar()
    const body: Record<string, unknown> = {}
    if (patch.title !== undefined) body.summary = patch.title
    if (patch.description !== undefined) body.description = patch.description
    if (patch.start) body.start = { dateTime: patch.start, timeZone: TIMEZONE }
    if (patch.end) body.end = { dateTime: patch.end, timeZone: TIMEZONE }
    return fromGoogleEvent(await gapi('PATCH', `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`, body))
  },
  async remove(id: string): Promise<void> {
    const calId = await ensureGoogleCalendar()
    await gapi('DELETE', `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`)
  },
}

// ---------------------------------------------------------------------------
// Sync from other calendars (uni-sync.ts): only blocks marked aosSource=sync are touched
// ---------------------------------------------------------------------------

export interface SyncItem { syncId: string; title: string; description: string; start: string; end: string; allDay: boolean }

/** Makes the sync blocks in [from, to) match `items`: creates, updates, removes – own blocks only. */
export async function syncPlanBlocks(items: SyncItem[], from: string, to: string) {
  if (!readGoogle().refresh_token) throw new CalendarError('Google Calendar is not connected', 409)
  const calId = await ensureGoogleCalendar()
  const base = `/calendars/${encodeURIComponent(calId)}/events`
  const existing: any[] = []
  let pageToken = ''
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', maxResults: '250', privateExtendedProperty: 'aosSource=sync', ...(pageToken ? { pageToken } : {}) })
    const r = await gapi('GET', `${base}?${q}`)
    existing.push(...(r.items || []).filter((e: any) => e.status !== 'cancelled'))
    if (!r.nextPageToken) break
    pageToken = r.nextPageToken
  }
  const bySyncId = new Map(existing.map(e => [e.extendedProperties?.private?.aosSyncId, e]))
  const dateOnly = (iso: string) => iso.slice(0, 10)
  const body = (it: SyncItem) => ({
    summary: it.title, description: it.description,
    start: it.allDay ? { date: dateOnly(it.start) } : { dateTime: it.start, timeZone: TIMEZONE },
    end: it.allDay ? { date: dateOnly(it.end) } : { dateTime: it.end, timeZone: TIMEZONE },
    transparency: it.allDay ? 'transparent' : 'opaque',
    extendedProperties: { private: { aosSource: 'sync', aosCreatedBy: 'egyetem-szinkron', aosSyncId: it.syncId } },
  })
  let created = 0, updated = 0, removed = 0
  const wanted = new Set<string>()
  for (const it of items) {
    wanted.add(it.syncId)
    const cur = bySyncId.get(it.syncId)
    if (!cur) { await gapi('POST', base, body(it)); created++; continue }
    const curStart = cur.start?.dateTime ? new Date(cur.start.dateTime).toISOString() : cur.start?.date
    const curEnd = cur.end?.dateTime ? new Date(cur.end.dateTime).toISOString() : cur.end?.date
    const wantStart = it.allDay ? dateOnly(it.start) : new Date(it.start).toISOString()
    const wantEnd = it.allDay ? dateOnly(it.end) : new Date(it.end).toISOString()
    if (cur.summary !== it.title || (cur.description || '') !== it.description || curStart !== wantStart || curEnd !== wantEnd) {
      await gapi('PATCH', `${base}/${encodeURIComponent(cur.id)}`, body(it)); updated++
    }
  }
  for (const e of existing) {
    if (!wanted.has(e.extendedProperties?.private?.aosSyncId)) { await gapi('DELETE', `${base}/${encodeURIComponent(e.id)}`); removed++ }
  }
  return { created, updated, removed }
}

export function calendarProvider() {
  return (process.env.AOS_CALENDAR_PROVIDER || 'local') === 'google' ? google : local
}
