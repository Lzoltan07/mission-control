/**
 * Agent OS – Google Calendar connection (fork addition).
 *   GET ?action=start[&target=google]  admin only → one-time random state in an httpOnly cookie, redirect to Google
 *                                   consent (narrow scopes, see lib/agent-os/calendar.ts)
 *   GET ?code&state    Google redirects back here; stores the refresh token in the data dir (mode 600)
 *
 * The callback is a cross-site navigation from accounts.google.com, so the SameSite=strict session
 * cookie is NOT sent (proxy.ts lets this one path through). It is authenticated by the state cookie
 * instead: 192 random bits, issued only to an admin at ?action=start, SameSite=lax, path-scoped,
 * valid for 10 minutes and single-use.
 *
 * The same callback serves the Google account connection for the agents (target=google, src/lib/agent-os/google.ts): the
 * state cookie carries the target, so no second redirect URI or proxy exception is needed.
 *
 * Register this URL as an authorised redirect URI on the Google OAuth client:
 *   <origin>/api/agent-os/calendar/oauth
 */
import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { CalendarError, googleAuthUrl, googleExchangeCode } from '@/lib/agent-os/calendar'
import { workspaceAuthUrl, workspaceExchangeCode } from '@/lib/agent-os/google'

const STATE_COOKIE = 'aos_gcal_state'
const COOKIE_PATH = '/api/agent-os/calendar/oauth'

function clearState(res: NextResponse) {
  res.cookies.set(STATE_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: COOKIE_PATH, maxAge: 0 })
  return res
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const redirectUri = `${url.origin}${COOKIE_PATH}`

  if (url.searchParams.get('action') === 'start') {
    const auth = requireRole(request, 'admin')
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
    try {
      const workspace = url.searchParams.get('target') === 'google'
      const state = (workspace ? 'google.' : '') + crypto.randomBytes(24).toString('hex')
      const res = NextResponse.redirect(workspace ? workspaceAuthUrl(redirectUri, state) : googleAuthUrl(redirectUri, state))
      res.cookies.set(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', path: COOKIE_PATH, maxAge: 600 })
      return res
    } catch (err) {
      const message = err instanceof CalendarError ? err.message : 'Google connection failed'
      return NextResponse.json({ error: message }, { status: err instanceof CalendarError ? err.status : 500 })
    }
  }

  // Callback from Google: authenticated by the one-time state cookie, not by the session.
  const state = url.searchParams.get('state')
  const expected = request.cookies.get(STATE_COOKIE)?.value
  if (!state || !expected || state.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    return clearState(NextResponse.json({ error: 'Invalid or expired OAuth state; start again from the Heti terv tab' }, { status: 400 }))
  }
  const workspace = state.startsWith('google.')
  const back = workspace ? '/google' : '/heti-terv'
  const googleError = url.searchParams.get('error')
  if (googleError) {
    return clearState(NextResponse.redirect(`${url.origin}${back}?google_error=${encodeURIComponent(googleError)}`))
  }
  const code = url.searchParams.get('code')
  if (!code) return clearState(NextResponse.json({ error: 'Missing authorization code' }, { status: 400 }))

  try {
    if (workspace) await workspaceExchangeCode(code, redirectUri)
    else await googleExchangeCode(code, redirectUri)
    return clearState(NextResponse.redirect(`${url.origin}${back}?connected=1`))
  } catch (err) {
    const message = err instanceof CalendarError ? err.message : 'Google connection failed'
    return clearState(NextResponse.json({ error: message }, { status: err instanceof CalendarError ? err.status : 500 }))
  }
}
