/**
 * Agent OS voice (fork addition): speech-to-text through a local whisper.cpp server, text-to-speech
 * through a local Piper server, and one-shot questions to the voice agent through the Agent OS runner
 * (agents/runner/ask-agent.mjs).
 *
 * Env:
 *   AOS_WHISPER_URL   whisper-server /inference endpoint (default http://127.0.0.1:8178/inference)
 *   AOS_WAKE_URL      small, fast whisper-server for wake-word checks (default http://127.0.0.1:8177/inference)
 *   AOS_WAKE_WORDS    accepted spellings of the wake word (default: Jarvis and its Hungarian transcriptions)
 *   AOS_PIPER_URL     Piper HTTP server base URL (default http://127.0.0.1:8179)
 *   AOS_PIPER_VOICES  voices offered in the Hang tab (default the three Hungarian medium voices)
 *   AOS_RUNNER_DIR    directory of ask-agent.mjs (default ~/agent-os/os/agents/runner)
 *   AOS_VOICE_AGENT   agent profile used for voice (default hang-asszisztens)
 *   AOS_HOME, AOS_AGENT_KEYS are passed through to the runner.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export class VoiceError extends Error {
  constructor(message: string, public status = 500) { super(message) }
}

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024 // ~5 min of 16 kHz mono PCM
const WHISPER_URL = process.env.AOS_WHISPER_URL || 'http://127.0.0.1:8178/inference'
const RUNNER_DIR = process.env.AOS_RUNNER_DIR || path.join(os.homedir(), 'agent-os', 'os', 'agents', 'runner')
const VOICE_AGENT = process.env.AOS_VOICE_AGENT || 'hang-asszisztens'

export async function transcribe(audio: Blob, { url = WHISPER_URL, prompt = '' } = {}): Promise<string> {
  if (audio.size === 0) throw new VoiceError('Empty recording', 400)
  if (audio.size > MAX_AUDIO_BYTES) throw new VoiceError('Recording too long', 413)
  const form = new FormData()
  form.append('file', audio, 'hang.wav')
  form.append('response_format', 'json')
  form.append('language', 'hu')
  form.append('temperature', '0')
  if (prompt) form.append('prompt', prompt)
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) })
  } catch {
    throw new VoiceError('Speech recognition server is not reachable', 503)
  }
  if (!res.ok) throw new VoiceError(`Speech recognition failed (HTTP ${res.status})`, 502)
  const json = await res.json().catch(() => ({})) as { text?: string }
  return (json.text || '').replace(/\s+/g, ' ').trim()
}

// --- Wake word ---------------------------------------------------------------------------------------
const WAKE_URL = process.env.AOS_WAKE_URL || 'http://127.0.0.1:8177/inference'
export const MAX_WAKE_BYTES = 20 * 16000 * 2 + 44 // 20 s of 16 kHz mono PCM
const fold = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const WAKE_WORDS = (process.env.AOS_WAKE_WORDS || 'jarvis').split(',').map(fold).filter(Boolean)

// Spelling-tolerant: whisper writes "Jarvis" as Jarrvis, Dzsárvisz, Jarvisz, Gyarvis... in Hungarian.
const canon = (w: string) => w.replace(/^(dzs|dz|gy|dj|zs)/, 'j').replace(/sz/g, 's').replace(/y/g, 'i').replace(/(.)\1+/g, '$1')
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  return d[a.length][b.length]
}
const isWakeWord = (word: string) => WAKE_WORDS.some(w => distance(canon(word), canon(w)) <= 1)

export interface WakeResult { wake: boolean; text: string }

// Initial prompt: biases whisper towards the wake word. Keep it short: long prompts make the small
// model drop the start of the segment (the wake word itself).
const WAKE_PROMPT = 'Jarvis, heti terv'

// Checks a speech segment for the wake word with the small model. Only when it starts with the wake
// word (within the first three words) is the segment transcribed again with the large model; anything
// else is dropped here, so background talk never reaches the agent. text = the command after the wake
// word ('' when only the wake word was said). When AOS_WAKE_URL and AOS_WHISPER_URL point to the same
// server (a machine without room for two models), its first transcript is reused.
export async function detectWake(audio: Blob): Promise<WakeResult> {
  if (audio.size > MAX_WAKE_BYTES) throw new VoiceError('Segment too long', 413)
  const raw = await transcribe(audio, { url: WAKE_URL, prompt: WAKE_PROMPT })
  const words = fold(raw).split(' ').filter(Boolean)
  const at = words.slice(0, 3).findIndex(isWakeWord)
  if (at < 0) return { wake: false, text: '' }
  if (words.length - at - 1 < 2) return { wake: true, text: '' }
  const full = WAKE_URL === WHISPER_URL ? raw : await transcribe(audio, { prompt: WAKE_PROMPT })
  // Drop the wake word and what precedes it from the accurate transcript.
  const tokens = full.split(' ')
  const cut = tokens.slice(0, 4).findIndex(w => isWakeWord(fold(w)))
  const text = (cut >= 0 ? tokens.slice(cut + 1) : tokens).join(' ').replace(/^[\s,.!?:;–-]+/, '').trim()
  return { wake: true, text }
}

const PIPER_URL = (process.env.AOS_PIPER_URL || 'http://127.0.0.1:8179').replace(/\/+$/, '')
const PIPER_VOICES = (process.env.AOS_PIPER_VOICES || 'hu_HU-anna-medium,hu_HU-imre-medium,hu_HU-berta-medium')
  .split(',').map(s => s.trim()).filter(v => /^[a-z]{2}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$/.test(v))
export const MAX_SPEAK_CHARS = 2000

// Configured voices that the Piper server actually has; [] when the server is not running.
export async function piperVoices(): Promise<string[]> {
  try {
    const res = await fetch(`${PIPER_URL}/voices`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const available = Object.keys(await res.json() as Record<string, unknown>)
    return PIPER_VOICES.filter(v => available.includes(v))
  } catch {
    return []
  }
}

// Returns a WAV file. rate 1 = normal speed (Piper's length_scale is the inverse).
export async function synthesize(text: string, voice: string, rate: number): Promise<ArrayBuffer> {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean || clean.length > MAX_SPEAK_CHARS) throw new VoiceError('Empty or too long text', 400)
  if (!PIPER_VOICES.includes(voice)) throw new VoiceError('Unknown voice', 400)
  if (!Number.isFinite(rate) || rate < 0.5 || rate > 2.5) throw new VoiceError('Invalid speed', 400)
  let res: Response
  try {
    res = await fetch(`${PIPER_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: clean, voice, length_scale: Number((1 / rate).toFixed(3)) }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new VoiceError('Speech synthesis server is not reachable', 503)
  }
  if (!res.ok) throw new VoiceError(`Speech synthesis failed (HTTP ${res.status})`, 502)
  return res.arrayBuffer()
}

export interface Turn { ki: 'en' | 'agens'; szoveg: string }

export function askAgent(kerdes: string, elozmeny: Turn[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(RUNNER_DIR, 'ask-agent.mjs'), '--agent', VOICE_AGENT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MC_URL: process.env.MC_URL || `http://127.0.0.1:${process.env.PORT || 3000}` },
    })
    const out: Buffer[] = []
    child.stdout.on('data', d => out.push(d))
    child.stderr.on('data', () => {})
    child.on('error', () => reject(new VoiceError('Voice agent could not be started', 500)))
    child.on('close', () => {
      let result: { valasz?: string; hiba?: string } = {}
      try { result = JSON.parse(Buffer.concat(out).toString('utf8')) } catch {}
      if (typeof result.valasz === 'string' && result.valasz) resolve(result.valasz)
      else reject(new VoiceError(result.hiba || 'Voice agent returned no answer', 502))
    })
    child.stdin.end(JSON.stringify({ kerdes, elozmeny }))
  })
}
