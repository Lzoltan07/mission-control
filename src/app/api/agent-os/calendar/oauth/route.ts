/**
 * Agent OS – Google Calendar connection (fork addition). Admin only.
 *   GET ?action=start  → redirect to Google consent (narrow scopes, see lib/agent-os/calendar.ts)
 *   GET ?code&state    → Google redirects back here; stores the refresh token in the data dir (mode 600)
 * Register this URL as an authorised redirect URI on the Google OAuth client:
 *   <origin>/api/agent-os/calendar/oauth
 */
import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { CalendarError, googleAuthUrl, googleExchangeCode } from '@/lib/agent-os/calendar'

const STATE_COOKIE = 'aos_gcal_state'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const url = new URL(request.url)
  const redirectUri = `${url.origin}/api/agent-os/calendar/oauth`
  try {
    if (url.searchParams.get('action') === 'start') {
      const state = crypto.randomBytes(24).toString('hex')
      const res = NextResponse.redirect(googleAuthUrl(redirectUri, state))
      res.cookies.set(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', path: '/api/agent-os/calendar/oauth', maxAge: 600 })
      return res
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const expected = request.cookies.get(STATE_COOKIE)?.value
    if (!code || !state || !expected || state.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
      return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 })
    }
    await googleExchangeCode(code, redirectUri)
    const res = NextResponse.redirect(`${url.origin}/heti-terv?connected=1`)
    res.cookies.delete(STATE_COOKIE)
    return res
  } catch (err) {
    const message = err instanceof CalendarError ? err.message : 'Google connection failed'
    return NextResponse.json({ error: message }, { status: err instanceof CalendarError ? err.status : 500 })
  }
}
