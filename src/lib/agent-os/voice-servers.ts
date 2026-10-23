/**
 * Agent OS – the voice servers as Mission Control's own child processes (fork addition, 2026-10-23).
 *
 * Decision: when Mission Control starts, it starts and supervises the local voice servers, and stops them
 * when it stops – one thing to start on every machine (on the Mac mini the separate launchd jobs
 * com.agentos.whisper, -whisper-wake and -piper are gone). Started from src/instrumentation.ts.
 *   - whisper-wake: small model, the "Jarvis" wake word (port of AOS_WAKE_URL, default 8177)
 *   - whisper:      large model for commands (port of AOS_WHISPER_URL, default 8178) – only when its port
 *                   differs from the wake port (on the Windows trial both URLs point to the small one)
 *   - piper:        read-aloud (port of AOS_PIPER_URL, default 8179)
 * A server whose port already answers is left alone (started elsewhere) – unless it is our own orphan: the
 * pid files (<log dir>/<name>.pid) remember what we started, so after a forced stop (Windows Stop-Process
 * -Force runs no exit handler) the next start stops that orphan and takes it over again. A crashed server is restarted
 * after 5 s, 30 s, 2 min; after 5 crashes within 15 minutes it stays down until Mission Control restarts.
 *
 * Env: AOS_VOICE_SERVERS=1 (on), AOS_WHISPER_BIN, AOS_WAKE_MODEL, AOS_WHISPER_MODEL, AOS_WHISPER_THREADS (4),
 *      AOS_WHISPER_ARGS (extra, e.g. "-fa"), AOS_PIPER_PYTHON, AOS_PIPER_VOICE (default the first of
 *      AOS_PIPER_VOICES), AOS_PIPER_DATA_DIR, AOS_VOICE_LOG_DIR (default <MC dir>/../logs).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export type VoiceServerState = 'indul' | 'fut' | 'kulso' | 'ujraindul' | 'leallt' | 'hianyzik'

export interface VoiceServer {
  name: 'whisper-wake' | 'whisper' | 'piper'
  port: number
  cmd: string
  args: string[]
  cwd?: string
  state: VoiceServerState
  pid: number | null
  restarts: number
  crashes: number[]
  lastExit: string | null
  startedAt: string | null
  child?: ChildProcess
}

const g = globalThis as typeof globalThis & { __aosVoice?: { servers: VoiceServer[]; stopping: boolean } }

const portOf = (url: string | undefined, dflt: number) => {
  try { return Number(new URL(url || '').port) || dflt } catch { return dflt }
}

function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.setTimeout(800, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

function definitions(): VoiceServer[] {
  const out: VoiceServer[] = []
  const base = { state: 'indul' as const, pid: null, restarts: 0, crashes: [], lastExit: null, startedAt: null }
  const bin = process.env.AOS_WHISPER_BIN
  const threads = String(Number(process.env.AOS_WHISPER_THREADS) || 4)
  const extra = (process.env.AOS_WHISPER_ARGS || '').split(/\s+/).filter(Boolean)
  const whisperArgs = (model: string, port: number) => ['-m', model, '-l', 'hu', '-t', threads, ...extra, '-nt', '--host', '127.0.0.1', '--port', String(port)]
  const wakePort = portOf(process.env.AOS_WAKE_URL, 8177)
  const fullPort = portOf(process.env.AOS_WHISPER_URL, 8178)
  if (bin && process.env.AOS_WAKE_MODEL) {
    out.push({ ...base, crashes: [], name: 'whisper-wake', port: wakePort, cmd: bin, args: whisperArgs(process.env.AOS_WAKE_MODEL, wakePort), cwd: path.dirname(bin) })
  }
  if (bin && process.env.AOS_WHISPER_MODEL && fullPort !== wakePort) {
    out.push({ ...base, crashes: [], name: 'whisper', port: fullPort, cmd: bin, args: whisperArgs(process.env.AOS_WHISPER_MODEL, fullPort), cwd: path.dirname(bin) })
  }
  const py = process.env.AOS_PIPER_PYTHON
  if (py) {
    const voice = process.env.AOS_PIPER_VOICE || (process.env.AOS_PIPER_VOICES || 'hu_HU-anna-medium').split(',')[0].trim()
    const port = portOf(process.env.AOS_PIPER_URL, 8179)
    out.push({
      ...base, crashes: [], name: 'piper', port, cmd: py,
      args: ['-m', 'piper.http_server', '-m', voice, ...(process.env.AOS_PIPER_DATA_DIR ? ['--data-dir', process.env.AOS_PIPER_DATA_DIR] : []), '--host', '127.0.0.1', '--port', String(port)],
      cwd: process.env.AOS_PIPER_DATA_DIR ? path.dirname(process.env.AOS_PIPER_DATA_DIR) : undefined,
    })
  }
  return out
}

const pidFile = (s: VoiceServer) => path.join(logDir(), `${s.name}.pid`)
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

const logDir = () => process.env.AOS_VOICE_LOG_DIR || path.resolve(process.cwd(), '..', 'logs')
const RESTART_DELAYS = [5_000, 30_000, 120_000]

function launch(s: VoiceServer) {
  const state = g.__aosVoice!
  if (state.stopping) return
  if (!fs.existsSync(s.cmd)) { s.state = 'hianyzik'; s.lastExit = `nincs ilyen program: ${s.cmd}`; return }
  fs.mkdirSync(logDir(), { recursive: true })
  const log = fs.openSync(path.join(logDir(), `${s.name}.log`), 'a')
  fs.writeSync(log, `\n--- ${new Date().toISOString()} indítás (Mission Control) ---\n`)
  const child = spawn(s.cmd, s.args, { cwd: s.cwd, stdio: ['ignore', log, log], windowsHide: true })
  fs.closeSync(log)
  s.child = child
  s.pid = child.pid ?? null
  if (s.pid) try { fs.writeFileSync(pidFile(s), String(s.pid)) } catch {}
  s.state = 'fut'
  s.startedAt = new Date().toISOString()
  child.once('error', err => { s.lastExit = `nem indult: ${err.message}` })
  child.once('exit', (code, signal) => {
    s.child = undefined
    s.pid = null
    try { fs.unlinkSync(pidFile(s)) } catch {}
    if (state.stopping) { s.state = 'leallt'; return }
    s.lastExit = `${new Date().toISOString()} kilépett (${signal || `kód ${code}`})`
    const now = Date.now()
    s.crashes = [...s.crashes.filter(t => now - t < 15 * 60_000), now]
    if (s.crashes.length >= 5) { s.state = 'leallt'; console.error(`[agent-os] ${s.name}: 15 percen belül 5× összeomlott, nem indítom újra`); return }
    s.state = 'ujraindul'
    const delay = RESTART_DELAYS[Math.min(s.crashes.length - 1, RESTART_DELAYS.length - 1)]
    setTimeout(() => { s.restarts++; launch(s) }, delay).unref()
  })
}

function stopAll() {
  const state = g.__aosVoice
  if (!state || state.stopping) return
  state.stopping = true
  for (const s of state.servers) { try { s.child?.kill() } catch {} }
}

/** Starts the configured voice servers once per Mission Control process. */
export async function startVoiceServers() {
  if (process.env.AOS_VOICE_SERVERS !== '1' || g.__aosVoice) return
  const servers = definitions()
  g.__aosVoice = { servers, stopping: false }
  for (const s of servers) {
    if (await isListening(s.port)) {
      // Our own orphan from a forced stop? Then stop it and supervise a fresh one; anything else is left alone.
      let old = 0
      try { old = Number(fs.readFileSync(pidFile(s), 'utf8')) } catch {}
      if (old && alive(old)) {
        try { process.kill(old) } catch {}
        for (let i = 0; i < 20 && (await isListening(s.port)); i++) await new Promise(res => setTimeout(res, 250))
      }
      if (await isListening(s.port)) { s.state = 'kulso'; continue }
    }
    launch(s)
  }
  process.once('exit', stopAll)
  // Stop the children on a signal too; exit only if nothing else (Next.js) handles that signal.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => { stopAll(); if (process.listenerCount(sig) === 0) process.exit(0) })
  }
  console.log(`[agent-os] hangszerverek: ${servers.map(s => `${s.name}:${s.port} ${s.state}`).join(', ') || 'nincs beállítva'}`)
}

/** For the voice status (Funkciók / Jarvis): what the supervisor knows. */
export function voiceServersStatus() {
  const state = g.__aosVoice
  if (!state) return { enabled: process.env.AOS_VOICE_SERVERS === '1', servers: [] }
  return {
    enabled: true,
    servers: state.servers.map(({ child, cmd, args, cwd, crashes, ...s }) => ({ ...s, crashesLast15min: crashes.length })),
  }
}
