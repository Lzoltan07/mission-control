/**
 * Agent OS voice – read aloud with the local Piper server (fork addition).
 *   GET                         admin → { voices: string[] }  (empty when Piper is not running)
 *   POST {text, voice, rate?}   admin → audio/wav
 * Text goes only to the local Piper server (AOS_PIPER_URL); nothing is stored.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { VoiceError, piperVoices, synthesize } from '@/lib/agent-os/voice'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json({ voices: await piperVoices() })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const body = await request.json().catch(() => null) as { text?: unknown; voice?: unknown; rate?: unknown } | null
  try {
    const wav = await synthesize(
      typeof body?.text === 'string' ? body.text : '',
      typeof body?.voice === 'string' ? body.voice : '',
      body?.rate === undefined ? 1 : Number(body.rate),
    )
    return new NextResponse(wav, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof VoiceError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: 'Speech synthesis failed' }, { status: 500 })
  }
}
