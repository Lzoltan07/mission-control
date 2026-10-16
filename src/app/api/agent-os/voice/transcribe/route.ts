/**
 * Agent OS voice – speech to text (fork addition).
 *   POST multipart {file: audio/wav}  admin → { text }
 * Audio goes only to the local whisper.cpp server (AOS_WHISPER_URL); nothing is stored.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { VoiceError, transcribe } from '@/lib/agent-os/voice'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof Blob)) throw new VoiceError('Missing audio file', 400)
    return NextResponse.json({ text: await transcribe(file) })
  } catch (err) {
    if (err instanceof VoiceError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: 'Transcription failed' }, { status: 500 })
  }
}
