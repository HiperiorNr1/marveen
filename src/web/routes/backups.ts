import { existsSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { PROJECT_ROOT } from '../../config.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import type { RouteContext } from './types.js'

// Dashboard surface for scripts/backup.sh + scripts/restore.sh. Read-only on
// the encryption configuration -- the encryption mode and the age recipient
// / escape-hatch command are CLI-only by design (one less way to fat-finger
// a deploy). Reads:
//   - filesystem listing of BACKUP_DIR for archives
//   - backup_jobs SQLite table (populated by `backup.sh --report`)
//   - BACKUP_LOG (defaults to store/backups.log)
// Writes:
//   - .env's BACKUP_DIR + BACKUP_KEEP (settings POST)
//   - new backup_jobs row indirectly via `backup.sh --report --source=manual`
//
// IMPORTANT: by Krisztián decision, this module does NOT implement a restore
// endpoint. Restore is CLI-only via scripts/restore.sh (a one-click web
// restore on a deploy day would be catastrophic).

interface ArchiveInfo {
  filename: string
  path: string
  sizeBytes: number
  createdAtMs: number
  encrypted: boolean
}

interface BackupJobRow {
  id: number
  status: 'ok' | 'fail'
  started_at_ms: number
  ended_at_ms: number
  duration_ms: number
  archive_path: string | null
  size_bytes: number | null
  encrypted: number
  encryption_mode: string | null
  source: string
  error: string | null
}

const ENV_FILE = join(PROJECT_ROOT, '.env')
const DEFAULT_BACKUP_DIR = join(PROJECT_ROOT, 'backups')
const DEFAULT_BACKUP_KEEP = 14
const DEFAULT_BACKUP_LOG = join(PROJECT_ROOT, 'store', 'backups.log')

// Mirror backup.sh's `_extract_env_var` parsing -- last definition wins,
// surrounding matching quotes stripped. Returns null when the key is unset.
// Exported for testability so the .env contract that the route surface
// depends on is locked in unit tests, not just integration tests.
export function readEnvValue(key: string): string | null {
  if (!existsSync(ENV_FILE)) return null
  try {
    const lines = readFileSync(ENV_FILE, 'utf-8').split('\n')
    let value: string | null = null
    const rx = new RegExp(`^[\\s]*${key}[\\s]*=`)
    for (const line of lines) {
      if (!rx.test(line)) continue
      let v = line.replace(rx, '').trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      value = v
    }
    return value
  } catch (err) {
    logger.debug({ err, key }, 'backups: readEnvValue failed')
    return null
  }
}

function readBackupDir(): string {
  const v = readEnvValue('BACKUP_DIR')
  return v && v.length > 0 ? v : DEFAULT_BACKUP_DIR
}

function readBackupKeep(): number {
  const v = readEnvValue('BACKUP_KEEP')
  const n = v ? parseInt(v, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BACKUP_KEEP
}

function readBackupLog(): string {
  const v = readEnvValue('BACKUP_LOG')
  return v && v.length > 0 ? v : DEFAULT_BACKUP_LOG
}

function readEncryptionConfig(): {
  mode: string
  ageRecipient: string | null
  encryptCmdConfigured: boolean
} {
  return {
    // Match backup.sh's built-in default: when .env does not set the mode,
    // the script falls back to 'none' (backward-compat with pre-2026-06-09
    // upstream installs). The dashboard surfaces the EFFECTIVE mode, so
    // this default must track backup.sh exactly.
    mode: readEnvValue('BACKUP_ENCRYPTION') ?? 'none',
    ageRecipient: readEnvValue('BACKUP_AGE_RECIPIENT'),
    encryptCmdConfigured: !!readEnvValue('BACKUP_ENCRYPT_CMD'),
  }
}

// Exported for fixture-based listing tests.
export function listArchives(dir: string): ArchiveInfo[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  const out: ArchiveInfo[] = []
  for (const f of entries) {
    if (!/^claudeclaw-[0-9]{8}-[0-9]{6}\.tar\.gz(?:\.[A-Za-z0-9]+)?$/.test(f)) continue
    const full = join(dir, f)
    let st: ReturnType<typeof statSync>
    try { st = statSync(full) } catch { continue }
    if (!st.isFile()) continue
    out.push({
      filename: f,
      path: full,
      sizeBytes: st.size,
      createdAtMs: st.mtimeMs,
      encrypted: !f.endsWith('.tar.gz'),
    })
  }
  out.sort((a, b) => b.createdAtMs - a.createdAtMs)
  return out
}

function backupJobsTableExists(): boolean {
  try {
    const db = getDb()
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='backup_jobs'").get() as { name?: string } | undefined
    return !!row?.name
  } catch { return false }
}

function getLastJob(): BackupJobRow | null {
  if (!backupJobsTableExists()) return null
  try {
    const db = getDb()
    return db.prepare('SELECT * FROM backup_jobs ORDER BY id DESC LIMIT 1').get() as BackupJobRow | undefined ?? null
  } catch (err) {
    logger.debug({ err }, 'backups: getLastJob failed')
    return null
  }
}

function getJob(id: number): BackupJobRow | null {
  if (!backupJobsTableExists()) return null
  try {
    const db = getDb()
    return db.prepare('SELECT * FROM backup_jobs WHERE id = ?').get(id) as BackupJobRow | undefined ?? null
  } catch { return null }
}

function getJobByStartedAtRange(minStartedAtMs: number): BackupJobRow | null {
  if (!backupJobsTableExists()) return null
  try {
    const db = getDb()
    return db.prepare('SELECT * FROM backup_jobs WHERE started_at_ms >= ? ORDER BY id DESC LIMIT 1').get(minStartedAtMs) as BackupJobRow | undefined ?? null
  } catch { return null }
}

function listJobs(limit: number): BackupJobRow[] {
  if (!backupJobsTableExists()) return []
  try {
    const db = getDb()
    return db.prepare('SELECT * FROM backup_jobs ORDER BY id DESC LIMIT ?').all(limit) as BackupJobRow[]
  } catch { return [] }
}

function tailLog(path: string, lines: number): string[] {
  if (!existsSync(path)) return []
  try {
    const content = readFileSync(path, 'utf-8')
    const all = content.split('\n')
    return all.slice(-lines).filter(s => s.length > 0)
  } catch { return [] }
}

function sha256OfFile(path: string): string | null {
  try {
    const h = createHash('sha256')
    h.update(readFileSync(path))
    return h.digest('hex')
  } catch { return null }
}

// .env writer: idempotent upsert of a single key. Preserves comments, line
// order, and surrounding keys. Replaces an existing line in place rather
// than appending duplicates.
function upsertEnvValue(key: string, value: string): void {
  let lines: string[] = []
  if (existsSync(ENV_FILE)) {
    lines = readFileSync(ENV_FILE, 'utf-8').split('\n')
  }
  const rx = new RegExp(`^[\\s]*${key}[\\s]*=`)
  let found = false
  const out = lines.map(l => {
    if (rx.test(l) && !found) {
      found = true
      return `${key}=${value}`
    }
    return l
  })
  if (!found) {
    if (out.length > 0 && out[out.length - 1] === '') {
      out.splice(out.length - 1, 0, `${key}=${value}`)
    } else {
      out.push(`${key}=${value}`)
    }
  }
  atomicWriteFileSync(ENV_FILE, out.join('\n'))
}

function spawnBackup(source: 'manual'): { startedAtMs: number } {
  const startedAtMs = Date.now()
  const script = join(PROJECT_ROOT, 'scripts', 'backup.sh')
  if (!existsSync(script)) {
    throw new Error(`backup.sh not found at ${script}`)
  }
  const child = spawn('/bin/bash', [script, '--report', `--source=${source}`], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  logger.info({ source, pid: child.pid }, 'backups: backup.sh dispatched')
  return { startedAtMs }
}

// Safely sanitize a filename query parameter so it never escapes BACKUP_DIR.
// Exported for path-traversal regression tests.
export function safeArchiveName(name: string): string | null {
  if (!name) return null
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
  if (!/^claudeclaw-[0-9]{8}-[0-9]{6}\.tar\.gz(?:\.[A-Za-z0-9]+)?$/.test(name)) return null
  return name
}

export async function tryHandleBackups(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // GET /api/backups -- list archives in BACKUP_DIR (sorted newest first).
  if (path === '/api/backups' && method === 'GET') {
    const dir = readBackupDir()
    const archives = listArchives(dir)
    json(res, { dir, archives })
    return true
  }

  // GET /api/backups/last -- most-recent job row + last archive on disk.
  if (path === '/api/backups/last' && method === 'GET') {
    const job = getLastJob()
    const archives = listArchives(readBackupDir())
    json(res, { job, lastArchive: archives[0] ?? null })
    return true
  }

  // POST /api/backups -- trigger a backup. The script runs detached + writes
  // its own backup_jobs row at end. The caller polls /api/backups/jobs/poll
  // to learn the outcome.
  if (path === '/api/backups' && method === 'POST') {
    try {
      const { startedAtMs } = spawnBackup('manual')
      json(res, { triggered: true, startedAtMs, pollUrl: `/api/backups/jobs/poll?after=${startedAtMs}` })
    } catch (err) {
      logger.warn({ err }, 'backups: trigger failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  // GET /api/backups/jobs/poll?after=<startedAtMs> -- the trigger response
  // returns a startedAtMs marker; the UI polls here for the resulting row.
  if (path === '/api/backups/jobs/poll' && method === 'GET') {
    const after = parseInt(url.searchParams.get('after') || '0', 10)
    const job = Number.isFinite(after) && after > 0 ? getJobByStartedAtRange(after) : null
    json(res, { job })
    return true
  }

  // GET /api/backups/jobs?limit=20 -- recent backup_jobs rows.
  if (path === '/api/backups/jobs' && method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 200)
    json(res, { jobs: listJobs(limit) })
    return true
  }

  // GET /api/backups/jobs/:id -- single job row by primary key.
  {
    const m = path.match(/^\/api\/backups\/jobs\/(\d+)$/)
    if (m && method === 'GET') {
      const job = getJob(parseInt(m[1]!, 10))
      if (!job) { json(res, { error: 'not found' }, 404); return true }
      json(res, { job })
      return true
    }
  }

  // GET /api/backups/settings -- effective configuration (encryption command
  // contents are NOT returned, only set/unset flags).
  if (path === '/api/backups/settings' && method === 'GET') {
    const enc = readEncryptionConfig()
    json(res, {
      backupDir: readBackupDir(),
      backupKeep: readBackupKeep(),
      backupLog: readBackupLog(),
      encryption: {
        mode: enc.mode,
        ageRecipient: enc.ageRecipient,
        encryptCmdConfigured: enc.encryptCmdConfigured,
      },
      // Surface install state so the UI can hint at next steps without
      // shipping detection logic in two places.
      writable: existsSync(ENV_FILE) && (() => { try { writeFileSync(ENV_FILE + '.touchtest', ''); return true } catch { return false } finally { try { require('node:fs').unlinkSync(ENV_FILE + '.touchtest') } catch {} } })(),
    })
    return true
  }

  // POST /api/backups/settings -- update BACKUP_DIR + BACKUP_KEEP only.
  // Encryption mode/recipient/encrypt-cmd are CLI-only (write directly to
  // .env). Validation up front: absolute path, sensible keep window.
  if (path === '/api/backups/settings' && method === 'POST') {
    const body = await readBody(req)
    let data: { backupDir?: string; backupKeep?: number } = {}
    try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'invalid JSON body' }, 400); return true }
    const next: { backupDir?: string; backupKeep?: number } = {}
    if (typeof data.backupDir === 'string') {
      const v = data.backupDir.trim()
      if (!v) { json(res, { error: 'backupDir cannot be empty' }, 400); return true }
      if (!isAbsolute(v)) { json(res, { error: 'backupDir must be an absolute path' }, 400); return true }
      next.backupDir = v
    }
    if (typeof data.backupKeep === 'number') {
      if (!Number.isInteger(data.backupKeep) || data.backupKeep < 1 || data.backupKeep > 1000) {
        json(res, { error: 'backupKeep must be an integer in [1, 1000]' }, 400); return true
      }
      next.backupKeep = data.backupKeep
    }
    if (next.backupDir == null && next.backupKeep == null) {
      json(res, { error: 'no fields to update' }, 400); return true
    }
    try {
      if (next.backupDir != null) upsertEnvValue('BACKUP_DIR', next.backupDir)
      if (next.backupKeep != null) upsertEnvValue('BACKUP_KEEP', String(next.backupKeep))
      json(res, { ok: true, updated: next })
    } catch (err) {
      logger.warn({ err }, 'backups: settings update failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  // GET /api/backups/logs?lines=200 -- tail of BACKUP_LOG.
  if (path === '/api/backups/logs' && method === 'GET') {
    const lines = Math.min(parseInt(url.searchParams.get('lines') || '200', 10), 5000)
    json(res, { path: readBackupLog(), lines: tailLog(readBackupLog(), lines) })
    return true
  }

  // GET /api/backups/:filename/checksum -- SHA-256 of an archive on disk.
  // Used by the UI's "verify archive" button + by external operators to
  // confirm a transferred archive matches the source.
  {
    const m = path.match(/^\/api\/backups\/([^/]+)\/checksum$/)
    if (m && method === 'GET') {
      const safe = safeArchiveName(decodeURIComponent(m[1]!))
      if (!safe) { json(res, { error: 'invalid filename' }, 400); return true }
      const full = join(readBackupDir(), safe)
      if (!existsSync(full)) { json(res, { error: 'not found' }, 404); return true }
      const sha = sha256OfFile(full)
      if (!sha) { json(res, { error: 'checksum failed' }, 500); return true }
      json(res, { filename: safe, sha256: sha })
      return true
    }
  }

  return false
}
