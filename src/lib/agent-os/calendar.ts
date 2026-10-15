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
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.freebusy',
]

export interface PlanBlock {
  id: string
  title: string
  description: string
  start: string // ISO 8601
  end: string
  source: 'agent' | 'user'
  createdBy: string
  link?: string
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

function clientCreds() {
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
  writeGoogle({ ...readGoogle(), refresh_token: json.refresh_token })
  cachedToken = { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 }
  await ensureGoogleCalendar()
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
    start: new Date(e.start?.dateTime || e.start?.date).toISOString(),
    end: new Date(e.end?.dateTime || e.end?.date).toISOString(),
    source: priv.aosSource === 'agent' ? 'agent' : 'user',
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

export function calendarProvider() {
  return (process.env.AOS_CALENDAR_PROVIDER || 'local') === 'google' ? google : local
}
