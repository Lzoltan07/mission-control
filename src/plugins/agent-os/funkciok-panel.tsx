'use client'

/**
 * Agent OS – "Funkciók" dashboard (fork addition). Every Mission Control function as a card; hovering
 * (or focusing) a card shows its current state: progress, last change and the key numbers. Clicking
 * opens the function. Data: /api/agent-os/overview?part=functions (refreshed every 30 s).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMissionControl } from '@/store'
import { useNavigateToPanel } from '@/lib/navigation'
import { apiFetch } from '@/lib/api-client'
import { FUNCTIONS, type FunctionStatus } from '@/lib/agent-os/functions-catalog'

const STATE_STYLE: Record<FunctionStatus['state'], { dot: string; label: string }> = {
  ok: { dot: 'bg-green-500', label: 'Működik' },
  warn: { dot: 'bg-yellow-400', label: 'Figyelmet kér' },
  idle: { dot: 'bg-muted-foreground', label: 'Nincs teendő' },
  off: { dot: 'bg-red-500/60', label: 'Nem elérhető' },
}

export function relativeTime(isoTime?: string): string {
  if (!isoTime) return '–'
  const s = Math.round((Date.now() - new Date(isoTime).getTime()) / 1000)
  if (s < 60) return 'most'
  if (s < 3600) return `${Math.floor(s / 60)} perce`
  if (s < 86400) return `${Math.floor(s / 3600)} órája`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} napja`
  return new Date(isoTime).toLocaleDateString('hu-HU')
}

export function FunkciokPanel() {
  const { dashboardMode } = useMissionControl()
  const navigate = useNavigateToPanel()
  const [statuses, setStatuses] = useState<Record<string, FunctionStatus>>({})
  const [error, setError] = useState<string | null>(null)
  const [updated, setUpdated] = useState<Date | null>(null)
  const [hover, setHover] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { functions } = await apiFetch<{ functions: FunctionStatus[] }>(`/api/agent-os/overview?part=functions&mode=${dashboardMode === 'local' ? 'local' : 'full'}`)
      setStatuses(Object.fromEntries(functions.map(f => [f.id, f])))
      setUpdated(new Date())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nem sikerült betölteni az állapotot')
    }
  }, [dashboardMode])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  const groups = useMemo(() => {
    const map = new Map<string, typeof FUNCTIONS>()
    for (const f of FUNCTIONS) map.set(f.group, [...(map.get(f.group) || []), f])
    return [...map.entries()]
  }, [])

  return (
    <div className="p-4 space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-xl font-bold text-foreground">Funkciók</h2>
        <span className="text-sm text-muted-foreground">Vidd fölé az egeret az állapotért, kattints a megnyitáshoz.</span>
        <span className="ml-auto text-xs text-muted-foreground">{updated ? `Frissítve: ${updated.toLocaleTimeString('hu-HU')}` : 'Betöltés…'}</span>
        <button type="button" className="text-xs text-primary underline" onClick={() => void load()}>Frissítés</button>
      </div>
      {error && <div className="text-sm text-red-400">{error}</div>}

      {groups.map(([group, items]) => (
        <section key={group} className="space-y-2">
          <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{group}</h3>
          <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map(f => {
              const s = statuses[f.id]
              const st = STATE_STYLE[s?.state || 'idle']
              const showDetails = hover === f.id
              return (
                <div key={f.id} className="relative"
                  onMouseEnter={() => setHover(f.id)} onMouseLeave={() => setHover(h => (h === f.id ? null : h))}>
                  <button type="button" disabled={f.noLink}
                    onClick={() => !f.noLink && navigate(f.id)} onFocus={() => setHover(f.id)} onBlur={() => setHover(h => (h === f.id ? null : h))}
                    aria-describedby={showDetails ? `fn-${f.id}` : undefined}
                    className="w-full text-left rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/60 focus-visible:border-primary disabled:cursor-default">
                    <div className="flex items-center gap-2">
                      <span className="text-lg" aria-hidden>{f.icon}</span>
                      <span className="font-medium text-foreground">{f.label}</span>
                      <span className={`ml-auto h-2.5 w-2.5 rounded-full ${st.dot}`} title={st.label} />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground truncate">{s?.summary || '…'}</div>
                    {s?.progress !== undefined && (
                      <div className="mt-2 h-1.5 rounded bg-secondary overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.progress * 100)}>
                        <div className="h-full bg-primary" style={{ width: `${Math.round(s.progress * 100)}%` }} />
                      </div>
                    )}
                  </button>
                  {showDetails && (
                    <div id={`fn-${f.id}`} role="tooltip"
                      className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-border bg-popover p-3 shadow-xl text-xs space-y-1.5">
                      <div className="text-foreground/90">{f.description}</div>
                      <div className="flex justify-between gap-2"><span className="text-muted-foreground">Állapot</span><span className="text-foreground">{st.label}</span></div>
                      {s?.progress !== undefined && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Haladás</span><span className="text-foreground">{Math.round(s.progress * 100)}%</span></div>}
                      <div className="flex justify-between gap-2"><span className="text-muted-foreground">Utolsó változás</span>
                        <span className="text-foreground" title={s?.lastChange ? new Date(s.lastChange).toLocaleString('hu-HU') : undefined}>{relativeTime(s?.lastChange)}</span></div>
                      {s?.details.map((d, i) => (
                        <div key={i} className="flex justify-between gap-2"><span className="text-muted-foreground shrink-0">{d.label}</span><span className="text-foreground text-right break-words">{d.value}</span></div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
