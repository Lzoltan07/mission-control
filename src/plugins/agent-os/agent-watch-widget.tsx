'use client'

/**
 * Agent OS – "Ágensfigyelő" dashboard widget (fork addition).
 *   Primary row: the four runtimes – Claude Code, Codex, OpenClaw, Hermes – with everything Mission
 *   Control knows about them: installed/version/login, running now, active and today's sessions,
 *   tokens and cost today, current work, Agent OS agents and their tasks, last activity.
 *   Optional row: up to four individual agents you pick (runner working, current task, progress,
 *   last activity, key expiry). The choice is remembered per browser.
 * Data: /api/agent-os/overview?part=runtimes and ?part=agents (refreshed every 15 s).
 */
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useNavigateToPanel } from '@/lib/navigation'
import type { AgentWatch, RuntimeWatch } from '@/lib/agent-os/functions-catalog'
import { relativeTime } from './funkciok-panel'

const EXTRA_KEY = 'aos-agent-watch-extra'
const MAX_EXTRA = 4
const STATUS_HU: Record<string, string> = { assigned: 'Kiosztva', in_progress: 'Folyamatban', review: 'Ellenőrzés', quality_review: 'Minőségellenőrzés' }
const RUNTIME_ICON: Record<RuntimeWatch['id'], string> = { claude: '✳️', codex: '🧬', openclaw: '🦞', hermes: '🪽' }

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

function readExtra(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(EXTRA_KEY) || '[]')
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX_EXTRA)
  } catch {}
  return []
}

function Row({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground text-right truncate" title={title}>{value}</span>
    </div>
  )
}

function RuntimeCard({ r, onOpen }: { r: RuntimeWatch; onOpen: () => void }) {
  const state = !r.installed ? ['nincs telepítve', 'bg-muted-foreground/50'] : r.running ? ['dolgozik', 'bg-green-500 animate-pulse'] : !r.authenticated ? ['nincs bejelentkezve', 'bg-yellow-400'] : ['készenlétben', 'bg-sky-300']
  return (
    <div className={`rounded-md border border-border bg-surface-2 p-2.5 text-xs space-y-1 ${r.installed ? '' : 'opacity-70'}`}>
      <div className="flex items-center gap-2">
        <span aria-hidden>{RUNTIME_ICON[r.id]}</span>
        <button type="button" className="font-semibold text-foreground hover:underline" onClick={onOpen}>{r.name}</button>
        <span className={`ml-auto h-2.5 w-2.5 rounded-full ${state[1]}`} />
        <span className="text-muted-foreground">{state[0]}</span>
      </div>
      {r.note ? <div className="text-muted-foreground">{r.note}</div> : <Row label="Verzió" value={r.version || '–'} />}
      <Row label="Most dolgozik rajta" value={r.currentWork || '–'} title={r.currentWork || undefined} />
      <Row label="Aktív / mai munkamenet" value={`${r.activeSessions} / ${r.sessionsToday}`} />
      <Row label="Mai munkamenetek tokenje" value={fmtTokens(r.tokensToday)} title="A ma aktív munkamenetek teljes tokenszáma" />
      {r.costToday !== null && <Row label="…becsült költsége" value={`${r.costToday.toFixed(2)} USD`} title="A ma aktív munkamenetek becsült teljes költsége" />}
      <Row label="Ágensek (fut)" value={`${r.agents}${r.runningAgents.length ? ` (${r.runningAgents.join(', ')})` : ''}`} title={r.runningAgents.join(', ')} />
      <div>
        <Row label="Feladatok" value={`${r.openTasks} nyitott, ${r.doneTasks} kész`} />
        {r.openTasks + r.doneTasks > 0 && (
          <div className="mt-0.5 h-1.5 rounded bg-secondary overflow-hidden"><div className="h-full bg-primary" style={{ width: `${Math.round((r.doneTasks / (r.openTasks + r.doneTasks)) * 100)}%` }} /></div>
        )}
      </div>
      <Row label="Utolsó tevékenység" value={relativeTime(r.lastActivity || undefined)} title={r.lastActivity ? new Date(r.lastActivity).toLocaleString('hu-HU') : undefined} />
    </div>
  )
}

