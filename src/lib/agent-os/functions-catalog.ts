/**
 * Agent OS (fork addition): the functions shown on the "Funkciók" dashboard. `id` is the panel id
 * (navigation target); `gatewayOnly` panels only work with an OpenClaw gateway (local mode: off).
 * Shared by the panel (client) and /api/agent-os/overview (server), so no server imports here.
 */
export interface FunctionInfo {
  id: string
  label: string
  icon: string
  group: 'Alap' | 'Megfigyelés' | 'Automatizálás' | 'Adminisztráció' | 'Agent OS'
  description: string
  gatewayOnly?: boolean
  noLink?: boolean
}

export const FUNCTIONS: FunctionInfo[] = [
  { id: 'overview', label: 'Áttekintés', icon: '🏠', group: 'Alap', description: 'Összesítő kezdőlap testreszabható widgetekkel (ezen az Ágensfigyelő is).' },
  { id: 'agents', label: 'Ágensek', icon: '🤖', group: 'Alap', description: 'Az ágensek listája, profilja, kulcsai és állapota.' },
  { id: 'tasks', label: 'Feladatok', icon: '📋', group: 'Alap', description: 'A feladattábla: Bejövő → Kiosztva → Folyamatban → Ellenőrzés → Kész.' },
  { id: 'chat', label: 'Chat', icon: '💬', group: 'Alap', description: 'Beszélgetés az ágensekkel.' },
  { id: 'channels', label: 'Csatornák', icon: '📡', group: 'Alap', description: 'Üzenetküldő-csatornák (gatewayjel).', gatewayOnly: true },
  { id: 'skills', label: 'Skillek', icon: '🧩', group: 'Alap', description: 'Telepített skillek és biztonsági állapotuk.' },
  { id: 'memory', label: 'Memória (vault)', icon: '🧠', group: 'Alap', description: 'A közös Obsidian-vault böngészése és keresése.' },
  { id: 'heti-terv', label: 'Heti terv', icon: '📅', group: 'Agent OS', description: 'A heti terv időblokkjai a Google-naptárral szinkronban.' },
  { id: 'hang', label: 'Hang (Jarvis)', icon: '🎙️', group: 'Agent OS', description: 'A jobb alsó hanggomb: ébresztőszó, beszédfelismerés, felolvasás.', noLink: true },
  { id: 'activity', label: 'Tevékenység', icon: '📈', group: 'Megfigyelés', description: 'Minden esemény időrendben: feladatok, ágensek, felhasználók.' },
  { id: 'logs', label: 'Naplók', icon: '📜', group: 'Megfigyelés', description: 'A Mission Control élő naplója.' },
  { id: 'cost-tracker', label: 'Költség', icon: '💰', group: 'Megfigyelés', description: 'Tokenhasználat és becsült költség.' },
  { id: 'nodes', label: 'Csomópontok', icon: '🖧', group: 'Megfigyelés', description: 'Gateway-csomópontok.', gatewayOnly: true },
  { id: 'exec-approvals', label: 'Jóváhagyások', icon: '✅', group: 'Megfigyelés', description: 'Végrehajtás előtti jóváhagyási sor (gatewayjel).', gatewayOnly: true },
  { id: 'office', label: 'Iroda', icon: '🏢', group: 'Megfigyelés', description: 'Az ágensek „irodai” nézete.' },
  { id: 'monitor', label: 'Rendszerfigyelő', icon: '🖥️', group: 'Megfigyelés', description: 'Processzor, memória, lemez.' },
  { id: 'cron', label: 'Ütemezés', icon: '⏰', group: 'Automatizálás', description: 'Ismétlődő feladatok.' },
  { id: 'webhooks', label: 'Webhookok', icon: '🔗', group: 'Automatizálás', description: 'Kimenő értesítések más rendszereknek.' },
  { id: 'alerts', label: 'Riasztások', icon: '🚨', group: 'Automatizálás', description: 'Szabályok, amelyek eseménynél riasztanak.' },
  { id: 'github', label: 'GitHub', icon: '🐙', group: 'Automatizálás', description: 'GitHub-issue szinkron projektenként.' },
  { id: 'security', label: 'Biztonság', icon: '🛡️', group: 'Adminisztráció', description: 'Biztonsági események és ellenőrzés.' },
  { id: 'users', label: 'Felhasználók', icon: '👤', group: 'Adminisztráció', description: 'Felhasználók és szerepkörök.' },
  { id: 'audit', label: 'Audit', icon: '🔍', group: 'Adminisztráció', description: 'Adminisztratív műveletek naplója.' },
  { id: 'gateways', label: 'Gateway', icon: '🌐', group: 'Adminisztráció', description: 'OpenClaw-gatewayek (4. fázis).', gatewayOnly: true },
  { id: 'integrations', label: 'Integrációk', icon: '🔌', group: 'Adminisztráció', description: 'Külső szolgáltatások; az Agent OS integrációs feladatainak haladása.' },
  { id: 'debug', label: 'Hibakeresés', icon: '🐞', group: 'Adminisztráció', description: 'Diagnosztika.' },
  { id: 'settings', label: 'Beállítások', icon: '⚙️', group: 'Adminisztráció', description: 'A Mission Control beállításai.' },
]

export type FunctionState = 'ok' | 'warn' | 'idle' | 'off'

export interface FunctionStatus {
  id: string
  state: FunctionState
  summary: string
  /** 0..1 when the function has a measurable progress */
  progress?: number
  lastChange?: string // ISO
  details: Array<{ label: string; value: string }>
}

export interface AgentWatch {
  name: string
  role: string | null
  running: boolean
  currentTask: { id: number; title: string; status: string } | null
  done: number
  total: number
  lastActivity: { at: string; text: string } | null
  keyExpires: string | null
}

export interface RuntimeWatch {
  id: 'claude' | 'codex' | 'openclaw' | 'hermes'
  name: string
  installed: boolean
  version: string | null
  running: boolean
  authenticated: boolean
  activeSessions: number
  sessionsToday: number
  /** total tokens of the sessions active today (whole sessions, not only today's part) */
  tokensToday: number
  costToday: number | null
  lastActivity: string | null
  currentWork: string | null
  agents: number
  runningAgents: string[]
  openTasks: number
  doneTasks: number
  note: string | null
}
