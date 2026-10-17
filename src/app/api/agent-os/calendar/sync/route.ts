/**
 * Agent OS – university timetable into the weekly plan (fork addition). See src/lib/agent-os/uni-sync.ts.
 *   POST   admin (people), or the notifier agent ("ertesito", hourly) → { classes, exams, created, updated, removed }
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { CalendarError } from '@/lib/agent-os/calendar'
import { syncUniversity } from '@/lib/agent-os/uni-sync'

let running = false

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const agent = auth.user.agent_name
  if (agent ? agent !== 'ertesito' : auth.user.role !== 'admin') return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  if (running) return NextResponse.json({ error: 'A sync is already running' }, { status: 429 })
  running = true
  try {
    return NextResponse.json(await syncUniversity())
  } catch (err) {
    if (err instanceof CalendarError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Sync failed' }, { status: 500 })
  } finally {
    running = false
  }
}
