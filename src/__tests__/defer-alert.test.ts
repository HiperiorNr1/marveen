import { describe, it, expect } from 'vitest'
import { shouldSendDeferAlert, DEFER_ALERT_AFTER_MS } from '../web/defer-alert.js'

// Locks the alert gating: exactly one alert per stuck message, only past the
// age threshold, and never for a plain-busy session (long turns are normal --
// alerting on them would page the operator on every big task).

describe('shouldSendDeferAlert', () => {
  const OLD = DEFER_ALERT_AFTER_MS + 1
  const FRESH = DEFER_ALERT_AFTER_MS - 1

  it('alerts for an old human-deferred message', () => {
    expect(shouldSendDeferAlert(OLD, 'human', false)).toBe(true)
  })

  it('alerts for an old blocked message', () => {
    expect(shouldSendDeferAlert(OLD, 'blocked', false)).toBe(true)
  })

  it('alerts for an old draft-deferred message (only its author can resolve it)', () => {
    expect(shouldSendDeferAlert(OLD, 'draft', false)).toBe(true)
  })

  it('never alerts for a busy session, regardless of age', () => {
    expect(shouldSendDeferAlert(OLD * 100, 'busy', false)).toBe(false)
  })

  it('does not alert before the threshold', () => {
    expect(shouldSendDeferAlert(FRESH, 'human', false)).toBe(false)
  })

  it('threshold is exclusive (exactly at threshold does not alert)', () => {
    expect(shouldSendDeferAlert(DEFER_ALERT_AFTER_MS, 'human', false)).toBe(false)
  })

  it('dedups: never re-alerts an already-sent key', () => {
    expect(shouldSendDeferAlert(OLD, 'human', true)).toBe(false)
    expect(shouldSendDeferAlert(OLD, 'blocked', true)).toBe(false)
  })

  it('honours a custom threshold', () => {
    expect(shouldSendDeferAlert(5_001, 'blocked', false, 5_000)).toBe(true)
    expect(shouldSendDeferAlert(4_999, 'blocked', false, 5_000)).toBe(false)
  })
})
