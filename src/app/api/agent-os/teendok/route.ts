/**
 * Agent OS – "Feladatok és teendők" pop-up (fork addition). See src/lib/agent-os/teendok.ts.
 *   GET                                                   admin (people) → summary
 *   POST {action:'task_create', title, due?}              admin → new Google Tasks item
 *   POST {action:'task_done', listId, id}                 admin → Google Tasks item done
 * A new board card goes through Mission Control's own POST /api/tasks (status inbox) from the pop-up.
 * People only: agents have their own, narrower tools (they may create, never complete or change).
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { GoogleError, taskComplete, taskCreate } from '@/lib/agent-os/google'
import { teendokSummary } from '@/lib/agent-os/teendok'

function owner(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return { res: NextResponse.json({ error: auth.error }, { status: auth.status }) }
  if (auth.user.agent_name) return { res: NextResponse.json({ error: 'People only' }, { status: 403 }) }
  return { user: auth.user }
}

export async function GET(request: NextRequest) {
  const o = owner(request)
  if (o.res) return o.res
  return NextResponse.json(await teendokSummary(o.user.workspace_id))
}

export async function POST(request: NextRequest) {
  const o = owner(request)
  if (o.res) return o.res
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  try {
    switch (body?.action) {
      case 'task_create': {
        const t = await taskCreate({ title: String(body.title || ''), due: typeof body.due === 'string' && body.due ? body.due : undefined })
        logAuditEvent({ action: 'aos_teendo_create', actor: o.user.username, target_type: 'google_task' })
        return NextResponse.json({ task: t }, { status: 201 })
      }
      case 'task_done': {
        const t = await taskComplete(String(body.listId || ''), String(body.id || ''))
        logAuditEvent({ action: 'aos_teendo_done', actor: o.user.username, target_type: 'google_task' })
        return NextResponse.json({ task: t })
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof GoogleError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Request failed' }, { status: 500 })
  }
}
