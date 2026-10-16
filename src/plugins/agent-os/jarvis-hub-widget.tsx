'use client'

/**
 * Agent OS – "Jarvis" dashboard centrepiece (fork addition). An animated core (rotating rings, glowing
 * centre) that follows the voice button's state, with the key functions arranged around it and linked
 * to it. Clicking the core starts a command without the wake word ("Most beszélek").
 * State: window events from voice-assistant.tsx ('aos-jarvis-phase'); data: /api/agent-os/overview.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useMissionControl } from '@/store'
import { useNavigateToPanel } from '@/lib/navigation'
import type { FunctionStatus } from '@/lib/agent-os/functions-catalog'
import { relativeTime } from './funkciok-panel'

type Phase = 'off' | 'starting' | 'needs-click' | 'listening' | 'armed' | 'checking' | 'thinking' | 'speaking' | 'error'

const PHASE_LOOK: Record<Phase, { color: string; label: string; speed: number }> = {
  off: { color: '#64748b', label: 'Alszik', speed: 0 },
  starting: { color: '#facc15', label: 'Ébred…', speed: 1 },
  'needs-click': { color: '#facc15', label: 'Kattints bárhová', speed: 0.6 },
  listening: { color: '#22d3ee', label: 'Mondd: „Jarvis, …”', speed: 1 },
  armed: { color: '#f43f5e', label: 'Hallgatlak…', speed: 2 },
  checking: { color: '#60a5fa', label: 'Feldolgozás…', speed: 2.5 },
  thinking: { color: '#a78bfa', label: 'Gondolkodom…', speed: 3 },
  speaking: { color: '#34d399', label: 'Beszélek…', speed: 1.8 },
  error: { color: '#ef4444', label: 'A hang nem érhető el', speed: 0.4 },
}

// Satellites: [function id, side]. Left column top→bottom, then right column top→bottom.
const LEFT = ['tasks', 'agents', 'heti-terv']
const RIGHT = ['hang', 'integrations', 'activity']
const TITLE: Record<string, string> = { tasks: 'Feladatok', agents: 'Ágensek', 'heti-terv': 'Heti terv', hang: 'Hang', integrations: 'Integrációk', activity: 'Tevékenység' }
const DOT: Record<FunctionStatus['state'], string> = { ok: 'bg-green-500', warn: 'bg-yellow-400', idle: 'bg-muted-foreground', off: 'bg-red-500/60' }

const CSS = `
@keyframes aosSpin { to { transform: rotate(360deg) } }
@keyframes aosSpinRev { to { transform: rotate(-360deg) } }
@keyframes aosBreath { 0%,100% { transform: scale(1); opacity: .85 } 50% { transform: scale(1.08); opacity: 1 } }
@keyframes aosWave { 0% { transform: scale(.6); opacity: .7 } 100% { transform: scale(1.5); opacity: 0 } }
@keyframes aosFlow { to { stroke-dashoffset: -24 } }
.aos-ring { transform-origin: 50% 50%; transform-box: fill-box }
@media (prefers-reduced-motion: reduce) { .aos-anim { animation: none !important } }
`

function Satellite({ id, s, align, onOpen }: { id: string; s?: FunctionStatus; align: 'left' | 'right'; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className={`group w-full rounded-lg border border-border bg-card/80 p-3 text-left backdrop-blur transition-colors hover:border-primary/60 ${align === 'right' ? 'lg:text-right' : ''}`}>
      <div className={`flex items-center gap-2 ${align === 'right' ? 'lg:flex-row-reverse' : ''}`}>
        <span className={`h-2.5 w-2.5 rounded-full ${DOT[s?.state || 'idle']}`} />
        <span className="text-sm font-semibold text-foreground">{TITLE[id]}</span>
        <span className={`text-[11px] text-muted-foreground ${align === 'right' ? 'lg:mr-auto' : 'ml-auto'}`}>{relativeTime(s?.lastChange)}</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground truncate">{s?.summary || '…'}</div>
      {s?.progress !== undefined && (
        <div className="mt-2 h-1 rounded bg-secondary overflow-hidden"><div className="h-full bg-primary" style={{ width: `${Math.round(s.progress * 100)}%` }} /></div>
      )}
    </button>
  )
}

function Core({ phase, onTalk }: { phase: Phase; onTalk: () => void }) {
  const look = PHASE_LOOK[phase]
  const spin = (base: number, rev = false) => look.speed
    ? { animation: `${rev ? 'aosSpinRev' : 'aosSpin'} ${base / look.speed}s linear infinite` }
    : undefined
  const c = look.color
  return (
    <div className="flex flex-col items-center gap-2">
      <button type="button" onClick={onTalk} title="Kattints, és mondd a parancsot (ébresztőszó nélkül)" aria-label="Jarvis: szólj hozzá"
        className="relative h-56 w-56 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        {(phase === 'speaking' || phase === 'armed') && (
          <span className="aos-anim absolute inset-6 rounded-full border-2" style={{ borderColor: c, animation: 'aosWave 1.6s ease-out infinite' }} />
        )}
        <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <radialGradient id="aosCore" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
              <stop offset="35%" stopColor={c} stopOpacity="0.9" />
              <stop offset="100%" stopColor={c} stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="100" cy="100" r="96" fill="none" stroke={c} strokeOpacity="0.15" strokeWidth="1" />
          <g className="aos-ring aos-anim" style={spin(40)}>
            <circle cx="100" cy="100" r="88" fill="none" stroke={c} strokeOpacity="0.5" strokeWidth="2" strokeDasharray="40 14 6 14" />
          </g>
          <g className="aos-ring aos-anim" style={spin(24, true)}>
            <circle cx="100" cy="100" r="74" fill="none" stroke={c} strokeOpacity="0.7" strokeWidth="5" strokeDasharray="70 30" strokeLinecap="round" />
          </g>
          <g className="aos-ring aos-anim" style={spin(12)}>
            <circle cx="100" cy="100" r="60" fill="none" stroke={c} strokeOpacity="0.9" strokeWidth="1.5" strokeDasharray="4 6" />
          </g>
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i * 30 * Math.PI) / 180
            return <line key={i} x1={100 + 46 * Math.cos(a)} y1={100 + 46 * Math.sin(a)} x2={100 + 52 * Math.cos(a)} y2={100 + 52 * Math.sin(a)} stroke={c} strokeOpacity="0.8" strokeWidth="2" />
          })}
          <g className="aos-ring aos-anim" style={look.speed ? { animation: `aosBreath ${2.4 / Math.max(look.speed, 0.6)}s ease-in-out infinite` } : undefined}>
            <circle cx="100" cy="100" r="34" fill="url(#aosCore)" />
            <circle cx="100" cy="100" r="18" fill="none" stroke="#ffffff" strokeOpacity="0.8" strokeWidth="1.5" />
          </g>
        </svg>
      </button>
      <div className="text-center">
        <div className="text-lg font-semibold tracking-[0.3em] text-foreground">JARVIS</div>
        <div className="text-xs" style={{ color: c }} role="status" aria-live="polite">{look.label}</div>
      </div>
    </div>
  )
}

export function JarvisHubWidget() {
  const { dashboardMode } = useMissionControl()
  const navigate = useNavigateToPanel()
  const [phase, setPhase] = useState<Phase>('off')
  const [statuses, setStatuses] = useState<Record<string, FunctionStatus>>({})

  useEffect(() => {
    const onPhase = (e: Event) => setPhase((e as CustomEvent<Phase>).detail || 'off')
    window.addEventListener('aos-jarvis-phase', onPhase)
    window.dispatchEvent(new Event('aos-jarvis-hello'))
    return () => window.removeEventListener('aos-jarvis-phase', onPhase)
  }, [])

  const load = useCallback(async () => {
    try {
      const { functions } = await apiFetch<{ functions: FunctionStatus[] }>(`/api/agent-os/overview?part=functions&mode=${dashboardMode === 'local' ? 'local' : 'full'}`)
      setStatuses(Object.fromEntries(functions.map(f => [f.id, f])))
    } catch {}
  }, [dashboardMode])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  const open = (id: string) => (id === 'hang' ? window.dispatchEvent(new Event('aos-jarvis-talk')) : navigate(id))
  const color = PHASE_LOOK[phase].color

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card p-4">
      <style>{CSS}</style>
      {/* Connecting lines (desktop): from each satellite row to the core */}
      <svg className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {[18, 50, 82].flatMap(y => [
          <line key={`l${y}`} x1="30" y1={y} x2="44" y2="50" stroke={color} strokeOpacity="0.35" strokeWidth="0.25" strokeDasharray="1.5 1.5" className="aos-anim" style={{ animation: 'aosFlow 3s linear infinite' }} vectorEffect="non-scaling-stroke" />,
          <line key={`r${y}`} x1="70" y1={y} x2="56" y2="50" stroke={color} strokeOpacity="0.35" strokeWidth="0.25" strokeDasharray="1.5 1.5" className="aos-anim" style={{ animation: 'aosFlow 3s linear infinite' }} vectorEffect="non-scaling-stroke" />,
        ])}
      </svg>
      <div className="relative grid items-center gap-4 lg:grid-cols-[1fr_auto_1fr]">
        <div className="order-2 grid gap-3 sm:grid-cols-3 lg:order-1 lg:grid-cols-1">
          {LEFT.map(id => <Satellite key={id} id={id} s={statuses[id]} align="left" onOpen={() => open(id)} />)}
        </div>
        <div className="order-1 flex justify-center lg:order-2 lg:px-6">
          <Core phase={phase} onTalk={() => window.dispatchEvent(new Event('aos-jarvis-talk'))} />
        </div>
        <div className="order-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
          {RIGHT.map(id => <Satellite key={id} id={id} s={statuses[id]} align="right" onOpen={() => open(id)} />)}
        </div>
      </div>
    </div>
  )
}
