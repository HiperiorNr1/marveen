import { describe, it, expect } from 'vitest'
import {
  detectPaneState,
  shouldRetrySubmit,
  shouldClearTruncatedPreamble,
} from '../pane-state.js'

// Regression suite for the footer-anchoring bug behind the 2026-06-11
// draft-merge incident (operator draft "111..." submitted together with a
// routed message).
//
// detectPaneState's typing branch and liveInputBox located the idle footer
// with findIndex -- the FIRST matching line from the TOP of the pane. When
// the visible scrollback QUOTES the footer phrase (watchdog reports, code
// reviews, displayed test fixtures -- exactly what agent workloads print),
// the box scan anchors on the quoted line, misses the live input box at the
// bottom, and a parked human draft becomes invisible: 'idle' instead of
// 'typing', so the router delivers ON TOP of the draft and the trailing
// Enter submits both. detectsThinkingBlockError already anchors the footer
// from the BOTTOM for this exact reason (pane-state.ts comment, guard (a));
// these tests pin the same rule for the box-based detectors.

const SEP = '─'.repeat(60)
const IDLE_FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

// The poison: a line in scrollback that QUOTES the footer phrase, exactly
// like a displayed test fixture or a pasted code review would.
const QUOTED_FOOTER_LINE = "    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',"

const DRAFT_BEHIND_QUOTED_FOOTER = [
  '● Here is the test fixture I wrote:',
  QUOTED_FOOTER_LINE,
  '  (end of fixture output)',
  SEP,
  '❯ 11111111111111111111111111111111111111111111111',
  SEP,
  IDLE_FOOTER,
].join('\n')

const EMPTY_BOX_BEHIND_QUOTED_FOOTER = [
  '● Here is the test fixture I wrote:',
  QUOTED_FOOTER_LINE,
  '  (end of fixture output)',
  SEP,
  '❯ ',
  SEP,
  IDLE_FOOTER,
].join('\n')

const PASTE_STUB_BEHIND_QUOTED_FOOTER = [
  '● Here is the test fixture I wrote:',
  QUOTED_FOOTER_LINE,
  SEP,
  '❯ [Pasted text #1 +120 chars]',
  SEP,
  IDLE_FOOTER,
].join('\n')

const STALE_PREAMBLE_BEHIND_QUOTED_FOOTER = [
  '● Watchdog report quoting the footer:',
  QUOTED_FOOTER_LINE,
  SEP,
  '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> block is',
  SEP,
  IDLE_FOOTER,
].join('\n')

describe('footer bottom-anchoring (quoted-footer regression)', () => {
  it('detects a parked draft even when scrollback quotes the footer phrase', () => {
    // THE incident shape: operator draft in the live box, quoted footer
    // above. Pre-fix this returned 'idle' and the router merged a routed
    // message into the draft.
    expect(detectPaneState(DRAFT_BEHIND_QUOTED_FOOTER)).toBe('typing')
  })

  it('still reports idle for an EMPTY live box behind a quoted footer', () => {
    expect(detectPaneState(EMPTY_BOX_BEHIND_QUOTED_FOOTER)).toBe('idle')
  })

  it('shouldRetrySubmit sees a paste stub in the live box behind a quoted footer', () => {
    expect(shouldRetrySubmit(PASTE_STUB_BEHIND_QUOTED_FOOTER, '')).toBe(true)
  })

  it('shouldClearTruncatedPreamble sees a stale preamble behind a quoted footer', () => {
    expect(shouldClearTruncatedPreamble(STALE_PREAMBLE_BEHIND_QUOTED_FOOTER)).toBe(true)
  })

  it('control: the same draft WITHOUT a quoted footer is already typing', () => {
    const clean = [
      '● Some ordinary output.',
      SEP,
      '❯ 11111111111111111111111111111111111111111111111',
      SEP,
      IDLE_FOOTER,
    ].join('\n')
    expect(detectPaneState(clean)).toBe('typing')
  })
})
