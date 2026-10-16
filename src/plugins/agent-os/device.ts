'use client'

/**
 * Agent OS (fork addition): this browser's device identity for the execution log. A random id kept in
 * localStorage plus an optional name ("Laptop", "iPhone"). Sent with voice questions (x-aos-device)
 * and as a heartbeat while Mission Control is open, so a board assignment can be traced to the
 * device that was active at that moment.
 */
import { useEffect } from 'react'
import { apiFetch } from '@/lib/api-client'

const ID_KEY = 'aos-device-id'
const NAME_KEY = 'aos-device-name'

export function deviceId(): string {
  try {
    let id = localStorage.getItem(ID_KEY)
    if (!id || !/^[a-z0-9-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).toLowerCase()
      localStorage.setItem(ID_KEY, id)
    }
    return id
  } catch {
    return 'ismeretlen-eszkoz'
  }
}

export function deviceName(): string {
  try { return localStorage.getItem(NAME_KEY) || '' } catch { return '' }
}

export async function setDeviceName(name: string) {
  try { localStorage.setItem(NAME_KEY, name) } catch {}
  await apiFetch('/api/agent-os/executions', { method: 'POST', body: JSON.stringify({ action: 'rename', deviceId: deviceId(), name }) })
}

/** Heartbeat every minute while the page is open (and visible). */
export function DeviceBeacon() {
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState === 'hidden') return
      apiFetch('/api/agent-os/executions', {
        method: 'POST', redirectOnUnauthenticated: false,
        body: JSON.stringify({ action: 'seen', deviceId: deviceId(), name: deviceName() || null }),
      }).catch(() => {})
    }
    beat()
    const t = setInterval(beat, 60_000)
    document.addEventListener('visibilitychange', beat)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', beat) }
  }, [])
  return null
}
