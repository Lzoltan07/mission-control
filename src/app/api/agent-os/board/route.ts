/**
 * Agent OS – read-only board overview for planning agents (fork addition).
 *
 * Mission Control lets a non-admin agent key list only its own tasks. A planner needs to see the whole
 * board, but must not get admin rights. This endpoint returns a minimal, read-only view (no descriptions,
 * no resolutions) and only to the agents listed in AOS_BOARD_READERS (comma-separated agent names).
 * Humans (session users) with viewer+ can use it too.
 *
 *   GET ?days=14  → { tasks: [{ id, ticket, title, status, assigned_to, project, updated_at }] }
 *                   open tasks + tasks finished/failed in the last `days` days (1–60, default 14)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'

const READERS = (process.env.AOS_BOARD_READERS || '').split(',').map(s => s.trim()).filter(Boolean)

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.agent_name && auth.user.role !== 'admin' && !READERS.includes(auth.user.agent_name)) {
    return NextResponse.json({ error: 'This agent may not read the board overview' }, { status: 403 })
  }

  const daysRaw = Number.parseInt(new URL(request.url).searchParams.get('days') || '14', 10)
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 60) : 14
  const since = Math.floor(Date.now() / 1000) - days * 86400

  const rows = getDatabase().prepare(`
    SELECT t.id, t.title, t.status, t.assigned_to, t.updated_at, t.project_ticket_no,
           p.name AS project, p.ticket_prefix
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.workspace_id = ?
      AND (t.status NOT IN ('done', 'failed') OR t.updated_at >= ?)
      AND json_extract(t.metadata, '$.recurrence.cron_expr') IS NULL
    ORDER BY t.updated_at DESC
    LIMIT 200
  `).all(auth.user.workspace_id, since) as Array<Record<string, any>>

  return NextResponse.json({
    days,
    tasks: rows.map(r => ({
      id: r.id,
      ticket: r.ticket_prefix && r.project_ticket_no ? `${r.ticket_prefix}-${String(r.project_ticket_no).padStart(3, '0')}` : `TASK-${String(r.id).padStart(3, '0')}`,
      title: r.title,
      status: r.status,
      assigned_to: r.assigned_to,
      project: r.project || null,
      updated_at: new Date(r.updated_at * 1000).toISOString(),
    })),
  })
}