function AgentCard({ name, w, onOpen, onRemove }: { name: string; w?: AgentWatch; onOpen: () => void; onRemove: () => void }) {
  const pct = w && w.total ? Math.round((w.done / w.total) * 100) : 0
  const keyDays = w?.keyExpires ? Math.ceil((new Date(w.keyExpires).getTime() - Date.now()) / 86400_000) : null
  return (
    <div className="rounded-md border border-border bg-surface-2 p-2.5 text-xs space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${w?.running ? 'bg-green-500 animate-pulse' : w?.currentTask ? 'bg-yellow-400' : 'bg-muted-foreground'}`} />
        <button type="button" className="font-semibold text-foreground truncate hover:underline" onClick={onOpen}>{name}</button>
        <span className="ml-auto text-muted-foreground">{w?.running ? 'dolgozik' : w?.currentTask ? 'vár' : 'szabad'}</span>
        <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`${name} eltávolítása a figyelőből`} onClick={onRemove}>✕</button>
      </div>
      <div className="text-foreground/90 truncate" title={w?.currentTask?.title}>
        {w?.currentTask ? <>#{w.currentTask.id} {w.currentTask.title} <span className="text-muted-foreground">({STATUS_HU[w.currentTask.status] || w.currentTask.status})</span></> : <span className="text-muted-foreground">Nincs aktuális feladat</span>}
      </div>
      <div>
        <div className="flex justify-between text-muted-foreground"><span>Haladás</span><span>{w ? `${w.done}/${w.total} kész` : '…'}</span></div>
        <div className="mt-0.5 h-1.5 rounded bg-secondary overflow-hidden"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
      </div>
      <div className="text-muted-foreground truncate" title={w?.lastActivity?.text}>Utolsó: {w?.lastActivity ? `${relativeTime(w.lastActivity.at)} – ${w.lastActivity.text}` : '–'}</div>
      {keyDays !== null && keyDays <= 14 && <div className="text-yellow-400">A kulcsa {Math.max(0, keyDays)} nap múlva lejár</div>}
    </div>
  )
}

export function AgentWatchWidget() {
  const navigate = useNavigateToPanel()
  const [runtimes, setRuntimes] = useState<RuntimeWatch[]>([])
  const [extra, setExtra] = useState<string[]>([])
  const [names, setNames] = useState<Array<{ name: string; role: string | null }>>([])
  const [watch, setWatch] = useState<Record<string, AgentWatch>>({})
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setExtra(readExtra())
    apiFetch<{ agents: Array<{ name: string; role: string | null }> }>('/api/agent-os/overview?part=agents')
      .then(r => setNames(r.agents)).catch(() => setNames([]))
  }, [])

  const load = useCallback(async () => {
    try {
      const [rt, ag] = await Promise.all([
        apiFetch<{ runtimes: RuntimeWatch[] }>('/api/agent-os/overview?part=runtimes'),
        extra.length
          ? apiFetch<{ watch: AgentWatch[] }>(`/api/agent-os/overview?part=agents&names=${encodeURIComponent(extra.join(','))}`)
          : Promise.resolve({ watch: [] as AgentWatch[] }),
      ])
      setRuntimes(rt.runtimes)
      setWatch(Object.fromEntries(ag.watch.map(w => [w.name, w])))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nem sikerült betölteni')
    }
  }, [extra])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [load])

  const saveExtra = (next: string[]) => {
    setExtra(next)
    try { localStorage.setItem(EXTRA_KEY, JSON.stringify(next)) } catch {}
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Ágensfigyelő</h3>
        <span className="text-xs text-muted-foreground">Claude, Codex, OpenClaw, Hermes – és a kiválasztott ágensek</span>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        {runtimes.length === 0 && <div className="text-xs text-muted-foreground">Betöltés…</div>}
        {runtimes.map(r => <RuntimeCard key={r.id} r={r} onOpen={() => navigate('agents')} />)}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-foreground">További ágensek</span>
          <span className="text-muted-foreground">(opcionális, legfeljebb {MAX_EXTRA})</span>
          {extra.length < MAX_EXTRA && !adding && <button type="button" className="ml-auto text-primary underline" onClick={() => setAdding(true)}>+ ágens hozzáadása</button>}
          {adding && (
            <span className="ml-auto flex items-center gap-2">
              <select autoFocus aria-label="Ágens kiválasztása" className="rounded border border-border bg-secondary px-1 py-0.5 text-foreground" defaultValue=""
                onChange={e => { if (e.target.value) { saveExtra([...extra, e.target.value]); setAdding(false) } }}>
                <option value="">– válassz ágenst –</option>
                {names.filter(n => !extra.includes(n.name)).map(n => <option key={n.name} value={n.name}>{n.name}</option>)}
              </select>
              <button type="button" className="text-muted-foreground underline" onClick={() => setAdding(false)}>Mégse</button>
            </span>
          )}
        </div>
        {extra.length > 0 && (
          <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
            {extra.map(name => (
              <AgentCard key={name} name={name} w={watch[name]} onOpen={() => navigate('agents')} onRemove={() => saveExtra(extra.filter(n => n !== name))} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
