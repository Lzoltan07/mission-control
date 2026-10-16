'use client'

/**
 * Agent OS – always-on voice assistant (fork addition). A floating button on every page:
 *   on  → the microphone stays open; a simple energy detector cuts speech into segments at pauses and
 *         sends each one to /api/agent-os/voice/wake. The small local model drops everything that does
 *         not start with the wake word ("Jarvis"); "Jarvis, <command>" goes to the voice agent
 *         (/api/agent-os/voice/ask) and the answer is read aloud (Piper via /voice/speak, or the
 *         system's Hungarian voice). "Jarvis" alone opens an 8 s window for the command.
 *   off → microphone closed, nothing is listened to.
 * On by default (remembered per browser). Browsers only start audio after a user gesture, so the
 * first click or key press on the page arms it.
 *
 * The button can be dragged anywhere (position remembered per browser), and the panel can be popped
 * out into its own window: an always-on-top Document Picture-in-Picture window where the browser has
 * it (Chrome, Edge), otherwise a popup. The microphone stays in this page, so only one listener runs.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { deviceId } from './device'

interface Turn { ki: 'en' | 'agens'; szoveg: string }
type Phase = 'off' | 'starting' | 'needs-click' | 'listening' | 'armed' | 'checking' | 'thinking' | 'speaking' | 'error'

const TARGET_RATE = 16000
const ON_KEY = 'aos-hang-on'
const VOICE_KEY = 'aos-hang-voice'
const SPEAK_KEY = 'aos-hang-speak'
const RATE_KEY = 'aos-hang-rate'
const RATES = [1, 1.25, 1.5, 1.75, 2]
const PIPER = 'piper:' // voice select values: "piper:<voice id>" or a system voice name
const piperLabel = (id: string) => 'Piper – ' + (id.split('-')[1] || id).replace(/^./, c => c.toUpperCase())

// Segmenting: speech starts above max(MIN_LEVEL, noise floor × 3), ends after SILENCE_MS of quiet.
const MIN_LEVEL = 0.012
const SILENCE_MS = 800
const MIN_SPEECH_MS = 350
const MAX_SEGMENT_MS = 15000
const PREROLL_MS = 300
const ARMED_MS = 8000
const POS_KEY = 'aos-hang-pos'

const STATUS: Record<Phase, string> = {
  off: 'Hang kikapcsolva',
  starting: 'Mikrofon indítása…',
  'needs-click': 'Kattints bárhová a hang indításához',
  listening: 'Mondd: „Jarvis, …”',
  armed: 'Hallgatlak…',
  checking: 'Feldolgozás…',
  thinking: 'Jarvis gondolkodik…',
  speaking: 'Jarvis beszél…',
  error: 'Hiba a hangban',
}

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

interface Mic { stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode }

export function VoiceAssistant() {
  const [on, setOn] = useState(false)
  const [phase, setPhase] = useState<Phase>('off')
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [piperVoices, setPiperVoices] = useState<string[]>([])
  const [voiceName, setVoiceName] = useState('')
  const [speak, setSpeak] = useState(true)
  const [rate, setRate] = useState(1.5)
  const [typed, setTyped] = useState('')

  const mic = useRef<Mic | null>(null)
  const phaseRef = useRef<Phase>('off')
  const onRef = useRef(false)
  const armedUntil = useRef(0)
  const turnsRef = useRef<Turn[]>([])
  const audio = useRef<AudioContext | null>(null) // Web Audio playback (CSP has no media-src for blob:)
  const speakSeq = useRef(0)
  const handleSegment = useRef<(wav: Blob) => void>(() => {})

  // The phase is also broadcast (window event 'aos-jarvis-phase') for the Jarvis core on the dashboard.
  const setP = useCallback((p: Phase) => {
    phaseRef.current = p
    setPhase(p)
    window.dispatchEvent(new CustomEvent('aos-jarvis-phase', { detail: p }))
  }, [])
  useEffect(() => { turnsRef.current = turns }, [turns])

  // --- Preferences and voices ---------------------------------------------------------------------
  useEffect(() => {
    setOn(readPref(ON_KEY) !== '0') // on by default
    setSpeak(readPref(SPEAK_KEY) !== '0')
    const savedRate = Number(readPref(RATE_KEY))
    if (RATES.includes(savedRate)) setRate(savedRate)
    if (!window.speechSynthesis) return
    const pick = () => {
      const hu = window.speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith('hu'))
      setVoices(hu)
      const saved = readPref(VOICE_KEY)
      setVoiceName(prev => prev || (hu.find(v => v.name === saved) || hu.find(v => !v.localService) || hu[0])?.name || '')
    }
    pick()
    window.speechSynthesis.addEventListener('voiceschanged', pick)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pick)
  }, [])

  useEffect(() => {
    apiFetch<{ voices: string[] }>('/api/agent-os/voice/speak', { redirectOnUnauthenticated: false }).then(({ voices: list }) => {
      setPiperVoices(list)
      const saved = readPref(VOICE_KEY)
      setVoiceName(prev => {
        if (saved?.startsWith(PIPER) && list.includes(saved.slice(PIPER.length))) return saved
        if (!saved && list.length > 0) return PIPER + list[0]
        return prev
      })
    }).catch(() => setPiperVoices([]))
  }, [])

  // --- Read aloud ---------------------------------------------------------------------------------
  const stopSpeaking = useCallback(() => {
    speakSeq.current++
    window.speechSynthesis?.cancel()
    if (audio.current) { void audio.current.close(); audio.current = null }
  }, [])

  // After a turn: listen again, or show why the microphone is not listening (off / not available).
  const backToListening = useCallback(() => {
    if (phaseRef.current === 'off') return
    setP(mic.current ? 'listening' : onRef.current ? 'error' : 'off')
  }, [setP])

  const sayWithSystem = useCallback((text: string, name: string) => new Promise<void>(resolve => {
    if (!window.speechSynthesis) return resolve()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'hu-HU'
    u.rate = rate
    const v = voices.find(x => x.name === name)
    if (v) u.voice = v
    u.onend = () => resolve()
    u.onerror = () => resolve()
    window.speechSynthesis.speak(u)
  }), [voices, rate])

  // Resolves when playback ends. While speaking, the microphone ignores input (no self-triggering).
  const say = useCallback(async (text: string) => {
    if (!speak) return
    stopSpeaking()
    const seq = speakSeq.current
    if (!voiceName.startsWith(PIPER)) { await sayWithSystem(text, voiceName); return }
    try {
      const res = await apiFetch<Response>('/api/agent-os/voice/speak', {
        method: 'POST', raw: true, body: JSON.stringify({ text, voice: voiceName.slice(PIPER.length), rate }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const wav = await res.arrayBuffer()
      if (seq !== speakSeq.current) return
      const ctx = new AudioContext()
      audio.current = ctx
      const source = ctx.createBufferSource()
      source.buffer = await ctx.decodeAudioData(wav)
      source.connect(ctx.destination)
      if (ctx.state === 'suspended') await ctx.resume()
      await new Promise<void>(resolve => {
        source.onended = () => { void ctx.close(); if (audio.current === ctx) audio.current = null; resolve() }
        source.start()
      })
    } catch {
      if (seq !== speakSeq.current) return
      await sayWithSystem(text, voices.find(v => !v.localService)?.name || voices[0]?.name || '')
    }
  }, [speak, voiceName, rate, voices, stopSpeaking, sayWithSystem])

  const chime = useCallback(() => {
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator(), gain = ctx.createGain()
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.15, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(); osc.stop(ctx.currentTime + 0.25)
      osc.onended = () => { void ctx.close() }
    } catch {}
  }, [])

  // --- Conversation -------------------------------------------------------------------------------
  const ask = useCallback(async (kerdes: string) => {
    const history = turnsRef.current
    setTurns(t => [...t, { ki: 'en' as const, szoveg: kerdes }].slice(-12))
    setP('thinking')
    try {
      const { valasz } = await apiFetch<{ valasz: string }>('/api/agent-os/voice/ask', {
        method: 'POST', body: JSON.stringify({ kerdes, elozmeny: history }), headers: { 'x-aos-device': deviceId() },
      })
      setTurns(t => [...t, { ki: 'agens' as const, szoveg: valasz }].slice(-12))
      setP('speaking')
      await say(valasz)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Az ágens nem válaszolt')
    } finally {
      backToListening()
    }
  }, [say, setP, backToListening])

  handleSegment.current = async (wav: Blob) => {
    const armed = phaseRef.current === 'armed' && Date.now() < armedUntil.current
    setP('checking')
    try {
      const form = new FormData()
      form.append('file', wav, 'hang.wav')
      if (armed) {
        const { text } = await apiFetch<{ text: string }>('/api/agent-os/voice/transcribe', { method: 'POST', body: form })
        if (text.trim()) { setError(null); await ask(text.trim()); return }
        armedUntil.current = 0
        backToListening()
        return
      }
      const { wake, text } = await apiFetch<{ wake: boolean; text: string }>('/api/agent-os/voice/wake', { method: 'POST', body: form })
      if (!wake) { backToListening(); return }
      setError(null)
      if (text) { await ask(text); return }
      chime()
      armedUntil.current = Date.now() + ARMED_MS
      setP('armed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A hangfelismerés nem sikerült')
      backToListening()
    }
  }

  // --- Microphone and segmenting ------------------------------------------------------------------
  const closeMic = useCallback(() => {
    const m = mic.current
    mic.current = null
    if (!m) return
    m.node.disconnect(); m.stream.getTracks().forEach(t => t.stop()); void m.ctx.close()
  }, [])

  const openMic = useCallback(async () => {
    if (mic.current) return
    setP('starting')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch {
      setError('A mikrofon nem érhető el (engedélyezd a böngészőben).')
      setP('error')
      return
    }
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const node = ctx.createScriptProcessor(4096, 1, 1)
    const chunkMs = (4096 / ctx.sampleRate) * 1000
    const preroll: Float32Array[] = []
    let segment: Float32Array[] | null = null
    let speechMs = 0, silenceMs = 0, noise = 0.005

    node.onaudioprocess = e => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0))
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const level = Math.sqrt(sum / data.length)
      const p = phaseRef.current
      if (p !== 'listening' && p !== 'armed') { segment = null; preroll.length = 0; return }
      if (p === 'armed' && Date.now() > armedUntil.current && !segment) setP('listening')
      const threshold = Math.max(MIN_LEVEL, noise * 3)
      if (!segment) {
        noise = noise * 0.95 + Math.min(level, threshold) * 0.05 // track the room's noise floor
        preroll.push(data)
        while (preroll.length * chunkMs > PREROLL_MS) preroll.shift()
        if (level > threshold) { segment = [...preroll]; preroll.length = 0; speechMs = chunkMs; silenceMs = 0 }
        return
      }
      segment.push(data)
      if (level > threshold) { speechMs += chunkMs; silenceMs = 0 } else silenceMs += chunkMs
      const total = segment.length * chunkMs
      if (silenceMs >= SILENCE_MS || total >= MAX_SEGMENT_MS) {
        const done = segment
        segment = null
        if (speechMs >= MIN_SPEECH_MS) void handleSegment.current(encodeWav(done, ctx.sampleRate))
      }
    }
    source.connect(node); node.connect(ctx.destination)
    mic.current = { stream, ctx, node }
    setP(ctx.state === 'suspended' ? 'needs-click' : 'listening')
  }, [setP])

  // Browsers keep audio suspended until a gesture: resume on the first click / key press.
  useEffect(() => {
    if (phase !== 'needs-click') return
    const resume = async () => {
      if (!mic.current) return
      await mic.current.ctx.resume()
      if (mic.current.ctx.state === 'running') setP('listening')
    }
    window.addEventListener('pointerdown', resume)
    window.addEventListener('keydown', resume)
    return () => { window.removeEventListener('pointerdown', resume); window.removeEventListener('keydown', resume) }
  }, [phase, setP])

  useEffect(() => {
    onRef.current = on
    if (on) void openMic()
    else { closeMic(); stopSpeaking(); setP('off') }
  }, [on, openMic, closeMic, stopSpeaking, setP])

  useEffect(() => () => { closeMic(); stopSpeaking() }, [closeMic, stopSpeaking])

  const toggle = () => {
    const next = !on
    setOn(next)
    writePref(ON_KEY, next ? '1' : '0')
    setError(null)
  }

  // "Most beszélek": skip the wake word for the next utterance.
  const talkNow = () => {
    if (!mic.current) return
    stopSpeaking()
    armedUntil.current = Date.now() + ARMED_MS
    setP('armed')
  }

  // The Jarvis core can ask for the current phase ('aos-jarvis-hello') and start a command ('aos-jarvis-talk').
  const talkRef = useRef(talkNow)
  talkRef.current = talkNow
  useEffect(() => {
    const hello = () => window.dispatchEvent(new CustomEvent('aos-jarvis-phase', { detail: phaseRef.current }))
    const talk = () => talkRef.current()
    window.addEventListener('aos-jarvis-hello', hello)
    window.addEventListener('aos-jarvis-talk', talk)
    return () => { window.removeEventListener('aos-jarvis-hello', hello); window.removeEventListener('aos-jarvis-talk', talk) }
  }, [])

  const busy = phase === 'checking' || phase === 'thinking' || phase === 'speaking'
  const dot = {
    off: 'bg-muted-foreground', starting: 'bg-yellow-400', 'needs-click': 'bg-yellow-400', listening: 'bg-green-500',
    armed: 'bg-red-500 animate-pulse', checking: 'bg-blue-400 animate-pulse', thinking: 'bg-blue-400 animate-pulse',
    speaking: 'bg-primary animate-pulse', error: 'bg-red-500',
  }[phase]
  const last = turns.slice(-2)

  // --- Dragging (pointer events on the grip; position = top-left corner, clamped to the viewport) ----
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const clamp = useCallback((x: number, y: number) => {
    const w = box.current?.offsetWidth || 200, h = box.current?.offsetHeight || 44
    return { x: Math.min(Math.max(8, x), window.innerWidth - w - 8), y: Math.min(Math.max(8, y), window.innerHeight - h - 8) }
  }, [])

  useEffect(() => {
    try {
      const saved = JSON.parse(readPref(POS_KEY) || 'null')
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) setPos(clamp(saved.x, saved.y))
    } catch {}
    const onResize = () => setPos(p => (p ? clamp(p.x, p.y) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  const onGripDown = (e: React.PointerEvent) => {
    const rect = box.current?.getBoundingClientRect()
    if (!rect) return
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onGripMove = (e: React.PointerEvent) => {
    if (drag.current) setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy))
  }
  const onGripUp = () => {
    if (!drag.current) return
    drag.current = null
    setPos(p => { if (p) writePref(POS_KEY, JSON.stringify(p)); return p })
  }
  const resetPos = () => { setPos(null); writePref(POS_KEY, 'null') }

  // --- Pop-out window ---------------------------------------------------------------------------------
  const [popup, setPopup] = useState<Window | null>(null)

  const popOut = async () => {
    try {
      // Always-on-top window where supported; a popup otherwise (or when the browser refuses it).
      let w: Window | null = null
      const pip = (window as any).documentPictureInPicture
      if (pip) {
        try { w = await pip.requestWindow({ width: 380, height: 560 }) } catch { w = null }
      }
      if (!w) w = window.open('', 'aos-jarvis', 'popup,width=380,height=600')
      if (!w) { setError('A böngésző letiltotta a külön ablakot (engedélyezd a felugró ablakokat).'); return }
      // Copy the page's CSS as constructable stylesheets (not <style> tags: the CSP nonce would block them).
      const css = [...document.styleSheets].map(sheet => {
        try { return [...sheet.cssRules].filter(r => !(r instanceof CSSImportRule)).map(r => r.cssText).join('\n') } catch { return '' }
      }).join('\n')
      try {
        const sheet = new (w as any).CSSStyleSheet()
        sheet.replaceSync(css)
        w.document.adoptedStyleSheets = [sheet]
      } catch {
        // Unstyled is still usable; keep going.
      }
      w.document.title = 'Jarvis'
      w.document.documentElement.className = document.documentElement.className
      w.document.body.className = 'bg-background text-foreground m-0'
      w.document.body.innerHTML = ''
      const closed = () => setPopup(null)
      w.addEventListener('pagehide', closed)
      w.addEventListener('beforeunload', closed)
      setOpen(false)
      setPopup(w)
    } catch {
      setError('A külön ablak nem nyitható meg ebben a böngészőben.')
    }
  }
  const popIn = () => { popup?.close(); setPopup(null); setOpen(true) }
  useEffect(() => () => { popup?.close() }, [popup])

  const panel = (inWindow: boolean) => (
    <div className={inWindow ? 'p-3 space-y-2 text-sm' : 'w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-3 shadow-lg space-y-2 text-sm'}
      role="dialog" aria-label="Hang-asszisztens">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="font-semibold text-foreground">Jarvis</span>
        <span className="text-xs text-muted-foreground" role="status" aria-live="polite">{STATUS[phase]}</span>
        <span className="ml-auto flex items-center gap-2">
          {inWindow
            ? <button type="button" className="text-xs text-muted-foreground hover:text-foreground" title="Vissza az oldalra" onClick={popIn}>⇲ Vissza</button>
            : <button type="button" className="text-muted-foreground hover:text-foreground" title="Külön ablakban" aria-label="Külön ablakban" onClick={() => void popOut()}>⧉</button>}
          {!inWindow && <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Bezárás" onClick={() => setOpen(false)}>✕</button>}
        </span>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className={`space-y-1 overflow-auto ${inWindow ? 'max-h-[50vh]' : 'max-h-48'}`}>
        {last.length === 0 && <div className="text-xs text-muted-foreground">Mondd, hogy „Jarvis”, és utána a kérdést, például: „Jarvis, mi van holnap a heti tervben?”</div>}
        {(inWindow ? turns.slice(-8) : last).map((t, i) => (
          <div key={i} className={`rounded px-2 py-1 border ${t.ki === 'en' ? 'border-border bg-secondary' : 'border-primary/40'}`}>
            <div className="text-[11px] text-muted-foreground flex gap-2">
              {t.ki === 'en' ? 'Te' : 'Jarvis'}
              {t.ki === 'agens' && <button type="button" className="text-primary underline" onClick={() => void say(t.szoveg)}>újra</button>}
            </div>
            <div className="text-foreground whitespace-pre-wrap break-words">{t.szoveg}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={toggle} aria-pressed={on} title={on ? 'Hang kikapcsolása' : 'Hang bekapcsolása'}
          className={`rounded border px-2 py-0.5 text-xs ${on ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-secondary text-muted-foreground'}`}>
          {on ? '🎙️ Be' : '🔇 Ki'}
        </button>
        <label className="text-xs text-muted-foreground flex items-center gap-1">
          <input type="checkbox" checked={speak} onChange={e => { setSpeak(e.target.checked); writePref(SPEAK_KEY, e.target.checked ? '1' : '0'); if (!e.target.checked) stopSpeaking() }} />
          Felolvasás
        </label>
        <select aria-label="Hang" className="flex-1 min-w-0 rounded border border-border bg-secondary px-1 py-0.5 text-xs text-foreground" value={voiceName}
          onChange={e => { setVoiceName(e.target.value); writePref(VOICE_KEY, e.target.value) }} disabled={voices.length === 0 && piperVoices.length === 0}>
          {voices.length === 0 && piperVoices.length === 0 && <option value="">Nincs magyar hang</option>}
          {piperVoices.length > 0 && <optgroup label="Helyi (Piper)">
            {piperVoices.map(id => <option key={id} value={PIPER + id}>{piperLabel(id)}</option>)}
          </optgroup>}
          {voices.length > 0 && <optgroup label="Rendszerhang">
            {voices.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
          </optgroup>}
        </select>
        <select aria-label="Felolvasás sebessége" className="rounded border border-border bg-secondary px-1 py-0.5 text-xs text-foreground" value={rate}
          onChange={e => { const r = Number(e.target.value); setRate(r); writePref(RATE_KEY, String(r)) }}>
          {RATES.map(r => <option key={r} value={r}>{String(r).replace('.', ',')}×</option>)}
        </select>
      </div>
      <form className="flex gap-1" onSubmit={e => { e.preventDefault(); const q = typed.trim(); if (q && !busy) { setTyped(''); setError(null); stopSpeaking(); void ask(q) } }}>
        <input className="flex-1 min-w-0 rounded border border-border bg-secondary px-2 py-1 text-xs text-foreground" placeholder="…vagy írd be a kérdést"
          value={typed} onChange={e => setTyped(e.target.value)} disabled={busy} maxLength={2000} />
        <Button type="submit" size="xs" disabled={busy || !typed.trim()}>Küldés</Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={talkNow} disabled={!on || busy || phase === 'needs-click'}>Most beszélek</Button>
        {turns.length > 0 && <Button size="xs" variant="ghost" onClick={() => { setTurns([]); stopSpeaking() }}>Új beszélgetés</Button>}
        {!inWindow && pos && <Button size="xs" variant="ghost" onClick={resetPos}>Gomb a sarokba</Button>}
      </div>
    </div>
  )

  // Open the panel upwards when the button sits in the lower half of the screen, downwards otherwise.
  const upward = !pos || pos.y > (typeof window === 'undefined' ? 0 : window.innerHeight / 2)
  const placement = pos ? { left: pos.x, top: pos.y } : undefined

  return (
    <>
      <div ref={box} style={placement}
        className={`fixed z-40 flex ${upward ? 'flex-col-reverse' : 'flex-col'} items-end gap-2 ${pos ? '' : 'right-4 bottom-20 md:bottom-4'}`}>
        <div className="flex items-center gap-1 rounded-full border border-border bg-card shadow-lg pl-1 pr-1 py-1">
          <span className="cursor-grab active:cursor-grabbing touch-none select-none px-1 text-muted-foreground" title="Húzd el, hogy máshová tedd"
            aria-label="Hanggomb mozgatása" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}>⠿</span>
          <button type="button" className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => (popup ? popup.focus() : setOpen(o => !o))} aria-expanded={open} title={popup ? 'Külön ablakban nyitva' : STATUS[phase]}>
            <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
            <span className="hidden sm:inline">{popup ? 'Külön ablakban' : STATUS[phase]}</span>
          </button>
          <button type="button" onClick={toggle} aria-pressed={on} aria-label={on ? 'Hang kikapcsolása' : 'Hang bekapcsolása'}
            title={on ? 'Hang kikapcsolása' : 'Hang bekapcsolása'}
            className={`h-8 w-8 rounded-full text-base border transition-colors ${on ? 'border-primary bg-primary/10' : 'border-border bg-secondary opacity-70'}`}>
            {on ? '🎙️' : '🔇'}
          </button>
        </div>
        {open && !popup && panel(false)}
      </div>
      {popup && createPortal(panel(true), popup.document.body)}
    </>
  )
}
