/**
 * Agent OS voice – wake word check (fork addition).
 *   POST multipart {file: audio/wav, one speech segment}  admin → { wake, text }
 * The always-on voice button sends every speech segment here. The small local model checks for the
 * wake word ("Jarvis"); segments without it are dropped and never reach the agent. Nothing is stored.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { VoiceError, detectWake } from '@/lib/agent-os/voice'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof Blob)) throw new VoiceError('Missing audio file', 400)
    return NextResponse.json(await detectWake(file))
  } catch (err) {
    if (err instanceof VoiceError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: 'Wake word check failed' }, { status: 500 })
  }
}
