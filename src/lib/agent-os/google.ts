/**
 * Agent OS – Google account (fork addition, not upstream): Gmail, Drive (+ Docs/Sheets/Slides), all
 * calendars, Contacts and Tasks for the agents, with one refresh token.
 *
 * Decision (2026-10-17): agents may READ everything and CREATE new items (Gmail drafts, new Drive
 * files in the "Agent OS" folder, new tasks). Sending, changing and deleting happen only after the
 * owner's yes: an agent can only *request* that a draft be sent; the request waits in the Google tab
 * until the owner approves it, and the server then sends exactly that draft (content hash checked).
 * There is no API here for modifying or deleting existing mail, files, events, contacts or tasks.
 *
 * Writing to the weekly plan calendar stays with the separate calendar connection (calendar.ts).
 * Same OAuth client and single-user lock as the calendar (AOS_GCAL_*). Gmail/Drive are restricted
 * scopes and calendar/contacts/tasks sensitive ones: without Google verification the consent screen
 * shows an "unverified app" warning, which the owner can pass for personal use.
 *
 * Env: AOS_GCAL_CLIENT_ID, AOS_GCAL_CLIENT_SECRET, AOS_GCAL_ALLOWED_EMAIL (shared with the calendar),
 *      AOS_GOOGLE_AGENTS (agents allowed to use these tools), AOS_TIMEZONE.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { config } from '@/lib/config'
import { CalendarError, clientCreds, decodeJwtPayload, revokeGoogleToken } from '@/lib/agent-os/calendar'

export const DRIVE_FOLDER = 'Agent OS'
const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/tasks',
]
const TZ = process.env.AOS_TIMEZONE || 'Europe/Budapest'

export class GoogleError extends CalendarError {}

export interface SendRequest {
  id: string
  draftId: string
  to: string
  subject: string
  preview: string
  hash: string
  requestedBy: string
  requestedAt: string
  status: 'pending' | 'sent' | 'rejected' | 'failed' | 'gone'
  decidedAt?: string
  note?: string
}
interface GoogleState { refresh_token?: string; email?: string; scopes?: string[]; folder_id?: string; requests?: SendRequest[] }

const stateFile = () => path.join(config.dataDir, 'agent-os-google.json')
function readState(): GoogleState {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { return {} }
}
function writeState(s: GoogleState) {
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2), { mode: 0o600 })
}

export function googleAgents(): string[] {
  return (process.env.AOS_GOOGLE_AGENTS || '').split(',').map(s => s.trim()).filter(Boolean)
}

// --- OAuth ----------------------------------------------------------------------------------------------
export function workspaceAuthUrl(redirectUri: string, state: string): string {
  const { id } = clientCreds()
  const q = new URLSearchParams({
    client_id: id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
}

let cachedToken: { value: string; expires: number } | null = null

export async function workspaceExchangeCode(code: string, redirectUri: string): Promise<void> {
  const { id, secret } = clientCreds()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })
  const json = await res.json()
  if (!res.ok || !json.refresh_token) throw new GoogleError(`Google token exchange failed: ${json.error || res.status}`, 502)
  const allowed = (process.env.AOS_GCAL_ALLOWED_EMAIL || '').trim().toLowerCase()
  const claims = decodeJwtPayload(json.id_token)
  const email = String(claims.email || '').toLowerCase()
  if (!allowed || !claims.email_verified || email !== allowed) {
    await revokeGoogleToken(json.refresh_token)
    throw new GoogleError('This Google account is not allowed to connect to Agent OS', 403)
  }
  writeState({ ...readState(), refresh_token: json.refresh_token, email, scopes: String(json.scope || '').split(' ') })
  cachedToken = { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 }
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value
  const { refresh_token } = readState()
  if (!refresh_token) throw new GoogleError('The Google account is not connected (Google tab)', 409)
  const { id, secret } = clientCreds()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token, client_id: id, client_secret: secret, grant_type: 'refresh_token' }),
  })
  const json = await res.json()
  if (!res.ok) throw new GoogleError(`Google token refresh failed: ${json.error || res.status}`, 502)
  cachedToken = { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 }
  return json.access_token
}

async function gapi(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init, headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = text.slice(0, 200)
    try { msg = JSON.parse(text).error?.message || msg } catch {}
    if (res.status === 403 && /insufficient|scope/i.test(msg)) msg = 'Ehhez nincs engedély – kösd össze újra a Google-fiókot a Google fülön, és pipáld be ezt a hozzáférést is.'
    throw new GoogleError(`Google: HTTP ${res.status} ${msg}`.trim(), res.status === 404 ? 404 : res.status === 403 ? 403 : 502)
  }
  return res
}
const getJson = async (url: string) => (await gapi(url)).json()

export function googleStatus() {
  const s = readState()
  const has = (scope: string) => (s.scopes || []).some(x => x.endsWith(scope))
  return {
    connected: !!s.refresh_token,
    email: s.email || null,
    services: {
      gmail: has('gmail.readonly'), gmailDraft: has('gmail.compose'), drive: has('drive.readonly'), driveWrite: has('drive.file'),
      calendar: has('calendar.readonly'), contacts: has('contacts.readonly'), tasks: has('/tasks'),
    },
    folderUrl: s.folder_id ? `https://drive.google.com/drive/folders/${s.folder_id}` : null,
    agents: googleAgents(),
    requests: (s.requests || []).slice(-50).reverse(),
  }
}

// --- Gmail ------------------------------------------------------------------------------------------------
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const header = (msg: any, name: string) => (msg.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
const htmlToText = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

function bodyText(part: any): { plain: string; html: string } {
  let plain = '', html = ''
  const walk = (p: any) => {
    if (!p) return
    if (p.mimeType === 'text/plain' && p.body?.data) plain += b64(p.body.data)
    else if (p.mimeType === 'text/html' && p.body?.data) html += b64(p.body.data)
    for (const c of p.parts || []) walk(c)
  }
  walk(part)
  return { plain, html }
}

export async function gmailSearch(query: string, limit = 10) {
  const q = query.trim().slice(0, 300)
  const list = await getJson(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(Math.min(Math.max(limit, 1), 25)) })}`)
  const ids: string[] = (list.messages || []).map((m: any) => m.id)
  const out = []
  for (const id of ids) {
    const m = await getJson(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)
    out.push({ id, threadId: m.threadId, from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet, unread: (m.labelIds || []).includes('UNREAD') })
  }
  return out
}

export async function gmailRead(id: string, maxChars = 15000) {
  if (!/^[A-Za-z0-9]{6,40}$/.test(id)) throw new GoogleError('Érvénytelen levélazonosító.', 400)
  const m = await getJson(`${GMAIL}/messages/${id}?format=full`)
  const { plain, html } = bodyText(m.payload)
  const text = (plain || htmlToText(html)).replace(/\r\n/g, '\n').trim()
  const max = Math.min(Math.max(maxChars, 1000), 40000)
  return {
    id, threadId: m.threadId, from: header(m, 'From'), to: header(m, 'To'), cc: header(m, 'Cc'), subject: header(m, 'Subject'), date: header(m, 'Date'),
    link: `https://mail.google.com/mail/u/0/#all/${m.threadId}`, length: text.length, truncated: text.length > max, text: text.slice(0, max),
  }
}

const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`)
const validAddressList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean).every(a => /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$|^[^<>]*<[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+>$/.test(a))

/** Creates a Gmail DRAFT (never sends). Optionally as a reply in an existing thread. */
export async function gmailDraft(input: { to: string; subject: string; body: string; replyToId?: string; cc?: string }) {
  const to = input.to.trim(), cc = (input.cc || '').trim()
  if (!to || !validAddressList(to) || (cc && !validAddressList(cc))) throw new GoogleError('Érvénytelen címzett.', 400)
  if (!input.body || input.body.length > 50000) throw new GoogleError('Üres vagy túl hosszú levéltörzs.', 400)
  let subject = input.subject.trim().slice(0, 300)
  let threadId: string | undefined
  const extra: string[] = []
  if (input.replyToId) {
    const orig = await getJson(`${GMAIL}/messages/${input.replyToId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=References`)
    threadId = orig.threadId
    const mid = header(orig, 'Message-ID')
    if (mid) extra.push(`In-Reply-To: ${mid}`, `References: ${[header(orig, 'References'), mid].filter(Boolean).join(' ')}`)
    if (!subject) subject = header(orig, 'Subject')
    if (subject && !/^re:/i.test(subject)) subject = `Re: ${subject}`
  }
  const mime = [
    `To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${encWord(subject)}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', ...extra, '',
    Buffer.from(input.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n')
  const raw = Buffer.from(mime, 'utf8').toString('base64url')
  const res = await gapi(`${GMAIL}/drafts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
  })
  const d = await res.json()
  return { draftId: d.id, messageId: d.message?.id, to, subject, link: 'https://mail.google.com/mail/u/0/#drafts' }
}

