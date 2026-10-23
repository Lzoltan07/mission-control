/**
 * Agent OS – "Feladatok és teendők" pop-up (fork addition): one summary for the floating button on every page.
 *   - rám vár: board cards in review / quality review, unassigned inbox cards (assigning = approval),
 *     e-mails an agent asked to send (Google tab approval)
 *   - teendők: the owner's open Google Tasks
 *   - határidők: all-day markers (exams, Moodle deadlines) in the next 7 days, and today's timed plan blocks
 * Each part fails on its own (e.g. Google not connected) without breaking the others.
 */
import { getDatabase } from '@/lib/db'
import { calendarProvider } from '@/lib/agent-os/calendar'
import { googleStatus, pendingRequests, tasksList } from '@/lib/agent-os/google'

export interface TeendokSummary {
  ramVar: {
    review: Array<{ id: number; title: string; status: string; assignedTo: string | null; updatedAt: number }>
    inbox: Array<{ id: number; title: string; priority: string | null; createdAt: number }>
    inboxCount: number
    emails: Array<{ id: string; to: string; subject: string; requestedBy: string }>
  }
  teendok: Array<{ id: string; listId: string; list: string; title: string; due: string | null; notes: string | null }> | null
  teendokError?: string
  hataridok: Array<{ title: string; start: string; end: string; allDay: boolean; today: boolean }>
  hataridokError?: string
  count: number
}

export async function teendokSummary(workspaceId: number): Promise<TeendokSummary> {
  const db = getDatabase()
  const review = (db.prepare(`SELECT id, title, status, assigned_to, updated_at FROM tasks
                              WHERE workspace_id = ? AND status IN ('review','quality_review') ORDER BY updated_at DESC LIMIT 20`).all(workspaceId) as any[])
    .map(t => ({ id: t.id, title: t.title, status: t.status, assignedTo: t.assigned_to, updatedAt: t.updated_at }))
  const inboxRows = db.prepare(`SELECT id, title, priority, created_at FROM tasks WHERE workspace_id = ? AND status = 'inbox'
                                AND (assigned_to IS NULL OR assigned_to = '') ORDER BY created_at DESC`).all(workspaceId) as any[]
  const inbox = inboxRows.slice(0, 10).map(t => ({ id: t.id, title: t.title, priority: t.priority, createdAt: t.created_at }))
  const emails = pendingRequests().map(r => ({ id: r.id, to: r.to, subject: r.subject, requestedBy: r.requestedBy }))

  let teendok: TeendokSummary['teendok'] = null, teendokError: string | undefined
  if (googleStatus().services.tasks) {
    try {
      teendok = (await tasksList(60)).map((t: any) => ({ id: t.id, listId: t.listId, list: t.list, title: t.title, due: t.due, notes: t.notes }))
        .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
    } catch (err) {
      teendokError = err instanceof Error ? err.message : 'A Google Tasks nem olvasható'
    }
  } else {
    teendokError = 'A Google Tasks nincs összekötve (Google fül).'
  }

  let hataridok: TeendokSummary['hataridok'] = [], hataridokError: string | undefined
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const end = new Date(start); end.setDate(start.getDate() + 7)
    const tomorrow = new Date(start); tomorrow.setDate(start.getDate() + 1)
    const week = await calendarProvider().week(start.toISOString(), end.toISOString())
    hataridok = (week.blocks || [])
      .map((b: any) => ({ title: b.title, start: b.start, end: b.end, allDay: !!b.allDay, today: Date.parse(b.start) < +tomorrow && Date.parse(b.end) > +start }))
      .filter(b => b.allDay || b.today)
      .sort((a, b) => a.start.localeCompare(b.start))
  } catch (err) {
    hataridokError = err instanceof Error ? err.message : 'A heti terv nem olvasható'
  }

  const dueSoon = (teendok || []).filter(t => t.due && Date.parse(t.due) < Date.now() + 2 * 86400_000).length
  return {
    ramVar: { review, inbox, inboxCount: inboxRows.length, emails },
    teendok, ...(teendokError ? { teendokError } : {}),
    hataridok, ...(hataridokError ? { hataridokError } : {}),
    // The badge: what needs the owner now (cards to review, e-mails to approve, tasks due within 2 days).
    count: review.length + emails.length + dueSoon,
  }
}
