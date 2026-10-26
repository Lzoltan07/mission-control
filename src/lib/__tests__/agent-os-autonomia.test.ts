import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AutonomiaError, autonomyLevel, getAutonomia, levelOf, setAutonomyLevel } from '@/lib/agent-os/autonomia'

// Agent OS fork: autonomy levels (src/lib/agent-os/autonomia.ts, Marveen module 1).
const seed = {
  version: 1,
  categories: [
    { key: 'drive_mentes', label: 'Drive', level: 3, locked: false, maxLevel: 3 },
    { key: 'email_send', label: 'E-mail', level: 2, locked: false, maxLevel: 2 },
    { key: 'payment', label: 'Pénz', level: 1, locked: true, maxLevel: 1 },
    { key: 'review_bypass', label: 'Ellenőrzés nélkül', level: 1, locked: true, maxLevel: 1 },
  ],
}

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-autonomia-'))
  fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(seed))
  process.env.AOS_AUTONOMIA_SEED = path.join(dir, 'seed.json')
  process.env.AOS_AUTONOMIA_FILE = path.join(dir, 'live.json')
})
afterEach(() => {
  delete process.env.AOS_AUTONOMIA_SEED
  delete process.env.AOS_AUTONOMIA_FILE
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('agent-os autonomia', () => {
  it('hiányzó konfiguráció vagy kulcs: 1-es szint', () => {
    process.env.AOS_AUTONOMIA_SEED = path.join(dir, 'nincs.json')
    expect(autonomyLevel('drive_mentes')).toBe(1)
    expect(levelOf('nincs_ilyen', { categories: seed.categories })).toBe(1)
  })

  it('első olvasáskor létrehozza az élő fájlt a seed szintjeivel', () => {
    expect(autonomyLevel('drive_mentes')).toBe(3)
    expect(fs.existsSync(path.join(dir, 'live.json'))).toBe(true)
  })

  it('zárolt kategória API-val sem emelhető (403)', () => {
    expect(() => setAutonomyLevel('payment', 3)).toThrowError(AutonomiaError)
    try { setAutonomyLevel('review_bypass', 2) } catch (e) { expect((e as AutonomiaError).status).toBe(403) }
    expect(autonomyLevel('review_bypass')).toBe(1)
  })

  it('a kézzel feloldott zárolt kategória is 1-es marad', () => {
    fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ categories: [{ key: 'payment', level: 3, locked: false, maxLevel: 3 }] }))
    expect(autonomyLevel('payment')).toBe(1)
  })

  it('maxLevel fölé nem állítható (400), alá igen', () => {
    try { setAutonomyLevel('email_send', 3) } catch (e) { expect((e as AutonomiaError).status).toBe(400) }
    setAutonomyLevel('drive_mentes', 1)
    expect(autonomyLevel('drive_mentes')).toBe(1)
    expect(getAutonomia().categories.find(c => c.key === 'drive_mentes')?.level).toBe(1)
  })

  it('sérült élő fájl: minden 1-es, és nem menthető', () => {
    fs.writeFileSync(path.join(dir, 'live.json'), '{ sérült')
    expect(autonomyLevel('drive_mentes')).toBe(1)
    expect(() => setAutonomyLevel('drive_mentes', 2)).toThrowError(/nem olvasható/)
  })
})
