/**
 * Agent OS – Moodle course materials and announcements for the agents (fork addition, not upstream).
 *
 * Decision (2026-10-17): read-only access to the owner's Moodle (SZE-learning) through the Moodle mobile
 * web service: course list, course contents (sections, files, pages, links), file text on request, and
 * forums/announcements. Files are downloaded only when an agent asks for one, and cached in the vault
 * (Egyetem/Moodle) – a full local mirror comes later on the Mac mini. No writing to Moodle at all
 * (no posting, no submission, no grading calls): only the functions in READ_FUNCTIONS are ever called.
 *
 * The token (AOS_MOODLE_TOKEN, from Moodle → Beállítások → Biztonsági kulcsok, "Moodle mobile web
 * service") stays in this process: it is sent only to AOS_MOODLE_URL, in the POST body (not in URLs, so
 * not in server logs), and never appears in results or error messages. Course material is copyrighted:
 * it is for the owner's own study, stays in the private vault, never published.
 *
 * Env: AOS_MOODLE_URL (e.g. https://szelearning.sze.hu; default: the origin of AOS_MOODLE_ICS_URL),
 *      AOS_MOODLE_TOKEN, AOS_MOODLE_AGENTS (default "kutato,hang-asszisztens"), AOS_MOODLE_CACHE_DIR
 *      (default <memory dir>/Egyetem/Moodle).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { config } from '@/lib/config'

export class MoodleError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const READ_FUNCTIONS = new Set([
  'core_webservice_get_site_info', 'core_enrol_get_users_courses', 'core_course_get_contents',
  'mod_forum_get_forums_by_courses', 'mod_forum_get_forum_discussions', 'mod_forum_get_forum_discussions_paginated',
  'mod_forum_get_discussion_posts',
])
const MAX_FILE = 30 * 1024 * 1024
const CONTENTS_TTL = 10 * 60_000

export function moodleAgents(): string[] {
  return (process.env.AOS_MOODLE_AGENTS || 'kutato,hang-asszisztens').split(',').map(s => s.trim()).filter(Boolean)
}

function baseUrl(): string {
  let raw = process.env.AOS_MOODLE_URL || ''
  if (!raw && process.env.AOS_MOODLE_ICS_URL) { try { raw = new URL(process.env.AOS_MOODLE_ICS_URL).origin } catch { /* below */ } }
  let u: URL
  try { u = new URL(raw) } catch { throw new MoodleError('A Moodle nincs beállítva (AOS_MOODLE_URL).', 409) }
  if (u.protocol !== 'https:') throw new MoodleError('Az AOS_MOODLE_URL csak https lehet.', 409)
  return u.origin + u.pathname.replace(/\/$/, '')
}

function token(): string {
  const t = (process.env.AOS_MOODLE_TOKEN || '').trim()
  if (!/^[a-zA-Z0-9]{20,64}$/.test(t)) throw new MoodleError('Nincs (érvényes) Moodle-kulcs: AOS_MOODLE_TOKEN a Mission Control env-jében.', 409)
  return t
}

export function moodleConfigured() {
  return !!process.env.AOS_MOODLE_TOKEN && (!!process.env.AOS_MOODLE_URL || !!process.env.AOS_MOODLE_ICS_URL)
}

function cacheDir() {
  return process.env.AOS_MOODLE_CACHE_DIR || path.join(config.memoryDir, 'Egyetem', 'Moodle')
}

/** Form-encodes nested params the way Moodle expects: courseids[0]=5, options[0][name]=x. */
function formEncode(params: Record<string, unknown>, form = new URLSearchParams(), prefix = ''): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k
    if (v === undefined || v === null) continue
    if (typeof v === 'object') formEncode(v as Record<string, unknown>, form, key)
    else form.append(key, String(v))
  }
  return form
}

let lastCall = 0
async function ws<T = any>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!READ_FUNCTIONS.has(fn)) throw new MoodleError('Nem engedélyezett Moodle-funkció.', 403)
  // Gentle on the university server: at most ~3 calls a second.
  const wait = lastCall + 350 - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastCall = Date.now()
  const body = formEncode({ wstoken: token(), wsfunction: fn, moodlewsrestformat: 'json', ...params })
  let res: Response
  try {
    res = await fetch(`${baseUrl()}/webservice/rest/server.php`, {
      method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(45_000),
    })
  } catch {
    throw new MoodleError('A Moodle nem érhető el.', 502)
  }
  const json: any = await res.json().catch(() => null)
  if (!res.ok || json === null) throw new MoodleError(`A Moodle hibát adott (HTTP ${res.status}).`, 502)
  if (json && typeof json === 'object' && json.exception) {
    const code = String(json.errorcode || '')
    if (code === 'invalidtoken' || code === 'accessexception') throw new MoodleError('A Moodle-kulcs érvénytelen vagy lejárt: kérj újat (Beállítások → Biztonsági kulcsok).', 401)
    throw new MoodleError(`Moodle: ${String(json.message || code).slice(0, 200)}`, 502)
  }
  return json as T
}

