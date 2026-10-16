/**
 * Agent OS plugin (fork addition). Registers our own tabs through Mission Control's plugin registry.
 * Imported once from the panel page and the nav rail; everything Agent OS-specific lives under
 * src/plugins/agent-os, src/lib/agent-os and src/app/api/agent-os to keep upstream merges easy.
 * The always-on voice button (./voice-assistant) is not a tab: the panel page renders it on every page.
 */
import { registerNavItems, registerPanel, getPluginPanel } from '@/lib/plugins'
import { HetiTervPanel } from './heti-terv-panel'
import { FunkciokPanel } from './funkciok-panel'

export { VoiceAssistant } from './voice-assistant'
export { ExecutionLog } from './execution-log'
export { DeviceBeacon } from './device'

if (!getPluginPanel('heti-terv')) {
  registerNavItems([
    { id: 'funkciok', label: 'Funkciók', icon: '🧭', groupId: 'core' },
    { id: 'heti-terv', label: 'Heti terv', icon: '📅', groupId: 'core' },
  ])
  registerPanel('funkciok', FunkciokPanel)
  registerPanel('heti-terv', HetiTervPanel)
}
export { useKeepScroll } from './keep-scroll'
