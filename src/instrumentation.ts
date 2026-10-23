/**
 * Next.js start-up hook. Agent OS fork: starts and supervises the local voice servers (whisper, Piper)
 * together with Mission Control when AOS_VOICE_SERVERS=1 – see src/lib/agent-os/voice-servers.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.AOS_VOICE_SERVERS !== '1') return
  const { startVoiceServers } = await import('@/lib/agent-os/voice-servers')
  await startVoiceServers()
}
