/**
 * Agent OS – autonomy levels per category (fork addition, 2026-10-26; Marveen module 1, docs/22-autonomia.md).
 *   1 = only report, 2 = propose and wait for approval, 3 = act and report afterwards.
 * Seed: <agent-os>/config/autonomia.json (decides labels, what is locked and the caps); live copy:
 * $AOS_HOME/data/autonomia.json (the owner's levels). The runner reads the same files (agents/runner/autonomia-lib.mjs)
 * and leaves out of a run every tool whose category is below its level; this side shows and edits the levels and
 * enforces them on the server (e-mail send requests).
 * The reading rule – a missing or unreadable file or key is level 1, maxLevel caps the level – follows Marveen's
 * src/web/autonomy-level.ts (github.com/Szotasz/marveen @ 779c89a, MIT, © 2026 Szotasz).
 *
 * Env: AOS_AUTONOMIA_FILE (live), AOS_AUTONOMIA_SEED (default <AOS_RUNNER_DIR>/../../config/autonomia.json).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type AutonomyLevel = 1 | 2 | 3
export interface AutonomyCategory { key: string; label: string; level: number; locked: boolean; maxLevel: number }
export interface AutonomyConfig { version: number; updated_at: number; categories: AutonomyCategory[] }

export class AutonomiaError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

const runnerDir = () => process.env.AOS_RUNNER_DIR || path.join(os.homedir(), 'agent-os', 'os', 'agents', 'runner')
export const seedFile = () => process.env.AOS_AUTONOMIA_SEED || path.resolve(runnerDir(), '..', '..', 'config', 'autonomia.json')
export const liveFile = () => process.env.AOS_AUTONOMIA_FILE
  || path.join(process.env.AOS_HOME || path.join(os.homedir(), '.agent-os'), 'data', 'autonomia.json')

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))

export function levelOf(key: string, cfg: { categories?: Partial<AutonomyCategory>[] } | null): AutonomyLevel {
  const cat = (cfg?.categories || []).find(c => c && c.key === key)
  if (!cat) return 1
  const raw = Number(cat.level)
  if (!Number.isInteger(raw) || cat.locked === true) return 1
  const cap = Number.isInteger(cat.maxLevel) ? Number(cat.maxLevel) : 3
  return Math.max(1, Math.min(3, raw, cap)) as AutonomyLevel
}

/** Live levels over the seed's categories; label, locked and maxLevel always from the seed. */
export function mergeWithSeed(seed: AutonomyConfig | null, live: Partial<AutonomyConfig> | null): AutonomyConfig | null {
  if (!seed?.categories) return null
  const liveCats = new Map((live?.categories || []).filter(c => c?.key).map(c => [c.key, c]))
  return {
    version: seed.version || 1,
    updated_at: live?.updated_at || 0,
    categories: seed.categories.map(s => {
      const l = liveCats.get(s.key)
      const level = l && Number.isInteger(Number(l.level)) ? Number(l.level) : s.level
      const maxLevel = s.locked ? 1 : (s.maxLevel ?? 3)
      return { key: s.key, label: s.label, level: s.locked ? 1 : Math.max(1, Math.min(3, level, maxLevel)), locked: !!s.locked, maxLevel }
    }),
  }
}

function writeLive(cfg: AutonomyConfig) {
  const file = liveFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/** The effective config; source tells whether it came from the files or fell back to "everything level 1". */
export function getAutonomia(): AutonomyConfig & { source: 'config' | 'unreadable' | 'missing' } {
  let seed: AutonomyConfig | null = null, live: Partial<AutonomyConfig> | null = null, liveText: string | null = null
  try { seed = readJson(seedFile()) } catch {}
  try { liveText = fs.readFileSync(liveFile(), 'utf8'); live = JSON.parse(liveText.replace(/^﻿/, '')) } catch {}
  if (liveText !== null && live === null) return { version: 1, updated_at: 0, categories: [], source: 'unreadable' }
  const merged = mergeWithSeed(seed, live)
  if (!merged) return { version: 1, updated_at: 0, categories: [], source: 'missing' }
  const known = new Set((live?.categories || []).map(c => c?.key))
  if (!live || merged.categories.some(c => !known.has(c.key))) { try { writeLive(merged) } catch {} }
  return { ...merged, source: 'config' }
}

export function autonomyLevel(key: string): AutonomyLevel {
  return levelOf(key, getAutonomia())
}

/** Owner's change. Locked categories cannot be raised; maxLevel caps every other one. */
export function setAutonomyLevel(key: string, level: number): AutonomyConfig {
  if (!Number.isInteger(level) || level < 1 || level > 3) throw new AutonomiaError('A szint 1, 2 vagy 3 lehet.', 400)
  const cfg = getAutonomia()
  if (cfg.source !== 'config') throw new AutonomiaError('Az autonómia-beállítás nem olvasható; minden kategória 1-es szinten fut.', 409)
  const cat = cfg.categories.find(c => c.key === key)
  if (!cat) throw new AutonomiaError(`Nincs ilyen kategória: ${key}`, 404)
  if (cat.locked && level > 1) throw new AutonomiaError(`A(z) „${cat.label}” zárolt kategória, 1-es szinten marad.`, 403)
  if (level > cat.maxLevel) throw new AutonomiaError(`A(z) „${cat.label}” legfeljebb ${cat.maxLevel}. szintre állítható.`, 400)
  cat.level = level
  const { source: _source, ...rest } = cfg
  const next = { ...rest, updated_at: Math.floor(Date.now() / 1000) }
  writeLive(next)
  return next
}
