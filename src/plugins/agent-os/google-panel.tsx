'use client'

/**
 * Agent OS – "Google" tab (fork addition): connect the Google account for the agents, see which
 * services they can use, and approve or reject e-mails they want to send. Nothing is sent without a
 * yes here. Data: /api/agent-os/google (src/lib/agent-os/google.ts).
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'

interface SendRequest {
  id: string; draftId: string; to: string; subject: string; preview: string; requestedBy: string; requestedAt: string
  status: 'pending' | 'sent' | 'rejected' | 'failed' | 'gone'; decidedAt?: string; note?: string
}
interface Status {
  connected: boolean; email: string | null; folderUrl: string | null; agents: string[]; requests: SendRequest[]
  services: { gmail: boolean; gmailDraft: boolean; drive: boolean; driveWrite: boolean; calendar: boolean; contacts: boolean; tasks: boolean }
}

const SERVICES: Array<{ key: keyof Status['services']; label: string; what: string }> = [
  { key: 'gmail', label: 'Gmail – olvasás', what: 'keresés, levelek olvasása, összefoglaló' },
  { key: 'gmailDraft', label: 'Gmail – piszkozat', what: 'piszkozat írása; küldés csak a te jóváhagyásoddal' },
  { key: 'drive', label: 'Drive – olvasás', what: 'keresés és olvasás a teljes Drive-ban (Docs, Sheets, Slides, Word, szöveg)' },
  { key: 'driveWrite', label: 'Drive – új fájl', what: 'új dokumentum az „Agent OS” mappába; felülírás és törlés nincs' },
  { key: 'calendar', label: 'Naptár – olvasás', what: 'minden naptárad eseménye (írás csak a heti terv naptárába, külön kapcsolattal)' },
  { key: 'contacts', label: 'Névjegyek – olvasás', what: 'név, e-mail, telefon keresése' },
  { key: 'tasks', label: 'Tasks', what: 'teendők olvasása és új teendő felvétele' },
]
const STATUS_HU: Record<SendRequest['status'], [string, string]> = {
  pending: ['Jóváhagyásra vár', 'text-yellow-400'], sent: ['Elküldve', 'text-green-400'], rejected: ['Elutasítva', 'text-muted-foreground'], failed: ['Nem ment el', 'text-red-400'],
  gone: ['Gmailben kezelve', 'text-muted-foreground'],
}

export function GooglePanel() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setStatus(await apiFetch<Status>('/api/agent-os/google')); setError(null) } catch (e) { setError(e instanceof Error ? e.message : 'Nem sikerült betölteni') }
  }, [])

  useEffect(() => {
    void load()
    const p = new URLSearchParams(window.location.search)
    if (p.get('google_error')) setError(`A Google-összekötés megszakadt: ${p.get('google_error')}`)
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [load])

  const decide = async (id: string, approve: boolean) => {
    setDeciding(id)
    try {
      const { request } = await apiFetch<{ request: SendRequest }>('/api/agent-os/google', { method: 'POST', body: JSON.stringify({ action: 'decide', id, approve }) })
      if (request.status === 'failed') setError(request.note || 'A levél nem ment el.')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A döntés nem ment át')
    } finally {
      setDeciding(null)
    }
  }

  const pending = status?.requests.filter(r => r.status === 'pending') || []
  const done = status?.requests.filter(r => r.status !== 'pending') || []

  return (
    <div className="p-4 space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold text-foreground">Google</h2>
        <span className="text-sm text-muted-foreground">Gmail, Drive, Naptár, Névjegyek, Tasks az ágenseknek – olvasás és új elem; küldés csak jóváhagyással.</span>
      </div>
      {error && <div className="text-sm text-red-400">{error}</div>}

      {!status ? <div className="text-sm text-muted-foreground">Betöltés…</div> : (
        <>
          <div className="rounded-lg border border-border bg-card p-4 space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`h-2.5 w-2.5 rounded-full ${status.connected ? 'bg-green-500' : 'bg-muted-foreground'}`} />
              <span className="text-foreground">{status.connected ? `Összekötve: ${status.email}` : 'Nincs összekötve'}</span>
              {status.folderUrl && <a className="text-primary underline" href={status.folderUrl} target="_blank" rel="noreferrer">„Agent OS” Drive-mappa</a>}
              <a className="ml-auto text-primary underline" href="/api/agent-os/calendar/oauth?action=start&target=google">{status.connected ? 'Újra összekötés' : 'Google-fiók összekötése'}</a>
            </div>
            <div className="text-xs text-muted-foreground">Ágensek: {status.agents.join(', ') || 'egyik sem (AOS_GOOGLE_AGENTS)'} · A Google „nem ellenőrzött alkalmazás” figyelmeztetést mutat; saját használatra a „Speciális” → „Tovább” linkkel léphetsz át rajta.</div>
            <div className="grid gap-1 sm:grid-cols-2">
              {SERVICES.map(s => (
                <div key={s.key} className="flex items-start gap-2">
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${status.services[s.key] ? 'bg-green-500' : 'bg-muted-foreground/50'}`} />
                  <div><span className="text-foreground">{s.label}</span> <span className="text-xs text-muted-foreground">– {s.what}</span></div>
                </div>
              ))}
            </div>
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Küldésre váró levelek ({pending.length})</h3>
            {pending.length === 0 && <div className="text-sm text-muted-foreground">Nincs jóváhagyásra váró levél.</div>}
            {pending.map(r => (
              <div key={r.id} className="rounded-lg border border-yellow-400/40 bg-card p-3 space-y-2 text-sm">
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>Kérte: {r.requestedBy}</span><span>{new Date(r.requestedAt).toLocaleString('hu-HU')}</span>
                </div>
                <div><span className="text-muted-foreground">Címzett: </span><span className="text-foreground">{r.to}</span></div>
                <div><span className="text-muted-foreground">Tárgy: </span><span className="text-foreground">{r.subject || '(nincs tárgy)'}</span></div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-secondary p-2 text-xs text-foreground">{r.preview}</pre>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void decide(r.id, true)} disabled={deciding === r.id}>Elküldés</Button>
                  <Button size="sm" variant="outline" onClick={() => void decide(r.id, false)} disabled={deciding === r.id}>Elutasítás</Button>
                  <a className="ml-auto self-center text-xs text-primary underline" href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noreferrer">Piszkozatok a Gmailben</a>
                </div>
              </div>
            ))}
          </section>

          {done.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-sm font-semibold text-foreground">Korábbi döntések</h3>
              <div className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
                {done.slice(0, 20).map(r => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                    <span className={STATUS_HU[r.status][1]}>{STATUS_HU[r.status][0]}</span>
                    <span className="text-foreground truncate max-w-[20rem]">{r.subject}</span>
                    <span className="text-xs text-muted-foreground">→ {r.to}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{r.decidedAt ? new Date(r.decidedAt).toLocaleString('hu-HU') : ''}</span>
                    {r.note && <span className={`w-full text-xs ${r.status === 'failed' ? 'text-red-400' : 'text-muted-foreground'}`}>{r.note}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
