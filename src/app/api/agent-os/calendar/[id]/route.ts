/**
 * Agent OS weekly plan calendar – edit and delete (fork addition).
 * Admin-only on purpose: agents can add blocks but never change or remove existing ones.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { db_helpers } from '@/lib/db'
import { CalendarError, calendarProvider, validateBlockInput } from '@/lib/agent-os/calendar'

function fail(err: unknown) {
  if (err instanceof CalendarError) return NextResponse.json({ error: err.message }, { status: err.status })
  return NextResponse.json({ error: 'Calendar request failed' }, { status: 500 })
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const { id } = await params
    const patch = validateBlockInput(await request.json(), true)
    const block = await calendarProvider().update(id, patch)
    db_helpers.logActivity('calendar_block_updated', 'calendar', 0, auth.user.username,
      `Heti terv blokk módosítva: ${block.title}`, { id, ...patch }, auth.user.workspace_id)
    return NextResponse.json({ block })
  } catch (err) {
    return fail(err)
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const { id } = await params
    await calendarProvider().remove(id)
    db_helpers.logActivity('calendar_block_deleted', 'calendar', 0, auth.user.username,
      'Heti terv blokk törölve', { id }, auth.user.workspace_id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return fail(err)
  }
}
