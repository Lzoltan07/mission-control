/**
 * Agent OS voice – ask the voice agent (fork addition).
 *   POST {kerdes, elozmeny?: [{ki:'en'|'agens', szoveg}]}  admin → { valasz }
 * Admin only: the spoken request of the logged-in owner counts as approval for the voice agent's
 * limited tools (see agents/hang-asszisztens.md in the Agent OS repo).
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { VoiceError, askAgent, type Turn } from '@/lib/agent-os/voice'
import { startExecution, touchDevice, updateExecution, validDeviceId } from '@/lib/agent-os/executions'

let busy = false // one voice question at a time (each spawns a Claude Code session)

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.agent_name) return NextResponse.json({ error: 'Agents may not use the voice agent' }, { status: 403 })
  if (busy) return NextResponse.json({ error: 'A previous question is still running' }, { status: 429 })

  const body = await request.json().catch(() => null) as { kerdes?: unknown; elozmeny?: unknown } | null
  const kerdes = typeof body?.kerdes === 'string' ? body.kerdes.trim() : ''
  if (!kerdes || kerdes.length > 2000) return NextResponse.json({ error: 'Empty or too long question' }, { status: 400 })
  const elozmeny: Turn[] = (Array.isArray(body?.elozmeny) ? body.elozmeny : [])
    .filter((t: any) => t && (t.ki === 'en' || t.ki === 'agens') && typeof t.szoveg === 'string')
    .slice(-6)
    .map((t: any) => ({ ki: t.ki, szoveg: t.szoveg.slice(0, 500) }))

  busy = true
  // Execution log: which device asked (x-aos-device from the voice button), who answers where.
  const device = request.headers.get('x-aos-device')
  if (validDeviceId(device)) touchDevice(auth.user.workspace_id, auth.user.username, device, null, request.headers.get('user-agent'))
  const run = startExecution({
    workspaceId: auth.user.workspace_id, kind: 'hang', title: kerdes, agent: process.env.AOS_VOICE_AGENT || 'hang-asszisztens',
    sourceUser: auth.user.username, sourceDeviceId: validDeviceId(device) ? device : null, progress: 'Az ágens gondolkodik',
  })
  try {
    const valasz = await askAgent(kerdes, elozmeny)
    updateExecution(run, auth.user.workspace_id, { status: 'done', progress: valasz.slice(0, 200) })
    return NextResponse.json({ valasz })
  } catch (err) {
    updateExecution(run, auth.user.workspace_id, { status: 'failed', progress: err instanceof Error ? err.message : 'Hiba' })
    if (err instanceof VoiceError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: 'Voice request failed' }, { status: 500 })
  } finally {
    busy = false
  }
}
