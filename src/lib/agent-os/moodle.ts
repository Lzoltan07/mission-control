/**
 * Agent OS – Moodle deadlines into the weekly plan (fork addition, not upstream).
 *
 * Decision (2026-10-17, integration #30): the Moodle calendar export (Naptár → Naptár exportálása →
 * Naptár URL lekérése) is read and every event in the window becomes an all-day marker in the weekly
 * plan ("⏰ 23:59 · Beadandó …"), next to the Neptun classes (uni-sync.ts). The export URL holds a
 * personal token, so it lives only in the env (AOS_MOODLE_ICS_URL), never in logs, errors or blocks.
 * Read-only on Moodle; no other Moodle access.
 *
 * Env: AOS_MOODLE_ICS_URL (https only), AOS_MOODLE_SKIP (optional regex on the title, e.g. "megnyílik").
 * Kept free of imports so it can be tested with plain Node.
 */

export interface MoodleDeadline { uid: string; title: string; course: string; description: string; due: Date; dateOnly: boolean }

const MAX_BYTES = 2_000_000

/** Fetches the export; errors never contain the URL (it carries the token). */
export async function fetchMoodleIcs(url: string): Promise<string> {
  let u: URL
  try { u = new URL(url) } catch { throw new Error('AOS_MOODLE_ICS_URL is not a valid URL') }
  if (u.protocol !== 'https:') throw new Error('AOS_MOODLE_ICS_URL must be https')
  let res: Response
  try {
    res = await fetch(u, { headers: { accept: 'text/calendar' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  } catch {
    throw new Error(`Moodle (${u.host}) is not reachable`)
  }
  if (!res.ok) throw new Error(`Moodle (${u.host}) answered ${res.status}`)
  if (new URL(res.url || u.href).protocol !== 'https:') throw new Error('Moodle redirected to a non-https address')
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error('The Moodle export is too large')
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('The Moodle address did not return a calendar (expired token?)')
  return text
}

function unescapeText(v: string) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
}

/** 20261027T215900Z | 20261027T235900 (TZID or floating = local) | 20261027 (VALUE=DATE). */
function parseIcsDate(value: string): { date: Date; dateOnly: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (h === undefined) return { date: new Date(+y, +mo - 1, +d), dateOnly: true }
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))), dateOnly: false }
  // TZID / floating: Moodle uses the server's zone, which for a Hungarian Moodle is the owner's zone too.
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)), dateOnly: false }
}

function stripHtml(v: string) {
  return v.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

export function parseMoodleIcs(text: string, from: Date, to: Date, skip?: RegExp): MoodleDeadline[] {
  // RFC 5545 line unfolding: a line starting with a space or tab continues the previous one.
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const out: MoodleDeadline[] = []
  let cur: Record<string, { params: string; value: string }> | null = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue }
    if (line === 'END:VEVENT') {
      if (cur) {
        const uid = cur.UID?.value.trim()
        const title = unescapeText(cur.SUMMARY?.value || '').trim()
        const at = cur.DTSTART ? parseIcsDate(cur.DTSTART.value) : null
        if (uid && title && at && at.date >= from && at.date < to && !(skip && skip.test(title))) {
          out.push({
            uid, title, dateOnly: at.dateOnly, due: at.date,
            course: unescapeText(cur.CATEGORIES?.value || '').trim(),
            description: stripHtml(unescapeText(cur.DESCRIPTION?.value || '')).slice(0, 500),
          })
        }
      }
      cur = null
      continue
    }
    if (!cur) continue
    const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/.exec(line)
    if (m && !cur[m[1]]) cur[m[1]] = { params: m[2], value: m[3] }
  }
  return out.sort((a, b) => +a.due - +b.due)
}
