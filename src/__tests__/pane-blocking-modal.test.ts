import { describe, it, expect } from 'vitest'
import { detectBlockingModal, modalDismissTarget } from '../pane-state.js'

// Locks the proactive modal-unblock contract: the worker loops
// (message-router, schedule-runner, synochat-worker) probe a not-ready pane
// with detectBlockingModal() and dismiss the matching modal. A false null
// re-opens the indefinite delivery stall (13h observed on a routed
// sub-agent); a false positive would fire stray keystrokes into a healthy
// pane, so both directions are pinned here.

const IDLE_PANE = [
  '● Done.',
  '╭──────────────────────────────────────────╮',
  '│ ❯                                        │',
  '╰──────────────────────────────────────────╯',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const BUSY_PANE = [
  '✻ Thinking…',
  '  12.3k tokens · esc to interrupt',
].join('\n')

const SURVEY_PANE = [
  '╭──────────────────────────────────────────╮',
  '│ How is Claude doing this session? (optional)',
  '│ 1: Bad  2: Fine  3: Great  0: Dismiss    │',
  '╰──────────────────────────────────────────╯',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const RESUME_PANE = [
  '╭──────────────────────────────────────────╮',
  '│ Context low. What would you like to do?  │',
  '│ ❯ 1. Resume from summary (recommended)   │',
  '│   2. Continue with truncated context     │',
  '│   3. Start new session                   │',
  '╰──────────────────────────────────────────╯',
  '  Enter to confirm',
].join('\n')

describe('detectBlockingModal', () => {
  it('returns null for an idle pane', () => {
    expect(detectBlockingModal(IDLE_PANE)).toBe(null)
  })

  it('returns null for a busy pane', () => {
    expect(detectBlockingModal(BUSY_PANE)).toBe(null)
  })

  it('returns null for empty / whitespace panes', () => {
    expect(detectBlockingModal('')).toBe(null)
    expect(detectBlockingModal('   \n  ')).toBe(null)
  })

  it('detects the session-rating survey modal', () => {
    expect(detectBlockingModal(SURVEY_PANE)).toBe('survey')
  })

  it('detects the resume-from-summary modal', () => {
    expect(detectBlockingModal(RESUME_PANE)).toBe('resume-summary')
  })

  it('prioritises resume-summary when both markers are present', () => {
    // If the resume picker is live, a survey-dismiss '0' would land in the
    // wrong handler -- resume-summary must win.
    expect(detectBlockingModal(SURVEY_PANE + '\n' + RESUME_PANE)).toBe('resume-summary')
  })
})

describe('modalDismissTarget', () => {
  it('targets a genuine resume modal (marker + unknown pane state)', () => {
    expect(modalDismissTarget(RESUME_PANE)).toBe('resume-summary')
  })

  it('targets a genuine survey modal (marker + idle pane state)', () => {
    expect(modalDismissTarget(SURVEY_PANE)).toBe('survey')
  })

  it('never targets a BUSY pane even when the marker is visible', () => {
    // The review regression: an agent actively working (e.g. discussing this
    // very feature) can have the literal marker phrase in its visible output.
    // Dismissing there would inject 1+Enter into a live turn.
    const busyWithResumeMarker = [
      '● The "Resume from summary" modal blocks delivery, so the worker...',
      '✻ Thinking…',
      '  12.3k tokens · esc to interrupt',
    ].join('\n')
    expect(modalDismissTarget(busyWithResumeMarker)).toBe(null)

    const busyWithSurveyMarker = [
      '● The "How is Claude doing this session" survey swallows keys...',
      '✻ Thinking…',
      '  12.3k tokens · esc to interrupt',
    ].join('\n')
    expect(modalDismissTarget(busyWithSurveyMarker)).toBe(null)
  })

  it('does not target an IDLE pane that merely quotes the resume marker', () => {
    // Idle session whose last output mentions the modal: a dismiss would
    // type "1" + Enter, SUBMITTING "1" as a prompt to the agent.
    const idleWithQuote = [
      '● Done -- the "Resume from summary" modal is now auto-dismissed.',
      '╭──────────────────────────────────────────╮',
      '│ ❯                                        │',
      '╰──────────────────────────────────────────╯',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(modalDismissTarget(idleWithQuote)).toBe(null)
  })

  it('does not target an unknown pane that quotes the survey marker', () => {
    // Survey marker without the idle footer = not a genuine survey surface.
    const unknownWithQuote = [
      'some non-claude output',
      'log: How is Claude doing this session marker seen',
    ].join('\n')
    expect(modalDismissTarget(unknownWithQuote)).toBe(null)
  })
})
