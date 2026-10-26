'use client'

/**
 * Agent OS – autonomy levels on the Funkciók page (fork addition, 2026-10-26). One row per category with a
 * 1 / 2 / 3 choice; locked categories and levels above maxLevel cannot be picked (the server refuses them too).
 * Data: /api/agent-os/autonomia (people with admin role only; for anyone else the section stays hidden).
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiFetch } from '@/lib/api-client'
import type { AutonomyCategory } from '@/lib/agent-os/autonomia'

const LEVELS: { level: number; label: string; hint: string }[] = [
  { level: 1, label: '1 · jelez', hint: 'Csak jelez, semmit nem tesz' },
  { level: 2, label: '2 · javasol', hint: 'Javasol, és jóváhagyásra vár' },
  { level: 3, label: '3 · önálló', hint: 'Magától végrehajtja, utólag jelent' },
]

export function AutonomiaPanel() {
  const [cats, setCats] = useState<AutonomyCategory[] | null>(null)
  const [source, setSource] = useState<string>('config')
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const cfg = await apiFetch<{ categories: AutonomyCategory[]; source: string }>('/api/agent-os/autonomia')
      setCats(cfg.categories)
      setSource(cfg.source)
      setError(null)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setHidden(true)
      else setError(e instanceof Error ? e.message : 'Nem sikerült betölteni az autonómia-szinteket')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const choose = async (key: string, level: number) => {
    setSaving(key)
    try {
      const cfg = await apiFetch<{ categories: AutonomyCategory[] }>('/api/agent-os/autonomia', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, level }),
      })
      setCats(cfg.categories)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nem sikerült menteni')
    } finally {
      setSaving(null)
    }
  }

  if (hidden) return null
  const open = (cats || []).filter(c => !c.locked)
  const locked = (cats || []).filter(c => c.locked)

  return (
    <section className="space-y-2" aria-labelledby="autonomia-cim">
      <h3 id="autonomia-cim" className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Autonómia</h3>
      <p className="text-xs text-muted-foreground">
        Mennyit tehetnek az ágensek magától, kategóriánként. Ami a szint alatt van, azt az ágens nem kapja meg, csak leírja neked.
      </p>
      {source !== 'config' && (
        <div className="text-sm text-yellow-400">Az autonómia-beállítás nem olvasható, ezért minden kategória 1-es szinten fut.</div>
      )}
      {error && <div className="text-sm text-red-400" role="alert">{error}</div>}
      {!cats ? <div className="text-xs text-muted-foreground">Betöltés…</div> : (
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {open.map(c => (
            <div key={c.key} className="flex flex-wrap items-center gap-2 p-2.5">
              <span className="text-sm text-foreground flex-1 min-w-[12rem]">{c.label}</span>
              <div className="flex gap-1" role="radiogroup" aria-label={c.label}>
                {LEVELS.map(l => {
                  const disabled = l.level > c.maxLevel || saving === c.key
                  const active = c.level === l.level
                  return (
                    <button key={l.level} type="button" role="radio" aria-checked={active} disabled={disabled}
                      title={l.level > c.maxLevel ? `Legfeljebb ${c.maxLevel}. szint` : l.hint}
                      onClick={() => !active && void choose(c.key, l.level)}
                      className={`text-xs rounded px-2 py-1 border transition-colors ${active ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:border-primary/60'} disabled:opacity-40 disabled:cursor-not-allowed`}>
                      {l.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          {locked.length > 0 && (
            <div className="p-2.5 text-xs text-muted-foreground">
              <span aria-hidden>🔒 </span>Zárolva, mindig csak jelez: {locked.map(c => c.label).join(' · ')}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