const text = (html: unknown, max = 2000) => String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, max)
const iso = (sec: unknown) => (Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : null)

let site: { userid: number; sitename: string; fullname: string; release: string } | null = null
async function siteInfo() {
  if (!site) {
    const s = await ws('core_webservice_get_site_info')
    site = { userid: s.userid, sitename: s.sitename, fullname: s.fullname, release: s.release }
  }
  return site
}

export async function moodleStatus() {
  if (!moodleConfigured()) return { configured: false }
  try {
    const s = await siteInfo()
    return { configured: true, connected: true, site: s.sitename, user: s.fullname, release: s.release }
  } catch (err) {
    return { configured: true, connected: false, error: err instanceof Error ? err.message : 'Hiba' }
  }
}

export interface MoodleCourse { id: number; shortname: string; fullname: string; current: boolean; lastaccess: string | null }

export async function moodleCourses(all = false): Promise<MoodleCourse[]> {
  const s = await siteInfo()
  const list: any[] = await ws('core_enrol_get_users_courses', { userid: s.userid })
  const now = Date.now() / 1000
  return list
    .map(c => ({ id: c.id, shortname: c.shortname, fullname: c.fullname, lastaccess: iso(c.lastaccess),
      current: !c.hidden && !(c.enddate > 0 && c.enddate < now - 14 * 86400) && !(c.startdate > now + 30 * 86400) }))
    .filter(c => all || c.current)
    .sort((a, b) => (b.lastaccess || '').localeCompare(a.lastaccess || ''))
}

const contentsCache = new Map<number, { at: number; data: any[] }>()
async function rawContents(courseId: number): Promise<any[]> {
  if (!Number.isInteger(courseId) || courseId <= 0) throw new MoodleError('Érvénytelen kurzusazonosító.', 400)
  const hit = contentsCache.get(courseId)
  if (hit && Date.now() - hit.at < CONTENTS_TTL) return hit.data
  const data: any[] = await ws('core_course_get_contents', { courseid: courseId })
  contentsCache.set(courseId, { at: Date.now(), data })
  return data
}

/** Sections with their modules; files listed by name (read them with moodleReadFile). */
export async function moodleCourseContents(courseId: number) {
  const sections = await rawContents(courseId)
  return sections.map(sec => ({
    section: sec.name,
    summary: text(sec.summary, 600) || undefined,
    items: (sec.modules || []).filter((m: any) => m.uservisible !== false).map((m: any) => ({
      module_id: m.id, type: m.modname, name: m.name,
      description: text(m.description, 400) || undefined,
      // External links (mod_url): the target address only, never fetched by the server.
      link: m.modname === 'url' ? (m.contents || []).find((c: any) => c.type === 'url')?.fileurl : undefined,
      files: m.modname === 'url' ? undefined : (m.contents || []).filter((c: any) => c.type === 'file').map((c: any) => ({
        name: c.filepath && c.filepath !== '/' ? `${c.filepath.replace(/^\//, '')}${c.filename}` : c.filename,
        size_kb: Math.round((c.filesize || 0) / 1024), modified: iso(c.timemodified), mime: c.mimetype,
      })),
    })),
  }))
}

/** Case-insensitive search over the names of sections, modules and files of the current courses. */
export async function moodleSearch(q: string, limit = 25) {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) throw new MoodleError('Legalább 2 karakteres keresés kell.', 400)
  const out: Array<{ course_id: number; course: string; section: string; module_id: number; type: string; name: string; file?: string }> = []
  for (const c of (await moodleCourses()).slice(0, 20)) {
    for (const sec of await moodleCourseContents(c.id)) {
      for (const it of sec.items) {
        const files: Array<{ name: string }> = it.files || []
        const hitFiles = files.filter(f => f.name.toLowerCase().includes(needle))
        if (it.name.toLowerCase().includes(needle) || (it.description || '').toLowerCase().includes(needle) || hitFiles.length) {
          out.push({ course_id: c.id, course: c.fullname, section: sec.section, module_id: it.module_id, type: it.type, name: it.name, file: hitFiles[0]?.name })
          if (out.length >= limit) return out
        }
      }
    }
  }
  return out
}

// ---- file text -------------------------------------------------------------------------------------

