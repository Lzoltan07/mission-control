/**
 * Agent OS – Moodle (SZE-learning) for the agents, read-only (fork addition). See src/lib/agent-os/moodle-ws.ts.
 *
 * People (admin):  GET                                  → status (configured, connected, site, user)
 * Agents in AOS_MOODLE_AGENTS (and admins, for testing), all GET:
 *   ?action=courses[&all=1]                   current (or all) enrolled courses
 *   ?action=contents&course=                  sections, items, files of a course
 *   ?action=search&q=                         names of sections/items/files in the current courses
 *   ?action=file&course=&module=[&name=][&max=]   text of one file (downloaded on request, cached in the vault)
 *   ?action=forums[&course=]                  forums of a course, or all announcement forums
 *   ?action=news[&course=][&forum=][&days=][&limit=]   latest announcements / discussions
 *   ?action=discussion&id=                    posts of one discussion
 * There is no write action: nothing is posted, submitted or changed in Moodle.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import {
  MoodleError, moodleAgents, moodleCourseContents, moodleCourses, moodleDiscussion, moodleForums, moodleNews,
  moodleReadFile, moodleSearch, moodleStatus,
} from '@/lib/agent-os/moodle-ws'

const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined)

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const agent = auth.user.agent_name
  if (agent ? !moodleAgents().includes(agent) : auth.user.role !== 'admin') {
    return NextResponse.json({ error: 'This agent may not use Moodle' }, { status: 403 })
  }
  const p = new URL(request.url).searchParams
  const action = p.get('action')
  try {
    switch (action) {
      case null: return NextResponse.json(await moodleStatus())
      case 'courses': return NextResponse.json({ courses: await moodleCourses(p.get('all') === '1') })
      case 'contents': return NextResponse.json({ sections: await moodleCourseContents(num(p.get('course')) || 0) })
      case 'search': return NextResponse.json({ results: await moodleSearch(p.get('q') || '', num(p.get('limit')) || 25) })
      case 'file': {
        const r = await moodleReadFile(num(p.get('course')) || 0, num(p.get('module')) || 0, p.get('name') || undefined, num(p.get('max')) || 20000)
        logAuditEvent({ action: 'agent_os_moodle_file', actor: agent ? `agent:${agent}` : auth.user.username, detail: { course: r.course, file: r.file, cached: r.cached } })
        return NextResponse.json(r)
      }
      case 'forums': return NextResponse.json({ forums: await moodleForums(num(p.get('course'))) })
      case 'news': return NextResponse.json({ posts: await moodleNews({ courseId: num(p.get('course')), forumId: num(p.get('forum')), days: num(p.get('days')), limit: num(p.get('limit')) }) })
      case 'discussion': return NextResponse.json({ posts: await moodleDiscussion(num(p.get('id')) || 0) })
      default: return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof MoodleError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: 'Moodle request failed' }, { status: 500 })
  }
}
