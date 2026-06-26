import { describe, it, expect } from 'vitest'
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
