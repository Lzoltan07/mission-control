/**
 * Agent OS – execution log (fork addition). See src/lib/agent-os/executions.ts.
 *   GET                                               viewer+ (people)  → { executions, devices, machine }
 *   POST {action:'seen', deviceId, name?}             viewer+ (people)  heartbeat of this browser
 *   POST {action:'rename', deviceId, name}            viewer+ (people)  name this device
 *   POST {action:'start', title, taskId?, workerDevice?, progress?}
 *                                                     agent key (operator) → { id }   an agent starts a task run
 *   POST {action:'update', id, status?, progress?, usage?}   agent key (own runs only); usage = what
 *                                                     Claude Code reported for the run (turns, tokens, USD)
 *   POST {action:'record', title, taskId?, status, progress?, startedAt, finishedAt, usage}
 *                                                     agent key → { id }   a finished run logged afterwards
 *   GET ?view=usage&since=<unix s>                    people, or the notifier agent ("ertesito") →
 *                                                     { summary, runs finished after `since` }
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import {
  finishedRunsSince, listExecutions, parseUsage, recordExecution, renameDevice, startExecution, THIS_MACHINE, touchDevice,
  updateExecution, usageSummary, validDeviceId, type ExecStatus,
} from '@/lib/agent-os/executions'

const STATUSES: ExecStatus[] = ['running', 'done', 'failed']

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const params = new URL(request.url).searchParams
  if (params.get('view') === 'usage') {
    if (auth.user.agent_name && auth.user.agent_name !== 'ertesito') return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
    const since = Number(params.get('since'))
    return NextResponse.json({
      summary: usageSummary(auth.user.workspace_id),
      runs: Number.isFinite(since) && since > 0 ? finishedRunsSince(auth.user.workspace_id, since) : [],
    })
  }
  if (auth.user.agent_name) return NextResponse.json({ error: 'People only' }, { status: 403 })
  return NextResponse.json({ ...listExecutions(auth.user.workspace_id), usage: usageSummary(auth.user.workspace_id), machine: THIS_MACHINE })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const action = body?.action

  if (action === 'seen' || action === 'rename') {
    const auth = requireRole(request, 'viewer')
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
    if (auth.user.agent_name) return NextResponse.json({ error: 'People only' }, { status: 403 })
    if (!validDeviceId(body?.deviceId)) return NextResponse.json({ error: 'Invalid device id' }, { status: 400 })
    const name = typeof body?.name === 'string' ? body.name : null
    if (action === 'seen') touchDevice(auth.user.workspace_id, auth.user.username, body!.deviceId as string, name, request.headers.get('user-agent'))
    else renameDevice(auth.user.workspace_id, body!.deviceId as string, name || '')
    return NextResponse.json({ ok: true })
  }

  if (action === 'start' || action === 'update' || action === 'record') {
    const auth = requireRole(request, 'operator')
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const agent = auth.user.agent_name
    if (!agent) return NextResponse.json({ error: 'Agent key required' }, { status: 403 })
    if (action === 'record') {
      const title = typeof body?.title === 'string' ? body.title.trim() : ''
      const usage = parseUsage(body?.usage)
      const startedAt = Number(body?.startedAt), finishedAt = Number(body?.finishedAt)
      const status = body?.status === 'done' ? 'done' : 'failed'
      if (!title || !usage || !Number.isInteger(startedAt) || !Number.isInteger(finishedAt) || finishedAt < startedAt || finishedAt > Date.now() / 1000 + 60) {
        return NextResponse.json({ error: 'Invalid record' }, { status: 400 })
      }
      const id = recordExecution({
        workspaceId: auth.user.workspace_id, title, taskId: Number.isInteger(body?.taskId) ? Number(body!.taskId) : null, agent,
        workerDevice: typeof body?.workerDevice === 'string' ? body.workerDevice : null, status,
        progress: typeof body?.progress === 'string' ? body.progress : null, startedAt, finishedAt, usage,
      })
      return NextResponse.json({ id })
    }
    if (action === 'start') {
      const title = typeof body?.title === 'string' ? body.title.trim() : ''
      if (!title) return NextResponse.json({ error: 'Missing title' }, { status: 400 })
      const taskId = Number.isInteger(body?.taskId) ? Number(body!.taskId) : null
      const id = startExecution({
        workspaceId: auth.user.workspace_id, kind: 'feladat', title, taskId, agent,
        workerDevice: typeof body?.workerDevice === 'string' ? body.workerDevice : null,
        progress: typeof body?.progress === 'string' ? body.progress : null,
      })
      return NextResponse.json({ id })
    }
    const id = Number(body?.id)
    const status = STATUSES.includes(body?.status as ExecStatus) ? body!.status as ExecStatus : undefined
    const progress = typeof body?.progress === 'string' ? body.progress : undefined
    const usage = parseUsage(body?.usage)
    if (!Number.isInteger(id) || !updateExecution(id, auth.user.workspace_id, { status, progress, usage }, agent)) {
      return NextResponse.json({ error: 'Unknown run' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