function zipEntries(buf: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new MoodleError('Hibás Office-fájl.', 422)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = buf.readUInt16LE(eocd + 10); n > 0 && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (wanted(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const data = buf.subarray(start, start + size)
      out.set(name, method === 8 ? zlib.inflateRawSync(data) : data)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

async function pdfText(buf: Buffer): Promise<string> {
  // unpdf (MIT, pdf.js build without dependencies), pinned in package.json; loaded only when a PDF is read.
  const { getDocumentProxy, extractText } = await import('unpdf')
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    const { text: pages } = await extractText(pdf, { mergePages: false })
    const out = pages.map((t, i) => `--- ${i + 1}. oldal ---\n${t.trim()}`).join('\n\n')
    if (!out.replace(/--- \d+\. oldal ---/g, '').trim()) throw new MoodleError('A PDF-ben nincs kinyerhető szöveg (valószínűleg szkennelt kép); a fájl letöltve a vaultba.', 422)
    return out
  } catch (err) {
    if (err instanceof MoodleError) throw err
    throw new MoodleError('A PDF nem olvasható (sérült vagy jelszóval védett); a fájl letöltve a vaultba.', 422)
  }
}

async function extractText(name: string, mime: string, buf: Buffer): Promise<string> {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.pdf' || mime === 'application/pdf') return pdfText(buf)
  if (ext === '.docx') {
    const xml = zipEntries(buf, n => n === 'word/document.xml').get('word/document.xml')
    if (!xml) throw new MoodleError('Hibás DOCX.', 422)
    return text(xml.toString('utf8').replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n'), 10_000_000)
  }
  if (ext === '.pptx') {
    const slides = [...zipEntries(buf, n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).entries()]
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a[0])![1]) - Number(/(\d+)\.xml$/.exec(b[0])![1]))
    return slides.map(([, x], i) => `--- ${i + 1}. dia ---\n${text(x.toString('utf8').replace(/<\/a:p>/g, '\n'), 100_000)}`).join('\n\n')
  }
  if (['.txt', '.md', '.csv'].includes(ext) || mime.startsWith('text/plain')) return buf.toString('utf8')
  if (['.html', '.htm'].includes(ext) || mime.startsWith('text/html')) return text(buf.toString('utf8'), 10_000_000)
  throw new MoodleError(`Ezt a fájltípust (${ext || mime}) nem tudom szövegként olvasni; a fájl letöltve a vaultba.`, 415)
}

const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || '_'

/** Downloads one file of a module (cached by modification time) and returns its text. */
export async function moodleReadFile(courseId: number, moduleId: number, fileName: string | undefined, maxChars = 20000) {
  const sections = await rawContents(courseId)
  const mod = sections.flatMap(s => s.modules || []).find((m: any) => m.id === moduleId)
  if (!mod) throw new MoodleError('Nincs ilyen elem a kurzusban.', 404)
  if (mod.modname === 'url') throw new MoodleError('Ez egy külső link, nem fájl; a címét a kurzustartalom mutatja.', 400)
  const files = (mod.contents || []).filter((c: any) => c.type === 'file')
  const full = (c: any) => (c.filepath && c.filepath !== '/' ? `${c.filepath.replace(/^\//, '')}${c.filename}` : c.filename)
  const file = fileName ? files.find((c: any) => full(c) === fileName || c.filename === fileName) : files[0]
  if (!file) throw new MoodleError('Nincs ilyen fájl ebben az elemben.', 404)
  if ((file.filesize || 0) > MAX_FILE) throw new MoodleError('A fájl túl nagy (30 MB fölött).', 413)

  // The download goes only to the configured Moodle host – never anywhere else with the token.
  const base = baseUrl()
  const url = new URL(String(file.fileurl))
  if (url.origin !== new URL(base).origin) throw new MoodleError('A fájl nem a beállított Moodle-ről jönne; nem töltöm le.', 400)
  url.pathname = url.pathname.replace(/\/pluginfile\.php\//, '/webservice/pluginfile.php/').replace(/\/webservice\/webservice\//, '/webservice/')
  url.searchParams.delete('token')

  const course = (await moodleCourses(true)).find(c => c.id === courseId)
  const dir = path.join(cacheDir(), safe(course?.shortname || String(courseId)))
  const stem = `${moduleId}-${safe(full(file))}`
  const filePath = path.join(dir, stem), metaPath = `${filePath}.meta.json`, textPath = `${filePath}.txt`
  let meta: any = null
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch { /* not cached */ }
  const fresh = meta && meta.timemodified === file.timemodified && fs.existsSync(filePath)

  let buf: Buffer
  if (fresh) {
    buf = fs.readFileSync(filePath)
  } else {
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', body: new URLSearchParams({ token: token() }), redirect: 'error', signal: AbortSignal.timeout(120_000) })
    } catch {
      throw new MoodleError('A fájl letöltése nem sikerült.', 502)
    }
    if (!res.ok) throw new MoodleError(`A fájl letöltése nem sikerült (HTTP ${res.status}).`, 502)
    buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_FILE) throw new MoodleError('A fájl túl nagy (30 MB fölött).', 413)
    if ((res.headers.get('content-type') || '').includes('application/json') && buf.length < 2000 && /"(exception|error)"/.test(buf.toString('utf8'))) {
      throw new MoodleError('A Moodle nem adta ki a fájlt (jogosultság vagy lejárt kulcs).', 502)
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, buf)
    try { fs.unlinkSync(textPath) } catch { /* none */ }
    fs.writeFileSync(metaPath, JSON.stringify({ course: course?.fullname, module: mod.name, file: full(file), timemodified: file.timemodified, downloaded: new Date().toISOString() }, null, 2))
  }

  let body: string
  if (fs.existsSync(textPath)) body = fs.readFileSync(textPath, 'utf8')
  else {
    body = await extractText(file.filename, file.mimetype || '', buf)
    fs.writeFileSync(textPath, body)
  }
  const max = Math.min(Math.max(maxChars, 1000), 80000)
  return {
    course: course?.fullname, module: mod.name, file: full(file), modified: iso(file.timemodified), cached: !!fresh,
    vault_path: path.relative(config.memoryDir, filePath).split(path.sep).join('/'),
    chars: body.length, truncated: body.length > max, text: body.slice(0, max),
  }
}

