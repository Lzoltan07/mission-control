/**
 * Agent OS plugin (fork addition). Registers our own tabs through Mission Control's plugin registry.
 * Imported once from the panel page and the nav rail; everything Agent OS-specific lives under
 * src/plugins/agent-os, src/lib/agent-os and src/app/api/agent-os to keep upstream merges easy.
 */
import { registerNavItems, registerPanel, getPluginPanel } from '@/lib/plugins'
import { HetiTervPanel } from './heti-terv-panel'

if (!getPluginPanel('heti-terv')) {
  registerNavItems([{ id: 'heti-terv', label: 'Heti terv', icon: '📅', groupId: 'core' }])
  registerPanel('heti-terv', HetiTervPanel)
}
