/**
 * Agent OS – status for the "Funkciók" dashboard and the "Ágensfigyelő" widget (fork addition).
 *   GET ?part=functions                  viewer+ → { functions: FunctionStatus[] }
 *   GET ?part=agents                     viewer+ → { agents: [{ name, role }] }   (for the pickers)
 *   GET ?part=agents&names=a,b,c,d       viewer+ → { watch: AgentWatch[] }         (max 4 names)
 * Read-only. People only: agent keys get 403 (agents see their own tasks through the normal API).
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { agentNames, agentWatch, functionStatuses } from '@/lib/agent-os/overview'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.agent_name) return NextResponse.json({ error: 'Agents may not read the overview' }, { status: 403 })

  const params = new URL(request.url).searchParams
  const ws = auth.user.workspace_id
  if (params.get('part') === 'functions') {
    const localMode = params.get('mode') !== 'full'
    return NextResponse.json({ functions: await functionStatuses(ws, localMode) })
  }
  if (params.get('part') === 'agents') {
    const raw = params.get('names')
    if (!raw) return NextResponse.json({ agents: agentNames(ws) })
    const names = raw.split(',').map(s => s.trim()).filter(n => /^[\p{L}\p{N}_.:-]{1,64}$/u.test(n)).slice(0, 4)
    return NextResponse.json({ watch: agentWatch(ws, names) })
  }
  return NextResponse.json({ error: 'Unknown part' }, { status: 400 })
}
