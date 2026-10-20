'use client'

/**
 * Agent OS – "Végrehajtás" section on top of the Activity page (fork addition): which device sent an
 * instruction, which agent on which machine works on it, and how far it got (live elapsed time for
 * long runs; "elakadt?" when a running entry has not reported for 10 minutes). Since 2026-10-20 also
 * what the runs consumed ("Fogyasztás"): Claude Code's own report per run – turns, tokens and the
 * API-equivalent price. On the subscription this is no bill; it shows how much of the allowance goes where.
 * Data: /api/agent-os/executions (src/lib/agent-os/executions.ts).
 */
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useNavigateToPanel } from '@/lib/navigation'
import { deviceId, deviceName, setDeviceName } from './device'

interface RunUsage {
  model: string | null; turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number
  cacheWriteTokens: number; costUsd: number; durationMs: number; endReason: 'ok' | 'max_turns' | 'limit' | 'auth' | 'error'
}

interface Execution {
  id: number; kind: 'hang' | 'feladat'; title: string; taskId: number | null
  sourceUser: string | null; sourceDevice: string | null; sourceEstimated: boolean
  agent: string | null; workerDevice: string; status: 'running' | 'done' | 'failed'; progress: string | null
  startedAt: string; updatedAt: string; finishedAt: string | null; usage: RunUsage | null
}

interface UsageWindow { runs: number; costUsd: number; tokens: number; maxTurns: number; limits: number }
interface UsageSummary {
  today: UsageWindow; week: UsageWindow; month: UsageWindow
  byAgent: Array<{ agent: string; runs: number; costUsd: number; tokens: number }>
  top: Array<{ id: number; title: string; taskId: number | null; agent: string | null; costUsd: number; turns: number; endReason: string }>
  interactive: { sessions: number; costUsd: number; tokens: number }
  alertUsd: number
}

const STALE_MS = 10 * 60_000

const usd = (v: number) => `~${v.toLocaleString('hu-HU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
const tokens = (v: number) => (v >= 1e6 ? `${(v / 1e6).toLocaleString('hu-HU', { maximumFractionDigits: 1 })} M` : v >= 1e3 ? `${Math.round(v / 1e3)} e` : String(v))
const END_LABEL: Record<string, string> = { max_turns: 'lépéskorlát', limit: 'Claude-limit', auth: 'bejelentkezés lejárt', error: 'hiba' }

/** Consumption summary above the run table. */
function Fogyasztas({ u }: { u: UsageSummary }) {
  const tile = (label: string, w: UsageWindow) => (
    <div className="rounded border border-border/60 bg-secondary/30 px-2 py-1.5">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground">{usd(w.costUsd)}</div>
      <div className="text-muted-foreground">{w.runs} futás · {tokens(w.tokens)} token</div>
      {(w.maxTurns > 0 || w.limits > 0) && (
        <div className="text-yellow-400">{[w.maxTurns ? `${w.maxTurns}× lépéskorlát` : '', w.limits ? `${w.limits}× Claude-limit` : ''].filter(Boolean).join(' · ')}</div>
      )}
    </div>
  )
  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-foreground">Fogyasztás</h3>
        <span className="text-muted-foreground">
          ágensfutások és Jarvis-kérdések, API-egyenértékű áron. Az előfizetésből megy, nem számla; azt mutatja, mi mennyit visz el a keretből.
          Riasztás {usd(u.alertUsd)} fölötti futásnál.
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tile('Ma', u.today)}
        {tile('Elmúlt 7 nap', u.week)}
        {tile('Elmúlt 30 nap', u.month)}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <div className="text-muted-foreground">Ágensenként (30 nap)</div>
          {u.byAgent.length === 0 ? <div className="text-muted-foreground">Még nincs adat.</div> : u.byAgent.map(a => (
            <div key={a.agent} className="flex justify-between gap-2"><span className="text-foreground">{a.agent}</span>
              <span className="text-muted-foreground">{a.runs} futás · {tokens(a.tokens)} · <span className="text-foreground">{usd(a.costUsd)}</span></span></div>
          ))}
          <div className="mt-1 flex justify-between gap-2 border-t border-border/50 pt-1" title="A gépen futó Claude Code-munkamenetek (ezek a beszélgetések is), amelyek az elmúlt 30 napban aktívak voltak; teljes élettartamuk fogyasztása.">
            <span className="text-foreground">Interaktív Claude Code-munka</span>
            <span className="text-muted-foreground">{u.interactive.sessions} munkamenet · {tokens(u.interactive.tokens)} · <span className="text-foreground">{usd(u.interactive.costUsd)}</span></span>
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Legtöbbet fogyasztó futások (30 nap)</div>
          {u.top.length === 0 ? <div className="text-muted-foreground">Még nincs adat.</div> : u.top.map(t => (
            <div key={t.id} className="flex justify-between gap-2">
              <span className="truncate text-foreground" title={t.title}>{t.taskId ? `#${t.taskId} ` : ''}{t.title}</span>
              <span className="whitespace-nowrap text-muted-foreground">{t.agent} · {t.turns} lépés{END_LABEL[t.endReason] ? ` · ${END_LABEL[t.endReason]}` : ''} · <span className="text-foreground">{usd(t.costUsd)}</span></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} mp`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} perc ${s % 60} mp`
  return `${Math.floor(m / 60)} óra ${m % 60} perc`
}

