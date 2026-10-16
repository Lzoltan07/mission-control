'use client'

/**
 * Agent OS – "Ágensfigyelő" dashboard widget (fork addition). Four slots, each showing one agent you
 * pick: whether its runner is working right now, the current task, task progress (done / all), the
 * last activity and the key expiry. The choice is remembered per browser; data refreshes every 15 s.
 * Data: /api/agent-os/overview?part=agents.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useNavigateToPanel } from '@/lib/navigation'
import type { AgentWatch } from '@/lib/agent-os/functions-catalog'
import { relativeTime } from './funkciok-panel'

const SLOTS_KEY = 'aos-agent-watch'
const DEFAULT_SLOTS = ['heti-tervezo', 'kutato', 'hang-asszisztens', '']
const STATUS_HU: Record<string, string> = { assigned: 'Kiosztva', in_progress: 'Folyamatban', review: 'Ellenőrzés', quality_review: 'Minőségellenőrzés' }

function readSlots(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SLOTS_KEY) || 'null')
    if (Array.isArray(v) && v.length === 4) return v.map(x => (typeof x === 'string' ? x : ''))
  } catch {}
  return DEFAULT_SLOTS
}

export function AgentWatchWidget() {
  const navigate = useNavigateToPanel()
  const [slots, setSlots] = useState<string[]>(DEFAULT_SLOTS)
  const [names, setNames] = useState<Array<{ name: string; role: string | null }>>([])
  const [watch, setWatch] = useState<Record<string, AgentWatch>>({})
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSlots(readSlots())
    apiFetch<{ agents: Array<{ name: string; role: string | null }> }>('/api/agent-os/overview?part=agents')
      .then(r => setNames(r.agents)).catch(() => setNames([]))
  }, [])

  const load = useCallback(async () => {
    const chosen = slots.filter(Boolean)
    if (chosen.length === 0) { setWatch({}); return }
    try {
      const { watch: list } = await apiFetch<{ watch: AgentWatch[] }>(`/api/agent-os/overview?part=agents&names=${encodeURIComponent(chosen.join(','))}`)
      setWatch(Object.fromEntries(list.map(w => [w.name, w])))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nem sikerült betölteni')
    }
  }, [slots])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [load])

  const choose = (i: number, name: string) => {
    const next = slots.map((s, j) => (j === i ? name : s))
    setSlots(next)
    try { localStorage.setItem(SLOTS_KEY, JSON.stringify(next)) } catch {}
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Ágensfigyelő</h3>
        <span className="text-xs text-muted-foreground">4 kiválasztott ágens munkája</span>
        <button type="button" className="ml-auto text-xs text-primary underline" onClick={() => setEditing(e => !e)}>{editing ? 'Kész' : 'Ágensek kiválasztása'}</button>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        {slots.map((name, i) => {
          const w = name ? watch[name] : undefined
          const pct = w && w.total ? Math.round((w.done / w.total) * 100) : 0
          const keySoon = w?.keyExpires && new Date(w.keyExpires).getTime() - Date.now() < 14 * 86400_000
          return (
            <div key={i} className="rounded-md border border-border bg-surface-2 p-2.5 text-xs space-y-1.5 min-h-[7.5rem]">
              {editing || !name ? (
                <label className="block text-muted-foreground">{i + 1}. hely
                  <select className="mt-1 w-full rounded border border-border bg-secondary px-1 py-1 text-foreground" value={name}
                    onChange={e => choose(i, e.target.value)}>
                    <option value="">– üres –</option>
                    {names.map(n => <option key={n.name} value={n.name}>{n.name}</option>)}
                  </select>
                </label>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${w?.running ? 'bg-green-500 animate-pulse' : w?.currentTask ? 'bg-yellow-400' : 'bg-muted-foreground'}`} />
                    <button type="button" className="font-semibold text-foreground truncate hover:underline" onClick={() => navigate('agents')}>{name}</button>
                    <span className="ml-auto text-muted-foreground">{w?.running ? 'dolgozik' : w?.currentTask ? 'vár' : 'szabad'}</span>
                  </div>
                  <div className="text-foreground/90 truncate" title={w?.currentTask?.title}>
                    {w?.currentTask ? <>#{w.currentTask.id} {w.currentTask.title} <span className="text-muted-foreground">({STATUS_HU[w.currentTask.status] || w.currentTask.status})</span></> : <span className="text-muted-foreground">Nincs aktuális feladat</span>}
                  </div>
                  <div>
                    <div className="flex justify-between text-muted-foreground"><span>Haladás</span><span>{w ? `${w.done}/${w.total} kész` : '…'}</span></div>
                    <div className="mt-0.5 h-1.5 rounded bg-secondary overflow-hidden"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
                  </div>
                  <div className="text-muted-foreground truncate" title={w?.lastActivity?.text}>
                    Utolsó: {w?.lastActivity ? `${relativeTime(w.lastActivity.at)} – ${w.lastActivity.text}` : '–'}
                  </div>
                  {keySoon && <div className="text-yellow-400">A kulcsa {Math.max(0, Math.ceil((new Date(w!.keyExpires!).getTime() - Date.now()) / 86400_000))} nap múlva lejár</div>}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
