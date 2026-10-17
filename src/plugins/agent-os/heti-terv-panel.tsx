'use client'

/**
 * Agent OS – "Heti terv" tab (fork addition). Weekly view of the plan calendar with add/edit/delete.
 * Data: /api/agent-os/calendar (see src/lib/agent-os/calendar.ts). Edit/delete need the admin role.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch, ApiError } from '@/lib/api-client'

interface PlanBlock { id: string; title: string; description: string; start: string; end: string; source: 'agent' | 'user' | 'sync'; createdBy: string; link?: string; allDay?: boolean }
interface BusySlot { start: string; end: string }
interface WeekView { provider: 'local' | 'google'; connected: boolean; calendarName: string; timezone: string; busy: BusySlot[]; blocks: PlanBlock[] }

const DAY_NAMES = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat', 'Vasárnap']
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7))
  return m
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${t.getUTCFullYear()}-H${pad(week)}`
}

interface FormState { id?: string; day: string; start: string; end: string; title: string; description: string }

export function HetiTervPanel() {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()))
  const [data, setData] = useState<WeekView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(d.getDate() + i); return d
  }), [weekStart])
  const weekEnd = useMemo(() => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); return d }, [weekStart])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const q = new URLSearchParams({ from: weekStart.toISOString(), to: weekEnd.toISOString() })
      setData(await apiFetch<WeekView>(`/api/agent-os/calendar?${q}`))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nem sikerült betölteni a heti tervet')
    } finally {
      setLoading(false)
    }
  }, [weekStart, weekEnd])

  useEffect(() => { load() }, [load])

  const shiftWeek = (n: number) => setWeekStart(prev => { const d = new Date(prev); d.setDate(d.getDate() + 7 * n); return d })

  function openNew(day: Date) {
    setForm({ day: dateKey(day), start: '09:00', end: '10:00', title: '', description: '' })
  }
  function openEdit(b: PlanBlock) {
    const s = new Date(b.start)
    setForm({ id: b.id, day: dateKey(s), start: hhmm(b.start), end: hhmm(b.end), title: b.title, description: b.description })
  }

  async function save() {
    if (!form) return
    setSaving(true); setError(null)
    try {
      const start = new Date(`${form.day}T${form.start}:00`).toISOString()
      const end = new Date(`${form.day}T${form.end}:00`).toISOString()
      const body = JSON.stringify({ title: form.title, description: form.description, start, end })
      if (form.id) await apiFetch(`/api/agent-os/calendar/${encodeURIComponent(form.id)}`, { method: 'PUT', body })
      else await apiFetch('/api/agent-os/calendar', { method: 'POST', body })
      setForm(null)
      await load()
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? 'Ehhez admin jogosultság kell.' : e instanceof Error ? e.message : 'Mentés sikertelen')
    } finally {
      setSaving(false)
    }
  }

  async function remove(b: PlanBlock) {
    if (!window.confirm(`Törlöd ezt a blokkot?\n\n${b.title} (${hhmm(b.start)}–${hhmm(b.end)})`)) return
    setError(null)
    try {
      await apiFetch(`/api/agent-os/calendar/${encodeURIComponent(b.id)}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? 'Ehhez admin jogosultság kell.' : e instanceof Error ? e.message : 'Törlés sikertelen')
    }
  }

  // University timetable (Neptun classes + exams) into the plan: see src/lib/agent-os/uni-sync.ts.
  const [syncing, setSyncing] = useState(false)
  const [syncInfo, setSyncInfo] = useState<string | null>(null)
  const syncUni = async () => {
    setSyncing(true); setSyncInfo(null)
    try {
      const r = await apiFetch<{ classes: number; exams: number; moodle: number | null; moodleError?: string; created: number; updated: number; removed: number }>('/api/agent-os/calendar/sync', { method: 'POST' })
      const moodle = r.moodle === null ? '' : `, ${r.moodle} Moodle-határidő`
      const moodleErr = r.moodleError ? ` · Moodle nem olvasható (${r.moodleError}), a meglévő határidők maradnak` : ''
      setSyncInfo(`${r.classes} óra, ${r.exams} vizsga${moodle} a következő 4 hétben · új: ${r.created}, frissítve: ${r.updated}, levéve: ${r.removed}${moodleErr}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A szinkron nem sikerült')
    } finally {
      setSyncing(false)
    }
  }

  const byDay = (d: Date) => {
    const from = d.getTime(), to = from + 86400000
    const inDay = (s: string, e: string) => Date.parse(s) < to && Date.parse(e) > from
    return {
      blocks: (data?.blocks || []).filter(b => inDay(b.start, b.end)),
      busy: (data?.busy || []).filter(b => inDay(b.start, b.end)),
    }
  }

  const range = `${days[0].toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })}`

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-bold text-foreground mr-2">Heti terv</h2>
        <span className="text-sm text-muted-foreground">{isoWeek(weekStart)} · {range}</span>
        <div className="flex gap-1 ml-auto">
          <Button variant="outline" size="sm" onClick={() => shiftWeek(-1)} aria-label="Előző hét">‹</Button>
          <Button variant="outline" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>Ez a hét</Button>
          <Button variant="outline" size="sm" onClick={() => shiftWeek(1)} aria-label="Következő hét">›</Button>
        </div>
      </div>

      {data && (
        <div className="text-xs text-muted-foreground flex flex-wrap gap-3 items-center">
          <span>Naptár: {data.calendarName} ({data.provider === 'google' ? 'Google' : 'helyi'})</span>
          {data.provider === 'google' && !data.connected && (
            <a className="text-primary underline" href="/api/agent-os/calendar/oauth?action=start">Google Naptár összekapcsolása</a>
          )}
          <span>Szürke: foglalt idő a többi naptáradból (részletek nélkül).</span>
          {data.provider === 'google' && data.connected && (
            <Button variant="ghost" size="xs" onClick={() => void syncUni()} disabled={syncing}>{syncing ? 'Órák frissítése…' : '🎓 Órák és határidők frissítése'}</Button>
          )}
          {syncInfo && <span className="text-sky-300">{syncInfo}</span>}
        </div>
      )}

      {error && <div className="text-sm text-red-400">{error}</div>}
      {loading && !data && <div className="text-sm text-muted-foreground">Betöltés…</div>}

      <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-7">
        {days.map((d, i) => {
          const { blocks, busy } = byDay(d)
          const today = dateKey(d) === dateKey(new Date())
          return (
            <div key={dateKey(d)} className={`bg-card rounded-lg p-2 border ${today ? 'border-primary' : 'border-border'} min-h-[8rem] flex flex-col`}>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-sm font-semibold text-foreground">{DAY_NAMES[i]}</span>
                <span className="text-xs text-muted-foreground">{d.toLocaleDateString('hu-HU', { month: 'numeric', day: 'numeric' })}</span>
              </div>
              <div className="space-y-1 flex-1">
                {busy.map((s, k) => (
                  <div key={`busy-${k}`} className="text-xs rounded px-2 py-1 bg-secondary text-muted-foreground">
                    Foglalt {Date.parse(s.end) - Date.parse(s.start) >= 86_400_000 ? 'egész nap' : `${hhmm(s.start)}–${hhmm(s.end)}`}
                  </div>
                ))}
                {blocks.map(b => (
                  <div key={b.id} className="text-xs rounded px-2 py-1 border border-border bg-surface-2 group">
                    <div className="flex items-center gap-1">
                      <span className="font-medium text-foreground">{b.allDay ? 'egész nap' : `${hhmm(b.start)}–${hhmm(b.end)}`}</span>
                      <span className={`ml-auto rounded px-1 ${b.source === 'agent' ? 'text-primary' : b.source === 'sync' ? 'text-sky-300' : 'text-green-400'}`}>{b.source === 'agent' ? 'ágens' : b.source === 'sync' ? 'egyetem' : 'saját'}</span>
                    </div>
                    <div className="text-foreground/90 break-words">{b.title}</div>
                    {b.description && <div className="text-muted-foreground line-clamp-2 break-words">{b.description}</div>}
                    <div className="flex gap-1 mt-1">
                      <Button variant="ghost" size="xs" onClick={() => openEdit(b)}>Szerkesztés</Button>
                      <Button variant="ghost" size="xs" onClick={() => remove(b)}>Törlés</Button>
                    </div>
                  </div>
                ))}
              </div>
              <Button variant="ghost" size="xs" className="mt-2" onClick={() => openNew(d)}>+ Új blokk</Button>
            </div>
          )
        })}
      </div>

      {form && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true">
          <div className="bg-card rounded-lg p-4 border border-border w-full max-w-md space-y-3">
            <h3 className="text-lg font-semibold text-foreground">{form.id ? 'Blokk szerkesztése' : 'Új blokk'}</h3>
            <label className="block text-sm text-muted-foreground">Nap
              <input type="date" className="mt-1 w-full rounded border border-border bg-secondary px-2 py-1 text-foreground"
                value={form.day} onChange={e => setForm({ ...form, day: e.target.value })} />
            </label>
            <div className="flex gap-2">
              <label className="block text-sm text-muted-foreground flex-1">Kezdés
                <input type="time" className="mt-1 w-full rounded border border-border bg-secondary px-2 py-1 text-foreground"
                  value={form.start} onChange={e => setForm({ ...form, start: e.target.value })} />
              </label>
              <label className="block text-sm text-muted-foreground flex-1">Vége
                <input type="time" className="mt-1 w-full rounded border border-border bg-secondary px-2 py-1 text-foreground"
                  value={form.end} onChange={e => setForm({ ...form, end: e.target.value })} />
              </label>
            </div>
            <label className="block text-sm text-muted-foreground">Cím
              <input className="mt-1 w-full rounded border border-border bg-secondary px-2 py-1 text-foreground" maxLength={200}
                value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
            </label>
            <label className="block text-sm text-muted-foreground">Leírás
              <textarea className="mt-1 w-full rounded border border-border bg-secondary px-2 py-1 text-foreground" rows={3} maxLength={4000}
                value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setForm(null)} disabled={saving}>Mégse</Button>
              <Button size="sm" onClick={save} disabled={saving || !form.title.trim()}>{saving ? 'Mentés…' : 'Mentés'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
