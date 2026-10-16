/**
 * Agent OS voice (fork addition): speech-to-text through a local whisper.cpp server and one-shot
 * questions to the voice agent through the Agent OS runner (agents/runner/ask-agent.mjs).
 *
 * Env:
 *   AOS_WHISPER_URL   whisper-server /inference endpoint (default http://127.0.0.1:8178/inference)
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

export async function transcribe(audio: Blob): Promise<string> {
  if (audio.size === 0) throw new VoiceError('Empty recording', 400)
  if (audio.size > MAX_AUDIO_BYTES) throw new VoiceError('Recording too long', 413)
  const form = new FormData()
  form.append('file', audio, 'hang.wav')
  form.append('response_format', 'json')
  form.append('language', 'hu')
  form.append('temperature', '0')
  let res: Response
  try {
    res = await fetch(WHISPER_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) })
  } catch {
    throw new VoiceError('Speech recognition server is not reachable', 503)
  }
  if (!res.ok) throw new VoiceError(`Speech recognition failed (HTTP ${res.status})`, 502)
  const json = await res.json().catch(() => ({})) as { text?: string }
  return (json.text || '').replace(/\s+/g, ' ').trim()
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
