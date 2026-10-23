'use client'

/**
 * Agent OS – "Feladatok és teendők" (fork addition): a floating button on every page (like the voice button,
 * not a tab) with a badge of what needs the owner now; click opens a pop-up with
 *   - Rám vár: cards to review, unassigned inbox cards (assigning = approval), e-mails waiting for approval
 *   - Teendők: open Google Tasks – tick one off, or add a new one (to Google Tasks or to the board inbox)
 *   - Határidők: exams and Moodle deadlines in the next 7 days, today's plan blocks
 * Every row jumps to its page. The button can be dragged (position kept in this browser).
 * Data: /api/agent-os/teendok (src/lib/agent-os/teendok.ts); new board cards via /api/tasks.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useNavigateToPanel } from '@/lib/navigation'

interface Summary {
  ramVar: {
    review: Array<{ id: number; title: string; status: string; assignedTo: string | null }>
    inbox: Array<{ id: number; title: string }>
    inboxCount: number
    emails: Array<{ id: string; to: string; subject: string; requestedBy: string }>
  }
  teendok: Array<{ id: string; listId: string; list: string; title: string; due: string | null; notes: string | null }> | null
  teendokError?: string
  hataridok: Array<{ title: string; start: string; end: string; allDay: boolean; today: boolean }>
  hataridokError?: string
  count: number
}

const POS_KEY = 'aos-teendok-pos'
const readPref = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const writePref = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric', weekday: 'short' })
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
const dueLabel = (due: string) => {
  const days = Math.round((Date.parse(due.slice(0, 10)) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400_000)
  return days < 0 ? `${-days} napja lejárt` : days === 0 ? 'ma' : days === 1 ? 'holnap' : dayLabel(due)
}

export function TeendokGomb() {
  const navigate = useNavigateToPanel()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [due, setDue] = useState('')
  const [target, setTarget] = useState<'google' | 'tabla'>('google')

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<Summary>('/api/agent-os/teendok'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nem sikerült betölteni')
    }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), open ? 60_000 : 180_000)
    return () => clearInterval(t)
  }, [load, open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // --- Dragging (a drag of more than 5 px moves the button; a click opens the pop-up) ---------------------
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ dx: number; dy: number; x0: number; y0: number; moved: boolean } | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const clamp = useCallback((x: number, y: number) => {
    const w = box.current?.offsetWidth || 56, h = box.current?.offsetHeight || 56
    return { x: Math.min(Math.max(8, x), window.innerWidth - w - 8), y: Math.min(Math.max(8, y), window.innerHeight - h - 8) }
  }, [])
  useEffect(() => {
    try {
      const saved = JSON.parse(readPref(POS_KEY) || 'null')
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) setPos(clamp(saved.x, saved.y))
    } catch {}
    const onResize = () => setPos(p => (p ? clamp(p.x, p.y) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])
  const onDown = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return
    d.moved = true
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy))
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) setPos(p => { if (p) writePref(POS_KEY, JSON.stringify(p)); return p })
    else setOpen(o => !o)
  }

  // --- Actions --------------------------------------------------------------------------------------------
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null)
    try { await fn(); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Hiba') } finally { setBusy(null) }
  }
  const done = (t: { id: string; listId: string }) => run(`done:${t.id}`, async () => {
    setData(d => (d && d.teendok ? { ...d, teendok: d.teendok.filter(x => x.id !== t.id) } : d)) // optimistic
    await apiFetch('/api/agent-os/teendok', { method: 'POST', body: JSON.stringify({ action: 'task_done', listId: t.listId, id: t.id }) })
  })
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const text = title.trim()
    if (!text) return
    void run('add', async () => {
      if (target === 'google') {
        await apiFetch('/api/agent-os/teendok', { method: 'POST', body: JSON.stringify({ action: 'task_create', title: text, notes: notes.trim() || undefined, due: due || undefined }) })
      } else {
        await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify({ title: text, description: notes.trim() || undefined, status: 'inbox', priority: 'medium' }) })
      }
      setTitle(''); setNotes(''); setDue('')
    })
  }
  const go = (panel: string) => { setOpen(false); navigate(panel) }

  const count = data?.count || 0
  // Open towards the side with more room, and never taller than that room (small windows, phones).
  const rect = open ? box.current?.getBoundingClientRect() : undefined
  const placeAbove = rect ? rect.top > window.innerHeight - rect.bottom : true
  const placeLeft = rect ? rect.left > window.innerWidth / 2 : true
  // 72 px above: room for the top bar, which would otherwise cover the pop-up's header.
  const room = rect ? (placeAbove ? rect.top - 72 : window.innerHeight - rect.bottom - 24) : 400
  const maxHeight = Math.max(200, Math.min(room, window.innerHeight * 0.7))

  const section = (label: string, n: number, children: React.ReactNode) => (
    <section className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}{n ? ` · ${n}` : ''}</h3>
      {children}
    </section>
  )
  const row = 'flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-secondary/60'

  return (
    <div ref={box} className={`fixed z-[60] ${pos ? '' : 'right-4 bottom-36 md:bottom-20'}`} style={pos ? { left: pos.x, top: pos.y } : undefined}>
      <button
        type="button" aria-label={`Feladatok és teendők${count ? ` (${count} vár rád)` : ''}`} aria-expanded={open}
        title="Feladatok és teendők (húzással áthelyezhető)"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o) } }}
        className="relative flex h-12 w-12 touch-none select-none items-center justify-center rounded-full border border-border bg-card text-xl shadow-lg hover:bg-secondary">
        <span aria-hidden>📋</span>
        {count > 0 && (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-sky-500 px-1.5 text-center text-xs font-semibold leading-5 text-white">{count}</span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Feladatok és teendők" style={{ maxHeight }}
          className={`absolute w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-card p-3 shadow-2xl space-y-3 ${placeAbove ? 'bottom-14' : 'top-14'} ${placeLeft ? 'right-0' : 'left-0'}`}>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">Feladatok és teendők</h2>
            <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={() => void load()}>frissítés</button>
            <button type="button" aria-label="Bezárás" className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>✕</button>
          </div>
          {error && <div className="text-xs text-red-400">{error}</div>}
          {!data && !error && <div className="text-sm text-muted-foreground">Betöltés…</div>}

          {data && section('Rám vár', data.ramVar.review.length + data.ramVar.emails.length + data.ramVar.inboxCount, (
            <div>
              {data.ramVar.review.map(t => (
                <button key={`r${t.id}`} type="button" className={row} onClick={() => go('tasks')}>
                  <span aria-hidden>✅</span>
                  <span className="flex-1"><span className="text-foreground">#{t.id} {t.title}</span>
                    <span className="block text-xs text-muted-foreground">ellenőrzésre vár{t.assignedTo ? ` · ${t.assignedTo}` : ''}</span></span>
                </button>
              ))}
              {data.ramVar.emails.map(m => (
                <button key={`m${m.id}`} type="button" className={row} onClick={() => go('google')}>
                  <span aria-hidden>✉️</span>
                  <span className="flex-1"><span className="text-foreground">{m.subject || '(nincs tárgy)'}</span>
                    <span className="block text-xs text-muted-foreground">küldésre vár → {m.to} · {m.requestedBy.replace(/^agent:/, '')}</span></span>
                </button>
              ))}
              {data.ramVar.inboxCount > 0 && (
                <button type="button" className={row} onClick={() => go('tasks')}>
                  <span aria-hidden>📥</span>
                  <span className="flex-1"><span className="text-foreground">{data.ramVar.inboxCount} kártya kiosztásra vár</span>
                    <span className="block text-xs text-muted-foreground truncate">{data.ramVar.inbox.slice(0, 3).map(t => `#${t.id} ${t.title}`).join(' · ')}</span></span>
                </button>
              )}
              {!data.ramVar.review.length && !data.ramVar.emails.length && !data.ramVar.inboxCount && <div className="text-sm text-muted-foreground px-1.5">Semmi nem vár rád.</div>}
            </div>
          ))}

          {data && section('Teendők', data.teendok?.length || 0, (
            <div>
              {data.teendokError && <div className="px-1.5 text-xs text-muted-foreground">{data.teendokError}</div>}
              {(data.teendok || []).slice(0, 15).map(t => {
                const overdue = t.due && Date.parse(t.due.slice(0, 10)) < Date.parse(new Date().toISOString().slice(0, 10))
                return (
                  <div key={t.id} className="flex items-start gap-2 px-1.5 py-1 text-sm">
                    <input type="checkbox" aria-label={`Kész: ${t.title}`} className="mt-1" disabled={busy === `done:${t.id}`} onChange={() => void done(t)} />
                    <span className="flex-1"><span className="text-foreground">{t.title}</span>
                      {t.notes && <span className="block text-xs text-muted-foreground line-clamp-2" title={t.notes}>{t.notes}</span>}
                      {t.due && <span className={`block text-xs ${overdue ? 'text-red-400' : 'text-muted-foreground'}`}>{dueLabel(t.due)}</span>}</span>
                  </div>
                )
              })}
              {data.teendok && data.teendok.length === 0 && <div className="px-1.5 text-sm text-muted-foreground">Nincs nyitott teendő.</div>}
              <form onSubmit={add} className="mt-2 space-y-1 border-t border-border/60 px-1.5 pt-2">
                <div className="text-xs font-medium text-muted-foreground">Új teendő</div>
                <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="Cím" aria-label="Cím"
                  className="w-full rounded border border-border bg-secondary px-2 py-1 text-sm text-foreground" />
                <textarea value={notes} onChange={e => setNotes(e.target.value)} maxLength={5000} rows={3} placeholder="Tartalom (nem kötelező)" aria-label="Tartalom"
                  className="w-full resize-y rounded border border-border bg-secondary px-2 py-1 text-sm text-foreground" />
                <div className="flex flex-wrap items-center gap-1">
                  {target === 'google' && (
                    <input type="date" value={due} onChange={e => setDue(e.target.value)} aria-label="Határidő"
                      className="rounded border border-border bg-secondary px-1 py-1 text-xs text-foreground" />
                  )}
                  <select value={target} onChange={e => setTarget(e.target.value as 'google' | 'tabla')} aria-label="Hová kerüljön"
                    className="rounded border border-border bg-secondary px-1 py-1 text-xs text-foreground">
                    <option value="google">Google Tasks</option>
                    <option value="tabla">Tábla (Bejövő)</option>
                  </select>
                  <button type="submit" disabled={!title.trim() || busy === 'add'} className="ml-auto rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50">
                    {busy === 'add' ? '…' : 'Felvesz'}
                  </button>
                </div>
              </form>
            </div>
          ))}

          {data && section('Határidők (7 nap)', data.hataridok.length, (
            <div>
              {data.hataridokError && <div className="px-1.5 text-xs text-muted-foreground">{data.hataridokError}</div>}
              {data.hataridok.map((h, i) => (
                <button key={i} type="button" className={row} onClick={() => go('heti-terv')}>
                  <span aria-hidden>{h.allDay ? '📌' : '🕒'}</span>
                  <span className="flex-1"><span className="text-foreground">{h.title}</span>
                    <span className="block text-xs text-muted-foreground">{h.allDay ? dayLabel(h.start) : `ma ${timeLabel(h.start)}–${timeLabel(h.end)}`}</span></span>
                </button>
              ))}
              {!data.hataridokError && !data.hataridok.length && <div className="px-1.5 text-sm text-muted-foreground">Nincs határidő a következő 7 napban.</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