async function draftFingerprint(draftId: string) {
  const d = await getJson(`${GMAIL}/drafts/${draftId}?format=full`)
  const m = d.message
  const { plain, html } = bodyText(m.payload)
  const text = (plain || htmlToText(html)).trim()
  const to = [header(m, 'To'), header(m, 'Cc'), header(m, 'Bcc')].filter(Boolean).join(', ')
  const subject = header(m, 'Subject')
  const hash = crypto.createHash('sha256').update(JSON.stringify([to, subject, text])).digest('hex')
  return { to, subject, text, hash }
}

/** An agent asks for a draft to be sent; nothing is sent until the owner approves. */
export async function requestSend(draftId: string, requestedBy: string): Promise<SendRequest> {
  if (!/^[A-Za-z0-9_-]{6,60}$/.test(draftId)) throw new GoogleError('Érvénytelen piszkozat-azonosító.', 400)
  const f = await draftFingerprint(draftId)
  const s = readState()
  const req: SendRequest = {
    id: crypto.randomUUID(), draftId, to: f.to, subject: f.subject, preview: f.text.slice(0, 1500), hash: f.hash,
    requestedBy, requestedAt: new Date().toISOString(), status: 'pending',
  }
  writeState({ ...s, requests: [...(s.requests || []), req].slice(-200) })
  return req
}

