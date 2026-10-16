'use client'

/**
 * Agent OS – "Hang" tab (fork addition). Push-to-talk conversation with the voice agent:
 * microphone → 16 kHz mono WAV in the browser → /api/agent-os/voice/transcribe (local whisper.cpp)
 * → /api/agent-os/voice/ask (hang-asszisztens) → answer read aloud with the system's Hungarian voice.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'

interface Turn { ki: 'en' | 'agens'; szoveg: string }
type Phase = 'idle' | 'recording' | 'transcribing' | 'thinking'

const TARGET_RATE = 16000
const VOICE_KEY = 'aos-hang-voice'
const SPEAK_KEY = 'aos-hang-speak'
const RATE_KEY = 'aos-hang-rate'
const RATES = [1, 1.25, 1.5, 1.75, 2]

function encodeWav(chunks: Float32Array[], inputRate: number): Blob {
  const length = chunks.reduce((n, c) => n + c.length, 0)
  const input = new Float32Array(length)
  let offset = 0
  for (const c of chunks) { input.set(c, offset); offset += c.length }
  // Downsample by averaging (good enough for speech; whisper wants 16 kHz mono).
  const ratio = inputRate / TARGET_RATE
  const outLength = Math.floor(length / ratio)
  const view = new DataView(new ArrayBuffer(44 + outLength * 2))
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); view.setUint32(4, 36 + outLength * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_RATE, true); view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, outLength * 2, true)
  for (let i = 0; i < outLength; i++) {
    const from = Math.floor(i * ratio), to = Math.min(Math.floor((i + 1) * ratio), length)
    let sum = 0
    for (let j = from; j < to; j++) sum += input[j]
    const s = Math.max(-1, Math.min(1, sum / Math.max(1, to - from)))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([view], { type: 'audio/wav' })
}

function readPref(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch {}
}

export function HangPanel() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [turns, setTurns] = useState<Turn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceName, setVoiceName] = useState<string>('')
  const [speak, setSpeak] = useState(true)
  const [rate, setRate] = useState(1.5)
  const [typed, setTyped] = useState('')
  const rec = useRef<{ stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode; chunks: Float32Array[] } | null>(null)
  const started = useRef(0)

  // Hungarian voices of the OS/browser (macOS: Mariska; Windows: Szabolcs; Chrome: Google magyar).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    const pick = () => {
      const hu = window.speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith('hu'))
      setVoices(hu)
      const saved = readPref(VOICE_KEY)
      setVoiceName(prev => prev || (hu.find(v => v.name === saved) || hu.find(v => !v.localService) || hu[0])?.name || '')
    }
    pick()
    window.speechSynthesis.addEventListener('voiceschanged', pick)
    setSpeak(readPref(SPEAK_KEY) !== '0')
    const savedRate = Number(readPref(RATE_KEY))
    if (RATES.includes(savedRate)) setRate(savedRate)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pick)
  }, [])

  const say = useCallback((text: string) => {
    if (!speak || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'hu-HU'
    u.rate = rate
    const v = voices.find(x => x.name === voiceName)
    if (v) u.voice = v
    window.speechSynthesis.speak(u)
  }, [speak, voices, voiceName, rate])

  const ask = useCallback(async (kerdes: string) => {
    const history = turns
    setTurns(t => [...t, { ki: 'en', szoveg: kerdes }])
    setPhase('thinking')
    try {
      const { valasz } = await apiFetch<{ valasz: string }>('/api/agent-os/voice/ask', {
        method: 'POST', body: JSON.stringify({ kerdes, elozmeny: history }),
      })
      setTurns(t => [...t, { ki: 'agens', szoveg: valasz }])
      say(valasz)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Az ágens nem válaszolt')
    } finally {
      setPhase('idle')
    }
  }, [turns, say])

  const startRecording = useCallback(async () => {
    setError(null)
    window.speechSynthesis?.cancel()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const node = ctx.createScriptProcessor(4096, 1, 1)
      const chunks: Float32Array[] = []
      node.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      source.connect(node); node.connect(ctx.destination)
      rec.current = { stream, ctx, node, chunks }
      started.current = Date.now()
      setPhase('recording')
    } catch {
      setError('A mikrofon nem érhető el (engedélyezd a böngészőben).')
    }
  }, [])

  const stopRecording = useCallback(async () => {
    const r = rec.current
    if (!r) return
    rec.current = null
    r.node.disconnect(); r.stream.getTracks().forEach(t => t.stop())
    const sampleRate = r.ctx.sampleRate
    await r.ctx.close()
    if (Date.now() - started.current < 600) { setPhase('idle'); setError('Túl rövid felvétel.'); return }
    setPhase('transcribing')
    try {
      const form = new FormData()
      form.append('file', encodeWav(r.chunks, sampleRate), 'hang.wav')
      const json = await apiFetch<{ text: string }>('/api/agent-os/voice/transcribe', { method: 'POST', body: form })
      const text = String(json.text || '').trim()
      if (!text) { setPhase('idle'); setError('Nem értettem semmit, próbáld újra.'); return }
      await ask(text)
    } catch (e) {
      setPhase('idle')
      setError(e instanceof Error ? e.message : 'A beszédfelismerés nem sikerült')
    }
  }, [ask])

  // Space = push-to-talk toggle (outside input fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || (e.target as HTMLElement)?.closest('input, textarea, select')) return
      e.preventDefault()
      if (phase === 'idle') void startRecording()
      else if (phase === 'recording') void stopRecording()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, startRecording, stopRecording])

  const status = { idle: 'Nyomd meg a gombot (vagy a szóközt), és beszélj.', recording: 'Felvétel… nyomd meg újra, ha befejezted.', transcribing: 'Beszédfelismerés…', thinking: 'Az ágens gondolkodik…' }[phase]

  return (
    <div className="p-4 space-y-4 max-w-3xl">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold text-foreground mr-2">Hang</h2>
        <label className="text-sm text-muted-foreground flex items-center gap-1">
          <input type="checkbox" checked={speak} onChange={e => { setSpeak(e.target.checked); writePref(SPEAK_KEY, e.target.checked ? '1' : '0'); if (!e.target.checked) window.speechSynthesis?.cancel() }} />
          Felolvasás
        </label>
        <select className="rounded border border-border bg-secondary px-2 py-1 text-sm text-foreground" value={voiceName}
          onChange={e => { setVoiceName(e.target.value); writePref(VOICE_KEY, e.target.value) }} disabled={voices.length === 0}>
          {voices.length === 0 && <option value="">Nincs magyar hang a rendszerben</option>}
          {voices.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
        </select>
        <select aria-label="Felolvasás sebessége" className="rounded border border-border bg-secondary px-2 py-1 text-sm text-foreground" value={rate}
          onChange={e => { const r = Number(e.target.value); setRate(r); writePref(RATE_KEY, String(r)) }}>
          {RATES.map(r => <option key={r} value={r}>{String(r).replace('.', ',')}×</option>)}
        </select>
        {turns.length > 0 && <Button variant="ghost" size="xs" onClick={() => { setTurns([]); window.speechSynthesis?.cancel() }}>Új beszélgetés</Button>}
      </div>

      <div className="flex flex-col items-center gap-2 py-4">
        <button type="button" aria-pressed={phase === 'recording'} disabled={phase === 'transcribing' || phase === 'thinking'}
          onClick={() => (phase === 'recording' ? stopRecording() : startRecording())}
          className={`h-24 w-24 rounded-full text-4xl border-2 transition-colors disabled:opacity-50 ${phase === 'recording' ? 'bg-red-500/20 border-red-500 animate-pulse' : 'bg-card border-primary hover:bg-primary/10'}`}>
          {phase === 'recording' ? '⏹' : '🎙️'}
        </button>
        <div className="text-sm text-muted-foreground" role="status" aria-live="polite">{status}</div>
        {error && <div className="text-sm text-red-400">{error}</div>}
      </div>

      <div className="space-y-2">
        {turns.map((t, i) => (
          <div key={i} className={`rounded-lg px-3 py-2 text-sm border ${t.ki === 'en' ? 'border-border bg-secondary ml-12' : 'border-primary/40 bg-card mr-12'}`}>
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-2">
              {t.ki === 'en' ? 'Te' : 'Hang-asszisztens'}
              {t.ki === 'agens' && <button type="button" className="text-primary underline" onClick={() => say(t.szoveg)}>Felolvasás újra</button>}
            </div>
            <div className="text-foreground whitespace-pre-wrap break-words">{t.szoveg}</div>
          </div>
        ))}
      </div>

      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); const q = typed.trim(); if (q && phase === 'idle') { setTyped(''); setError(null); void ask(q) } }}>
        <input className="flex-1 rounded border border-border bg-secondary px-2 py-1 text-sm text-foreground" placeholder="…vagy írd be a kérdést"
          value={typed} onChange={e => setTyped(e.target.value)} disabled={phase !== 'idle'} maxLength={2000} />
        <Button type="submit" size="sm" disabled={phase !== 'idle' || !typed.trim()}>Küldés</Button>
      </form>
    </div>
  )
}