export function ExecutionLog() {
  const navigate = useNavigateToPanel()
  const [rows, setRows] = useState<Execution[]>([])
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [machine, setMachine] = useState('')
  const [onlyRunning, setOnlyRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState(false)
  const [, tick] = useState(0)

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ executions: Execution[]; usage: UsageSummary; machine: string }>('/api/agent-os/executions')
      setRows(r.executions)
      setUsage(r.usage ?? null)
      setMachine(r.machine)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nem sikerült betölteni')
    }
  }, [])

  const anyRunning = rows.some(r => r.status === 'running')
  useEffect(() => { setName(deviceName()) }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), anyRunning ? 5_000 : 20_000)
    return () => clearInterval(t)
  }, [load, anyRunning])
  // Live elapsed time while something runs.
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => tick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [anyRunning])

  const saveName = async () => {
    try { await setDeviceName(name.trim()); setEditing(false); void load() } catch (e) { setError(e instanceof Error ? e.message : 'Mentés sikertelen') }
  }

  const shown = onlyRunning ? rows.filter(r => r.status === 'running') : rows

  return (
    <section className="m-4 mb-0 rounded-lg border border-border bg-card p-3 space-y-2" aria-label="Végrehajtás">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-foreground">Végrehajtás</h2>
        <span className="text-xs text-muted-foreground">honnan jött az utasítás, ki és hol dolgozik rajta, hol tart</span>
        <label className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
          <input type="checkbox" checked={onlyRunning} onChange={e => setOnlyRunning(e.target.checked)} /> Csak a futók
        </label>
      </div>
      <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-2">
        <span>Ez az eszköz:</span>
        {editing ? (
          <form className="flex gap-1" onSubmit={e => { e.preventDefault(); void saveName() }}>
            <input className="rounded border border-border bg-secondary px-2 py-0.5 text-foreground" value={name} maxLength={40}
              placeholder="pl. Laptop, iPhone" onChange={e => setName(e.target.value)} autoFocus />
            <button type="submit" className="text-primary underline">Mentés</button>
          </form>
        ) : (
          <>
            <span className="text-foreground">{name || 'névtelen'}</span>
            <button type="button" className="text-primary underline" onClick={() => setEditing(true)}>átnevezés</button>
          </>
        )}
        <span className="opacity-60">({deviceId().slice(0, 8)}…)</span>
        {machine && <span className="ml-auto">A Mission Control gépe: <span className="text-foreground">{machine}</span></span>}
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      {usage && <Fogyasztas u={usage} />}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-left">
            <tr className="border-b border-border">
              <th className="py-1 pr-2 font-medium">Kezdés</th>
              <th className="py-1 pr-2 font-medium">Utasítás</th>
              <th className="py-1 pr-2 font-medium">Honnan</th>
              <th className="py-1 pr-2 font-medium">Ki dolgozik rajta, hol</th>
              <th className="py-1 pr-2 font-medium">Állapot</th>
              <th className="py-1 font-medium text-right">Időtartam</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={6} className="py-3 text-muted-foreground">{onlyRunning ? 'Most semmi nem fut.' : 'Még nincs végrehajtás. A hangos kérdések és az ágensek feladatfuttatásai itt jelennek meg.'}</td></tr>
            )}
            {shown.map(r => {
              const end = r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now()
              const stale = r.status === 'running' && Date.now() - new Date(r.updatedAt).getTime() > STALE_MS
              const badge = r.status === 'done' ? ['Kész', 'bg-green-500/15 text-green-400']
                : r.status === 'failed' ? ['Hibás', 'bg-red-500/15 text-red-400']
                : stale ? ['Elakadt?', 'bg-yellow-400/15 text-yellow-400'] : ['Fut', 'bg-blue-400/15 text-blue-400 animate-pulse']
              return (
                <tr key={r.id} className="border-b border-border/50 align-top">
                  <td className="py-1.5 pr-2 whitespace-nowrap text-muted-foreground" title={new Date(r.startedAt).toLocaleString('hu-HU')}>
                    {new Date(r.startedAt).toLocaleString('hu-HU', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="py-1.5 pr-2 max-w-[22rem]">
                    <span className="mr-1" aria-hidden>{r.kind === 'hang' ? '🎙️' : '📋'}</span>
                    {r.taskId
                      ? <button type="button" className="text-foreground hover:underline text-left" onClick={() => navigate('tasks')}>#{r.taskId} {r.title}</button>
                      : <span className="text-foreground">{r.title}</span>}
                  </td>
                  <td className="py-1.5 pr-2">
                    <div className="text-foreground">{r.sourceDevice || (r.sourceUser ? 'ismeretlen eszköz' : '–')}</div>
                    <div className="text-muted-foreground">{r.sourceUser || ''}{r.sourceEstimated ? ' · becsült (a kiosztáskor aktív eszköz)' : ''}</div>
                  </td>
                  <td className="py-1.5 pr-2">
                    <div className="text-foreground">{r.agent || '–'}</div>
                    <div className="text-muted-foreground">{r.workerDevice}</div>
                  </td>
                  <td className="py-1.5 pr-2 max-w-[20rem]">
                    <span className={`inline-block rounded px-1.5 py-0.5 ${badge[1]}`}>{badge[0]}</span>
                    {r.progress && <div className="mt-0.5 text-muted-foreground line-clamp-2" title={r.progress}>{r.progress}</div>}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap text-foreground">
                    {duration(end - new Date(r.startedAt).getTime())}
                    {r.usage && (
                      <div className={`text-muted-foreground ${usage && r.usage.costUsd > usage.alertUsd ? 'text-yellow-400' : ''}`}
                        title={`${r.usage.model || ''} · be ${tokens(r.usage.inputTokens)}, ki ${tokens(r.usage.outputTokens)}, gyorsítótár ${tokens(r.usage.cacheReadTokens + r.usage.cacheWriteTokens)} token`}>
                        {r.usage.turns} lépés · {usd(r.usage.costUsd)}{END_LABEL[r.usage.endReason] ? ` · ${END_LABEL[r.usage.endReason]}` : ''}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