export function pendingRequests(): SendRequest[] {
  return (readState().requests || []).filter(r => r.status === 'pending')
}

/**
 * Closes pending requests whose draft no longer exists: the owner sent or deleted it in Gmail itself.
 * Otherwise they would stay "waiting" forever (and keep the notifier busy).
 */
export async function syncPendingWithGmail(): Promise<void> {
  const pending = pendingRequests()
  if (pending.length === 0 || !readState().refresh_token) return
  // Compare with the current draft list (a sent draft's id stops resolving, but not always with 404).
  const existing = new Set<string>()
  let pageToken = ''
  try {
    for (let page = 0; page < 10; page++) {
      const r = await getJson(`${GMAIL}/drafts?${new URLSearchParams({ maxResults: '500', ...(pageToken ? { pageToken } : {}) })}`)
      for (const d of r.drafts || []) existing.add(d.id)
      if (!r.nextPageToken) break
      pageToken = r.nextPageToken
    }
  } catch {
    return // Gmail not reachable now: leave the requests as they are
  }
  const gone = new Set(pending.filter(r => !existing.has(r.draftId)).map(r => r.id))
  if (gone.size === 0) return
  const st = readState()
  st.requests = (st.requests || []).map(x => (gone.has(x.id) && x.status === 'pending'
    ? { ...x, status: 'gone' as const, decidedAt: new Date().toISOString(), note: 'A piszkozatot közben a Gmailben elküldték vagy törölték (nem a Google fülön).' }
    : x))
  writeState(st)
}

/** Owner's decision. Approve sends exactly the draft that was shown (same recipients, subject, text). */
export async function decideSend(id: string, approve: boolean): Promise<SendRequest> {
  const s = readState()
  const req = (s.requests || []).find(r => r.id === id)
  if (!req) throw new GoogleError('Nincs ilyen kérés.', 404)
  if (req.status !== 'pending') throw new GoogleError('Erről a kérésről már döntöttél.', 409)
  const save = (patch: Partial<SendRequest>) => {
    const st = readState()
    st.requests = (st.requests || []).map(r => (r.id === id ? { ...r, ...patch, decidedAt: new Date().toISOString() } : r))
    writeState(st)
    return { ...req, ...patch }
  }
  if (!approve) return save({ status: 'rejected' })
  try {
    const now = await draftFingerprint(req.draftId)
    if (now.hash !== req.hash) return save({ status: 'failed', note: 'A piszkozat a kérés óta megváltozott; nem küldtem el.' })
    await gapi(`${GMAIL}/drafts/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: req.draftId }) })
    return save({ status: 'sent' })
  } catch (err) {
    return save({ status: 'failed', note: err instanceof Error ? err.message : 'Küldési hiba' })
  }
}

// --- Drive ------------------------------------------------------------------------------------------------
const DRIVE = 'https://www.googleapis.com/drive/v3'
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

export async function driveSearch(query: string, limit = 10) {
  const q = query.trim()
  if (!q || q.length > 200) throw new GoogleError('Adj meg egy keresőkifejezést (legfeljebb 200 karakter).', 400)
  const esc = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const params = new URLSearchParams({
    q: `(name contains '${esc}' or fullText contains '${esc}') and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size,owners(displayName))', pageSize: String(Math.min(Math.max(limit, 1), 25)),
  })
  return (await getJson(`${DRIVE}/files?${params}`)).files || []
}

