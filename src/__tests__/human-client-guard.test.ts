import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldDeferForHumanClient } from '../pane-state.js'

// Locks the interference-guard semantics: injection defers ONLY when an
// attached tmux client showed input activity inside the window. Passive
// attachment (operator watching a pane for hours) must NOT defer, otherwise
// every delivery starves -- the exact stall the modal-unblock fix removes.

const NOW = 1_780_000_000
const WINDOW_S = 120

describe('shouldDeferForHumanClient', () => {
  it('does not defer when no client is attached', () => {
    expect(shouldDeferForHumanClient([], NOW, WINDOW_S)).toBe(false)
  })

  it('defers on fresh activity inside the window', () => {
    expect(shouldDeferForHumanClient([NOW - 5], NOW, WINDOW_S)).toBe(true)
  })

  it('does not defer on stale activity (attached but only watching)', () => {
    expect(shouldDeferForHumanClient([NOW - 3600], NOW, WINDOW_S)).toBe(false)
  })

  it('treats the window boundary as still active', () => {
    expect(shouldDeferForHumanClient([NOW - WINDOW_S], NOW, WINDOW_S)).toBe(true)
    expect(shouldDeferForHumanClient([NOW - WINDOW_S - 1], NOW, WINDOW_S)).toBe(false)
  })

  it('defers if ANY of several clients is active', () => {
    expect(shouldDeferForHumanClient([NOW - 3600, NOW - 10], NOW, WINDOW_S)).toBe(true)
  })

  it('ignores non-finite parse garbage', () => {
    expect(shouldDeferForHumanClient([NaN, Infinity * -1], NOW, WINDOW_S)).toBe(false)
  })

  it('window=Infinity degrades to attached-only semantics', () => {
    expect(shouldDeferForHumanClient([NOW - 999_999], NOW, Infinity)).toBe(true)
    expect(shouldDeferForHumanClient([], NOW, Infinity)).toBe(false)
  })
})

// The blocking-menu Escape recovery (channel-monitor) adopts upstream's generic
// detectsBlockingMenu detector (#363), which sees a /mcp picker the same whether
// a human or a wedge parked it. The recovery Escape MUST be human-gated -- an
// un-gated Escape cancels a human's live menu selection (the 2026-06-15 hazard:
// "upstream's Escape pass has NO human-guard"). Lock the guard in source so a
// refactor cannot silently re-open it.
describe('blocking-menu Escape recovery is human-gated (channel-monitor)', () => {
  const src = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
  it('feeds humanClientActive into the menu-recovery gate (Escape never fires while a human navigates)', () => {
    expect(src).toMatch(/detectsBlockingMenu\(pane\)/)
    expect(src).toMatch(/inMenu && !humanClientActive\(/)
  })
  it('does not pass the bare inMenu flag to the menu-recovery alert gate (the pre-fix hazard shape)', () => {
    expect(src).not.toMatch(/decidePaneErrorAlert\(inMenu,/)
  })
})
