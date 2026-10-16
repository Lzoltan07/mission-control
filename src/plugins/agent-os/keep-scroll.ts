'use client'

/**
 * Agent OS (fork addition): keeps a scroll container's position across panel switches. The panel
 * page re-mounts on every navigation, which reset the sidebar to the top. Returns a ref callback;
 * the position lives in sessionStorage (per browser tab) under `key`.
 */
import { useCallback, useRef } from 'react'

export function useKeepScroll(key: string) {
  const cleanup = useRef<(() => void) | null>(null)
  return useCallback((el: HTMLElement | null) => {
    cleanup.current?.()
    cleanup.current = null
    if (!el) return
    let saved = 0
    try { saved = Number(sessionStorage.getItem(key)) || 0 } catch {}
    // Restore after the items have rendered (the list can grow on the first frames).
    let tries = 0
    const restore = () => {
      if (saved <= 0) return
      el.scrollTop = saved
      if (el.scrollTop < saved && tries++ < 10) requestAnimationFrame(restore)
    }
    requestAnimationFrame(restore)
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { try { sessionStorage.setItem(key, String(el.scrollTop)) } catch {} })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    cleanup.current = () => { el.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) }
  }, [key])
}