function docxText(buf: Buffer): string {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new GoogleError('Hibás DOCX.', 422)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = buf.readUInt16LE(eocd + 10); n > 0 && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (name === 'word/document.xml') {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const data = buf.subarray(start, start + size)
      const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8')
      return htmlToText(xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n'))
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new GoogleError('Hibás DOCX (nincs word/document.xml).', 422)
}

export async function driveRead(id: string, maxChars = 20000) {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) throw new GoogleError('Érvénytelen fájlazonosító.', 400)
  const file = await getJson(`${DRIVE}/files/${id}?fields=id,name,mimeType,modifiedTime,webViewLink,size`)
  let text: string
  if (EXPORTS[file.mimeType]) text = await (await gapi(`${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(EXPORTS[file.mimeType])}`)).text()
  else if (Number(file.size || 0) > 5 * 1024 * 1024) throw new GoogleError('A fájl túl nagy az olvasáshoz (5 MB fölött).', 413)
  else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') text = docxText(Buffer.from(await (await gapi(`${DRIVE}/files/${id}?alt=media`)).arrayBuffer()))
  else if (/^text\/|json|xml|csv|markdown/.test(file.mimeType)) text = await (await gapi(`${DRIVE}/files/${id}?alt=media`)).text()
  else throw new GoogleError(`Ezt a formátumot nem tudom szövegként olvasni (${file.mimeType}); link: ${file.webViewLink}`, 415)
  const max = Math.min(Math.max(maxChars, 1000), 60000)
  return { file, length: text.length, truncated: text.length > max, text: text.slice(0, max) }
}

async function ensureFolder(): Promise<string> {
  const s = readState()
  if (s.folder_id) {
    const f = await getJson(`${DRIVE}/files/${s.folder_id}?fields=id,trashed`).catch(() => null)
    if (f && !f.trashed) return s.folder_id
  }
  const res = await gapi(`${DRIVE}/files?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  })
  const { id } = await res.json()
  writeState({ ...readState(), folder_id: id })
  return id
}

/** Creates a NEW Google Doc (or plain file) in the "Agent OS" folder. Never overwrites. */
export async function driveSave(name: string, content: string, asGoogleDoc = true) {
  const cleanName = name.replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 150)
  if (!cleanName) throw new GoogleError('Adj nevet a fájlnak.', 400)
  if (!content || content.length > 500_000) throw new GoogleError('Üres vagy túl hosszú tartalom.', 400)
  const folder = await ensureFolder()
  const meta = { name: cleanName, parents: [folder], ...(asGoogleDoc ? { mimeType: 'application/vnd.google-apps.document' } : {}) }
  const upload = (sourceType: string) => {
    const boundary = 'aos' + crypto.randomBytes(8).toString('hex')
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: ${sourceType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`
    return gapi('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    })
  }
  if (!asGoogleDoc) return (await upload('text/plain')).json()
  // Google Doc: imported as Markdown, so headings, lists, bold, links and tables come out formatted.
  // Should Drive refuse the Markdown import (HTTP 400), the text is still saved, unformatted.
  try {
    return { ...(await (await upload('text/markdown')).json()), format: 'markdown' }
  } catch (err) {
    if (!(err instanceof GoogleError) || !/HTTP 400\b/.test(err.message)) throw err
    return { ...(await (await upload('text/plain')).json()), format: 'plain' }
  }
}

// --- Calendar (read all calendars) ------------------------------------------------------------------------
export async function calendarEvents(fromIso: string, toIso: string, limit = 50) {
  const from = new Date(fromIso), to = new Date(toIso)
  if (isNaN(+from) || isNaN(+to) || to <= from || +to - +from > 62 * 86400_000) throw new GoogleError('Érvénytelen időszak (legfeljebb 62 nap).', 400)
  const cals = (await getJson('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader')).items || []
  const out: any[] = []
  for (const c of cals.filter((c: any) => !c.hidden).slice(0, 15)) {
    const p = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '100', timeZone: TZ })
    const ev = await getJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${p}`).catch(() => ({ items: [] }))
    for (const e of ev.items || []) {
      if (e.status === 'cancelled') continue
      out.push({ calendar: c.summaryOverride || c.summary, title: e.summary || '(nincs cím)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
        allDay: !!e.start?.date, location: e.location || null, link: e.htmlLink })
    }
  }
  return out.sort((a, b) => String(a.start).localeCompare(String(b.start))).slice(0, Math.min(Math.max(limit, 1), 200))
}

/** Raw events of all visible calendars (with ids), for the university sync. */
export async function listEventsRaw(fromIso: string, toIso: string) {
  const cals = (await getJson('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader')).items || []
  const out: Array<{ id: string; calendarId: string; calendar: string; title: string; start: string; end: string; allDay: boolean; location: string | null }> = []
  for (const c of cals.filter((c: any) => !c.hidden).slice(0, 15)) {
    let pageToken = ''
    for (let page = 0; page < 5; page++) {
      const p = new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeZone: TZ, ...(pageToken ? { pageToken } : {}) })
      const ev = await getJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${p}`).catch(() => ({ items: [] }))
      for (const e of ev.items || []) {
        if (e.status === 'cancelled' || e.extendedProperties?.private?.aosSource) continue // skip our own plan blocks
        const allDay = !!e.start?.date
        out.push({ id: e.id, calendarId: c.id, calendar: c.summaryOverride || c.summary, title: e.summary || '', allDay,
          start: allDay ? e.start.date : new Date(e.start.dateTime).toISOString(), end: allDay ? e.end.date : new Date(e.end.dateTime).toISOString(), location: e.location || null })
      }
      if (!ev.nextPageToken) break
      pageToken = ev.nextPageToken
    }
  }
  return out
}

