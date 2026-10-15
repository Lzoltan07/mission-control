/**
 * Agent OS weekly plan calendar (fork addition).
 *   GET  ?from=ISO&to=ISO   viewer+   → WeekView (busy slots + plan blocks)
 *   POST {title,description,start,end}  operator+ → create a block (agents may only create)
 * Update/delete is admin-only: see ./[id]/route.ts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { db_helpers } from '@/lib/db'
import { CalendarError, calendarProvider, parseRange, validateBlockInput, type BlockInput } from '@/lib/agent-os/calendar'

function fail(err: unknown) {
  if (err instanceof CalendarError) return NextResponse.json({ error: err.message }, { status: err.status })
  return NextResponse.json({ error: 'Calendar request failed' }, { status: 500 })
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const { searchParams } = new URL(request.url)
    const { from, to } = parseRange(searchParams.get('from'), searchParams.get('to'))
    return NextResponse.json(await calendarProvider().week(from, to))
  } catch (err) {
    return fail(err)
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const input = validateBlockInput(await request.json()) as BlockInput
    const isAgent = Boolean(auth.user.agent_name)
    const block = await calendarProvider().create(input, isAgent ? 'agent' : 'user', auth.user.username)
    db_helpers.logActivity('calendar_block_created', 'calendar', 0, auth.user.username,
      `Heti terv blokk: ${block.title}`, { id: block.id, start: block.start, end: block.end }, auth.user.workspace_id)
    return NextResponse.json({ block }, { status: 201 })
  } catch (err) {
    return fail(err)
  }
}
