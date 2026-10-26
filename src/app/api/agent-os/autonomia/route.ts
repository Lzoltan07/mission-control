/**
 * Agent OS – autonomy levels (fork addition). See src/lib/agent-os/autonomia.ts.
 *   GET                       admin (people) → categories with level, locked, maxLevel
 *   POST {key, level}         admin (people) → new level; locked → 403, above maxLevel → 400
 * People only: an agent never changes its own autonomy.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { AutonomiaError, getAutonomia, setAutonomyLevel } from '@/lib/agent-os/autonomia'

function owner(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return { res: NextResponse.json({ error: auth.error }, { status: auth.status }) }
  if (auth.user.agent_name) return { res: NextResponse.json({ error: 'People only' }, { status: 403 }) }
  return { user: auth.user }
}

export async function GET(request: NextRequest) {
  const o = owner(request)
  if (o.res) return o.res
  return NextResponse.json(getAutonomia())
}

export async function POST(request: NextRequest) {
  const o = owner(request)
  if (o.res) return o.res
  const body = await request.json().catch(() => null) as { key?: unknown; level?: unknown } | null
  try {
    const key = String(body?.key || '')
    const level = Number(body?.level)
    const before = getAutonomia().categories.find(c => c.key === key)?.level
    const cfg = setAutonomyLevel(key, level)
    logAuditEvent({ action: 'aos_autonomia_set', actor: o.user.username, target_type: 'autonomia', detail: { key, from: before, to: level } })
    return NextResponse.json(cfg)
  } catch (err) {
    if (err instanceof AutonomiaError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Request failed' }, { status: 500 })
  }
}