// ---- forums / announcements ------------------------------------------------------------------------

async function discussions(forumId: number, perPage: number): Promise<any[]> {
  try {
    const r = await ws('mod_forum_get_forum_discussions', { forumid: forumId, sortorder: -1, page: 0, perpage: perPage })
    return r.discussions || []
  } catch (err) {
    if (err instanceof MoodleError && err.status === 401) throw err
    const r = await ws('mod_forum_get_forum_discussions_paginated', { forumid: forumId, sortby: 'timemodified', sortdirection: 'DESC', page: 0, perpage: perPage })
    return r.discussions || []
  }
}

/** Forums of a course, or the announcement ("news") forums of all current courses. */
export async function moodleForums(courseId?: number) {
  const ids = courseId ? [courseId] : (await moodleCourses()).slice(0, 20).map(c => c.id)
  if (!ids.length) return []
  const forums: any[] = await ws('mod_forum_get_forums_by_courses', { courseids: ids })
  return forums
    .filter(f => courseId || f.type === 'news')
    .map(f => ({ forum_id: f.id, course_id: f.course, name: f.name, type: f.type === 'news' ? 'hirdetmények' : f.type, discussions: f.numdiscussions }))
}

/** Latest discussions: one forum, or the announcements of all current courses from the last `days` days. */
export async function moodleNews(opts: { forumId?: number; courseId?: number; days?: number; limit?: number }) {
  const limit = Math.min(Math.max(opts.limit || 15, 1), 50)
  const since = Date.now() / 1000 - Math.min(Math.max(opts.days || 14, 1), 180) * 86400
  const courses = new Map((await moodleCourses(true)).map(c => [c.id, c.fullname]))
  const forums = opts.forumId ? [{ forum_id: opts.forumId, course_id: opts.courseId || 0, name: '' }] : (await moodleForums(opts.courseId)).filter(f => opts.courseId || f.type === 'hirdetmények')
  const out: any[] = []
  for (const f of forums.slice(0, 25)) {
    for (const d of await discussions(f.forum_id, opts.forumId ? limit : 5)) {
      const modified = Number(d.timemodified || d.modified || d.created || 0)
      if (!opts.forumId && modified < since) continue
      out.push({
        discussion_id: d.discussion, course: courses.get(f.course_id) || undefined, forum: f.name || undefined,
        subject: d.subject || d.name, author: d.userfullname, date: iso(d.created || d.timemodified), modified: iso(modified),
        replies: d.numreplies, text: text(d.message, 1500),
      })
    }
  }
  return out.sort((a, b) => (b.modified || '').localeCompare(a.modified || '')).slice(0, limit)
}

export async function moodleDiscussion(discussionId: number) {
  if (!Number.isInteger(discussionId) || discussionId <= 0) throw new MoodleError('Érvénytelen beszélgetés-azonosító.', 400)
  const r = await ws('mod_forum_get_discussion_posts', { discussionid: discussionId, sortby: 'created', sortdirection: 'ASC' })
  return (r.posts || []).slice(0, 60).map((p: any) => ({
    subject: p.subject, author: p.author?.fullname || p.userfullname, date: iso(p.timecreated || p.created),
    text: text(p.message, 4000), attachments: (p.attachments || []).map((a: any) => a.filename),
  }))
}
