import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldWarnEmbedFailure } from '../db.js'

// Embedding outage visibility (card 6d7d14a8). A silent fire-and-forget embed
// failure let 181 memories accumulate NULL embeddings unnoticed for days when
// Ollama died (2026-06-03). The gate must make a real outage visible WITHOUT
// spamming the common case where Ollama was simply never installed.
describe('shouldWarnEmbedFailure -- outage-vs-absent gate', () => {
  const INT = 600_000 // 10 min

  it('stays quiet when embeddings NEVER succeeded (Ollama absent -- the upstream common case)', () => {
    // never-success -> generateEmbedding already DEBUG-logs; do NOT escalate to WARN.
    expect(shouldWarnEmbedFailure(false, 1_000_000, 0, INT)).toBe(false)
    expect(shouldWarnEmbedFailure(false, 9_999_999, 0, INT)).toBe(false)
  })

  it('WARNs on the first failure after a prior success (= a real outage)', () => {
    expect(shouldWarnEmbedFailure(true, 1_000_000, 0, INT)).toBe(true)
  })

  it('rate-limits repeat outage WARNs within the interval', () => {
    const last = 1_000_000
    expect(shouldWarnEmbedFailure(true, last + INT - 1, last, INT)).toBe(false) // inside window
    expect(shouldWarnEmbedFailure(true, last + INT, last, INT)).toBe(false)     // boundary exclusive
    expect(shouldWarnEmbedFailure(true, last + INT + 1, last, INT)).toBe(true)  // past window
  })
})

// The dream-engine + heartbeats call POST /api/memories/reembed, which 404'd
// (the working backfill lives at /api/memories/backfill). The fix aliases
// reembed to the SAME backfillEmbeddings() -- not a divergent re-implementation.
describe('/api/memories/reembed alias', () => {
  const src = readFileSync(join(__dirname, '../web/routes/memories.ts'), 'utf-8')

  it('handles POST /api/memories/reembed', () => {
    expect(src).toMatch(/\/api\/memories\/reembed/)
  })

  it('shares the existing backfillEmbeddings() handler (alias, not a fork)', () => {
    expect(src).toMatch(/backfillEmbeddings\(\)/)
    // reembed and backfill resolve to one handler block.
    const reembedIdx = src.indexOf('/api/memories/reembed')
    const backfillIdx = src.indexOf('/api/memories/backfill')
    expect(reembedIdx).toBeGreaterThan(0)
    expect(backfillIdx).toBeGreaterThan(0)
  })
})
