/**
 * Agent OS – Google account for the agents (fork addition). See src/lib/agent-os/google.ts.
 *
 * People (session):
 *   GET                                        viewer+ → status: connected, services, send requests
 *   POST {action:'decide', id, approve}        admin   → approve (sends the draft) or reject a send request
 * Agents in AOS_GOOGLE_AGENTS (and admins, for testing):
 *   GET ?action=gmail_search&q=&limit=   | gmail_read&id=&max=
 *   GET ?action=drive_search&q=&limit=   | drive_read&id=&max=
 *   GET ?action=calendar&from=&to=       | contacts&q=   | tasks
 *   POST {action:'gmail_draft', to, subject, body, cc?, reply_to_id?}   → creates a draft, never sends
 *   POST {action:'gmail_send_request', draft_id}                         → waits for the owner's approval
 *   POST {action:'drive_save', name, content, google_doc?}               → new file in "Agent OS" folder
 *   POST {action:'task_create', title, notes?, due?}
 * The notifier (agent "ertesito") may read GET ?action=pending (subjects only).
 * Connecting: /api/agent-os/calendar/oauth?action=start&target=google.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole, type User } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import {
  GoogleError, calendarEvents, contactSearch, decideSend, driveRead, driveSave, driveSearch, gmailDraft, gmailRead, gmailSearch,
  googleAgents, googleStatus, pendingRequests, requestSend, taskCreate, tasksList,
} from '@/lib/agent-os/google'

function fail(err: unknown) {
  if (err instanceof GoogleError) return NextResponse.json({ error: err.message }, { status: err.status })
  return NextResponse.json({ error: 'Google request failed' }, { status: 500 })
}

/** Agents listed in AOS_GOOGLE_AGENTS, or a person with admin role. */
function toolUser(request: NextRequest): { user: User; actor: string } | NextResponse {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const agent = auth.user.agent_name
  if (agent) {
    if (!googleAgents().includes(agent)) return NextResponse.json({ error: 'This agent may not use the Google account' }, { status: 403 })
    return { user: auth.user, actor: `agent:${agent}` }
  }
  if (auth.user.role !== 'admin') return NextResponse.json({ error: 'Requires admin role' }, { status: 403 })
  return { user: auth.user, actor: auth.user.username }
}

const num = (v: string | null, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d)

export async function GET(request: NextRequest) {
  const p = new URL(request.url).searchParams
  const action = p.get('action')
  try {
    if (!action) {
      const auth = requireRole(request, 'viewer')
      if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
      if (auth.user.agent_name) return NextResponse.json({ error: 'People only' }, { status: 403 })
      return NextResponse.json(googleStatus())
    }
    if (action === 'pending') {
      const auth = requireRole(request, 'operator')
      if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
      if (auth.user.agent_name && auth.user.agent_name !== 'ertesito') return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
      return NextResponse.json({ pending: pendingRequests().map(r => ({ id: r.id, subject: r.subject, requestedBy: r.requestedBy, requestedAt: r.requestedAt })) })
    }
    const who = toolUser(request)
    if (who instanceof NextResponse) return who
    switch (action) {
      case 'gmail_search': return NextResponse.json({ messages: await gmailSearch(p.get('q') || '', num(p.get('limit'), 10)) })
      case 'gmail_read': return NextResponse.json(await gmailRead(p.get('id') || '', num(p.get('max'), 15000)))
      case 'drive_search': return NextResponse.json({ files: await driveSearch(p.get('q') || '', num(p.get('limit'), 10)) })
      case 'drive_read': return NextResponse.json(await driveRead(p.get('id') || '', num(p.get('max'), 20000)))
      case 'calendar': return NextResponse.json({ events: await calendarEvents(p.get('from') || '', p.get('to') || '', num(p.get('limit'), 50)) })
      case 'contacts': return NextResponse.json({ contacts: await contactSearch(p.get('q') || '', num(p.get('limit'), 10)) })
      case 'tasks': return NextResponse.json({ tasks: await tasksList(num(p.get('limit'), 30)) })
      default: return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (err) {
    return fail(err)
  }
}

export async function POST(request: NextRequest) {
  const b = await request.json().catch(() => null) as Record<string, any> | null
  const action = b?.action
  try {
    if (action === 'decide') {
      const auth = requireRole(request, 'admin')
      if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
      if (auth.user.agent_name) return NextResponse.json({ error: 'Only the owner can approve' }, { status: 403 })
      const req = await decideSend(String(b?.id || ''), b?.approve === true)
      logAuditEvent({ action: `aos_gmail_send_${req.status}`, actor: auth.user.username, target_type: 'gmail_draft', detail: { to: req.to, subject: req.subject, requestedBy: req.requestedBy } })
      return NextResponse.json({ request: req })
    }
    const who = toolUser(request)
    if (who instanceof NextResponse) return who
    let result: unknown
    switch (action) {
      case 'gmail_draft':
        result = await gmailDraft({ to: String(b?.to || ''), subject: String(b?.subject || ''), body: String(b?.body || ''), cc: b?.cc ? String(b.cc) : undefined, replyToId: b?.reply_to_id ? String(b.reply_to_id) : undefined })
        break
      case 'gmail_send_request':
        result = await requestSend(String(b?.draft_id || ''), who.actor)
        break
      case 'drive_save':
        result = await driveSave(String(b?.name || ''), String(b?.content || ''), b?.google_doc !== false)
        break
      case 'task_create':
        result = await taskCreate({ title: String(b?.title || ''), notes: b?.notes ? String(b.notes) : undefined, due: b?.due ? String(b.due) : undefined })
        break
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
    logAuditEvent({ action: `aos_google_${action}`, actor: who.actor, target_type: 'google' })
    return NextResponse.json(result)
  } catch (err) {
    return fail(err)
  }
}
