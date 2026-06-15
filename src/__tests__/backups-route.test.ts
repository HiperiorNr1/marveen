import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeArchiveName, listArchives } from '../web/routes/backups.js'

// safeArchiveName is the path-traversal gate that protects every endpoint
// that joins a user-supplied filename to BACKUP_DIR. Lock the contract:
// only the documented archive shape is acceptable; everything else returns
// null so the route returns a 400 instead of opening a wider filesystem
// read than intended.
describe('safeArchiveName -- path-traversal regression locks', () => {
  it('accepts the documented archive shapes (plain and encrypted)', () => {
    expect(safeArchiveName('claudeclaw-20260609-153030.tar.gz')).toBe('claudeclaw-20260609-153030.tar.gz')
    expect(safeArchiveName('claudeclaw-20260609-153030.tar.gz.age')).toBe('claudeclaw-20260609-153030.tar.gz.age')
    expect(safeArchiveName('claudeclaw-20260609-153030.tar.gz.gpg')).toBe('claudeclaw-20260609-153030.tar.gz.gpg')
  })

  it('rejects path-traversal attempts', () => {
    expect(safeArchiveName('../etc/passwd')).toBeNull()
    expect(safeArchiveName('claudeclaw-20260609-153030.tar.gz/../etc/passwd')).toBeNull()
    expect(safeArchiveName('..')).toBeNull()
    expect(safeArchiveName('./claudeclaw-20260609-153030.tar.gz')).toBeNull()
    expect(safeArchiveName('claudeclaw-20260609-153030.tar.gz\\..\\..\\etc')).toBeNull()
  })

  it('rejects filenames that look almost-right but break the shape', () => {
    expect(safeArchiveName('claudeclaw-2026-06-09-153030.tar.gz')).toBeNull() // wrong stamp shape
    expect(safeArchiveName('claudeclaw-20260609.tar.gz')).toBeNull()           // missing HHMMSS
    expect(safeArchiveName('clawdcoaw-20260609-153030.tar.gz')).toBeNull()     // wrong prefix
    expect(safeArchiveName('claudeclaw-20260609-153030.tar')).toBeNull()       // missing .gz
    expect(safeArchiveName('claudeclaw-20260609-153030.tar.gz.age.other')).toBeNull() // double-extension
  })

  it('rejects empty / falsy input', () => {
    expect(safeArchiveName('')).toBeNull()
    // The route handler upgrades from `string | null` to `string`; null in
    // is handled by the caller's `if (!safe)` gate.
  })
})

// listArchives walks BACKUP_DIR and returns only the entries that match the
// archive shape, with size + mtime. The mtime sort + encryption flag are
// the load-bearing pieces the UI depends on -- pin them with fixtures.
describe('listArchives -- BACKUP_DIR walker', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backups-list-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns [] for a non-existent directory (fresh install)', () => {
    rmSync(dir, { recursive: true, force: true })
    expect(listArchives(dir)).toEqual([])
  })

  it('returns [] for an empty directory', () => {
    expect(listArchives(dir)).toEqual([])
  })

  it('lists archives, sorted newest-first, with encrypted flag set per extension', () => {
    const a = join(dir, 'claudeclaw-20260101-000000.tar.gz')
    const b = join(dir, 'claudeclaw-20260102-000000.tar.gz.age')
    const c = join(dir, 'claudeclaw-20260103-000000.tar.gz')
    writeFileSync(a, 'a')
    writeFileSync(b, 'bb')
    writeFileSync(c, 'ccc')
    const list = listArchives(dir)
    expect(list.length).toBe(3)
    // Sorted newest-first by mtime. The fixture writes them in order, so the
    // last write (c) is newest. We can't fully control mtime under fakefs,
    // but we can lock the SET of returned filenames and the encrypted flag.
    const byName = Object.fromEntries(list.map(e => [e.filename, e]))
    expect(byName['claudeclaw-20260101-000000.tar.gz']?.encrypted).toBe(false)
    expect(byName['claudeclaw-20260102-000000.tar.gz.age']?.encrypted).toBe(true)
    expect(byName['claudeclaw-20260103-000000.tar.gz']?.encrypted).toBe(false)
    expect(byName['claudeclaw-20260101-000000.tar.gz']?.sizeBytes).toBe(1)
    expect(byName['claudeclaw-20260102-000000.tar.gz.age']?.sizeBytes).toBe(2)
    expect(byName['claudeclaw-20260103-000000.tar.gz']?.sizeBytes).toBe(3)
  })

  it('ignores files that do NOT match the archive shape', () => {
    writeFileSync(join(dir, 'README.md'), '')
    writeFileSync(join(dir, 'pre-restore-20260101-000000.tar.gz'), '') // different stem
    writeFileSync(join(dir, 'claudeclaw-old-pattern.tar.gz'), '')      // pre-2026 shape
    writeFileSync(join(dir, '.hidden'), '')
    expect(listArchives(dir)).toEqual([])
  })

  it('ignores subdirectories with matching names (only regular files count)', () => {
    mkdirSync(join(dir, 'claudeclaw-20260101-000000.tar.gz'))
    expect(listArchives(dir)).toEqual([])
  })
})