// --- Contacts (read) --------------------------------------------------------------------------------------
export async function contactSearch(query: string, limit = 10) {
  const q = query.trim()
  if (!q || q.length > 100) throw new GoogleError('Adj meg egy nevet vagy e-mail-címet.', 400)
  const url = (qq: string) => `https://people.googleapis.com/v1/people:searchContacts?${new URLSearchParams({ query: qq, readMask: 'names,emailAddresses,phoneNumbers,organizations', pageSize: String(Math.min(Math.max(limit, 1), 30)) })}`
  await getJson(url('')).catch(() => null) // warm-up request recommended by the People API
  const r = await getJson(url(q))
  return (r.results || []).map((x: any) => ({
    name: x.person?.names?.[0]?.displayName || null,
    emails: (x.person?.emailAddresses || []).map((e: any) => e.value),
    phones: (x.person?.phoneNumbers || []).map((e: any) => e.value),
    organization: x.person?.organizations?.[0]?.name || null,
  }))
}

// --- Tasks (read + create) --------------------------------------------------------------------------------
const TASKS = 'https://tasks.googleapis.com/tasks/v1'
export async function tasksList(limit = 30) {
  const lists = (await getJson(`${TASKS}/users/@me/lists`)).items || []
  const out: any[] = []
  for (const l of lists.slice(0, 10)) {
    const t = await getJson(`${TASKS}/lists/${l.id}/tasks?${new URLSearchParams({ showCompleted: 'false', maxResults: '100' })}`)
    for (const x of t.items || []) out.push({ list: l.title, title: x.title, notes: x.notes || null, due: x.due || null, status: x.status })
  }
  return out.slice(0, Math.min(Math.max(limit, 1), 100))
}

export async function taskCreate(input: { title: string; notes?: string; due?: string }) {
  const title = input.title.trim().slice(0, 200)
  if (!title) throw new GoogleError('Adj címet a teendőnek.', 400)
  let due: string | undefined
  if (input.due) {
    const d = new Date(input.due)
    if (isNaN(+d)) throw new GoogleError('Érvénytelen határidő.', 400)
    due = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString()
  }
  const res = await gapi(`${TASKS}/lists/@default/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, ...(input.notes ? { notes: input.notes.slice(0, 5000) } : {}), ...(due ? { due } : {}) }),
  })
  const t = await res.json()
  return { id: t.id, title: t.title, due: t.due || null }
}
