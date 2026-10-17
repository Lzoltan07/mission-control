/**
 * Agent OS – university timetable into the weekly plan (fork addition, not upstream).
 *
 * Decision (2026-10-17): every Neptun class ("… - Tanóra") from the owner's family calendar goes into
 * the weekly plan calendar, overlaps included, cancelled ones ("Elmarad…") left out; exams and tests
 * ("ZH", "Zárthelyi", "Vizsga") from any calendar as all-day markers. The sync is read-only on the
 * source calendars (Google account connection, calendar.readonly) and writes only its own blocks in the
 * plan calendar (marked aosSource=sync): it creates, updates and removes those, never anything else.
 * Window: today + AOS_UNI_DAYS (default 28). Triggered by the notifier hourly and from the Heti terv tab.
 *
 * Env: AOS_UNI_CALENDAR (default "családi"), AOS_UNI_MATCH (default "Tanóra"), AOS_UNI_SKIP
 *      (default "^Elmarad"), AOS_EXAM_MATCH (default "\\bZH\\b|Zárthelyi|Vizsga"), AOS_UNI_DAYS.
 *      Moodle deadlines (moodle.ts) join the same run when AOS_MOODLE_ICS_URL is set; if Moodle cannot be
 *      read, its existing blocks stay and the classes are still synced.
 */
import { CalendarError, syncPlanBlocks, type SyncItem } from '@/lib/agent-os/calendar'
import { listEventsRaw } from '@/lib/agent-os/google'
import { fetchMoodleIcs, parseMoodleIcs } from '@/lib/agent-os/moodle'

const UNI_CALENDAR = (process.env.AOS_UNI_CALENDAR || 'családi').toLowerCase()
const MATCH = new RegExp(process.env.AOS_UNI_MATCH || 'Tanóra', 'i')
const SKIP = new RegExp(process.env.AOS_UNI_SKIP || '^Elmarad', 'i')
const EXAM = new RegExp(process.env.AOS_EXAM_MATCH || '\\bZH\\b|Zárthelyi|Vizsga', 'i')
const DAYS = Math.min(Math.max(Number(process.env.AOS_UNI_DAYS) || 28, 1), 31)
const MOODLE_SKIP = process.env.AOS_MOODLE_SKIP ? new RegExp(process.env.AOS_MOODLE_SKIP, 'i') : undefined
const TZ = process.env.AOS_TIMEZONE || 'Europe/Budapest'

const localDate = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const localTime = (d: Date) => new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
const pad = (n: number) => String(n).padStart(2, '0')

/** "Kriminológia I. ( - 01) - dr. A;dr. B - Tanóra" → title "Kriminológia I. (01)", teachers "dr. A, dr. B". */
export function shortenClass(raw: string): { title: string; teachers: string } {
  // The Neptun group mark "( - 01)" contains " - " itself, so take it out before splitting.
  const group = /\(\s*-?\s*(\d+)\s*\)/.exec(raw)?.[1]
  const parts = raw.replace(/\s*\(\s*-?\s*\d*\s*\)\s*/, ' ').split(' - ')
  const name = (parts[0] || raw).trim()
  const teachers = parts.slice(1, -1).join(' - ').split(';').map(s => s.trim()).filter(Boolean).join(', ')
  return { title: `🎓 ${name}${group ? ` (${group})` : ''}`, teachers }
}

export interface UniSyncResult { classes: number; exams: number; moodle: number | null; moodleError?: string; created: number; updated: number; removed: number }

export async function syncUniversity(): Promise<UniSyncResult> {
  if ((process.env.AOS_CALENDAR_PROVIDER || 'local') !== 'google') throw new CalendarError('The weekly plan is not on Google Calendar', 409)
  const from = new Date(); from.setHours(0, 0, 0, 0)
  const to = new Date(+from + DAYS * 86400_000)
  const events = await listEventsRaw(from.toISOString(), to.toISOString())
  const items: SyncItem[] = []
  let classes = 0, exams = 0
  for (const e of events) {
    const fromUni = e.calendar.toLowerCase() === UNI_CALENDAR
    if (fromUni && MATCH.test(e.title) && !SKIP.test(e.title) && !e.allDay) {
      const { title, teachers } = shortenClass(e.title)
      items.push({
        syncId: `uni:${e.calendarId}:${e.id}`, title: title.slice(0, 200), allDay: false, start: e.start, end: e.end,
        description: [e.location ? `Terem: ${e.location.replace(/\*$/, '')}` : '', teachers ? `Oktató: ${teachers}` : '', 'Forrás: Neptun (családi naptár), automatikus szinkron'].filter(Boolean).join('\n'),
      })
      classes++
    } else if (EXAM.test(e.title) && !SKIP.test(e.title)) {
      items.push({
        syncId: `exam:${e.calendarId}:${e.id}`, title: `📝 ${e.title}`.slice(0, 200), allDay: e.allDay, start: e.start, end: e.end,
        description: `Forrás: ${e.calendar} naptár, automatikus szinkron`,
      })
      exams++
    }
  }
  // Moodle deadlines: all-day markers on the due date, the due time in the title.
  let moodle: number | null = null, moodleError: string | undefined
  const keep: string[] = []
  if (process.env.AOS_MOODLE_ICS_URL) {
    try {
      const due = parseMoodleIcs(await fetchMoodleIcs(process.env.AOS_MOODLE_ICS_URL), from, to, MOODLE_SKIP)
      for (const d of due) {
        const day = d.dateOnly ? `${d.due.getFullYear()}-${pad(d.due.getMonth() + 1)}-${pad(d.due.getDate())}` : localDate(d.due)
        const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1)
        items.push({
          syncId: `moodle:${d.uid}`, allDay: true, start: day, end: next.toISOString().slice(0, 10),
          title: `⏰ ${d.dateOnly ? '' : `${localTime(d.due)} · `}${d.title}`.slice(0, 200),
          description: [d.course ? `Kurzus: ${d.course}` : '', d.description, 'Forrás: Moodle, automatikus szinkron'].filter(Boolean).join('\n'),
        })
      }
      moodle = due.length
    } catch (err) {
      // Never the URL in the message (fetchMoodleIcs only names the host).
      moodleError = err instanceof Error ? err.message : 'A Moodle nem olvasható'
      keep.push('moodle:')
    }
  }
  const r = await syncPlanBlocks(items, from.toISOString(), to.toISOString(), keep)
  return { classes, exams, moodle, ...(moodleError ? { moodleError } : {}), ...r }
}

