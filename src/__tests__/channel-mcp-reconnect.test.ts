import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFileSync = vi.fn()
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execSync: vi.fn(),
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => `/usr/local/bin/${name}`,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  CHANNEL_PROVIDER: 'telegram',
  PROJECT_ROOT: '/tmp/test-claudeclaw',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentChannelProvider: (name: string) => name === 'slacker' ? 'slack' : '',
  AGENTS_BASE_DIR: '/tmp/test-claudeclaw/agents',
}))

const mockCapturePane = vi.fn<(session: string) => string | null>()
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  capturePane: (session: string) => mockCapturePane(session),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: (type: string) => ({
    pluginId: type === 'slack'
      ? 'slack-channel@marveen-marketplace'
      : 'telegram@claude-plugins-official',
    pluginPaneId: type === 'slack'
      ? 'plugin:slack-channel:marveen-marketplace'
      : 'plugin:telegram:telegram',
  }),
}))

import {
  attemptChannelMcpReconnect,
  resolveAgentSession,
  resolveAgentProviderType,
  selectedListRow,
  selectedSubmenuLine,
  chooseSubmenuTarget,
} from '../web/channel-mcp-reconnect.js'

// Submenu panes Claude Code 2.1.160 renders for each plugin state, captured
// verbatim from a live TUI (hexdump-confirmed glyphs: connected ✔ U+2714,
// failed ✘ U+2718, disabled ◯ U+25EF). Two things the OLD fixtures missed and
// which silently regressed the navigator (2026-06-02 reconnect-loop):
//   1. The `/mcp` slash command stays echoed in the INPUT line at the top of
//      the pane as `❯ /mcp` -- a leading `❯` that is NOT the menu cursor.
//   2. Action rows are NUMBERED (`1. Reconnect`), and the cursor `❯` sits on
//      a numbered row.
// The menu cursor must be read from the numbered row, never the input echo.
const SUBMENU_CONNECTED_TOP = [
  '❯ /mcp',
  '────────────────────────────────',
  '  Telegram MCP Server',
  '  Status:           ✔ connected',
  '  Command:          bun run --cwd /path/telegram',
  '  ❯ 1. View tools',
  '    2. Reconnect',
  '    3. Disable',
  '  ↑/↓ to navigate · Enter to select · Esc to back',
].join('\n')
const SUBMENU_CONNECTED_ON_RECONNECT = [
  '❯ /mcp',
  '────────────────────────────────',
  '  Telegram MCP Server',
  '  Status:           ✔ connected',
  '    1. View tools',
  '  ❯ 2. Reconnect',
  '    3. Disable',
  '  ↑/↓ to navigate · Enter to select · Esc to back',
].join('\n')
const SUBMENU_FAILED_TOP = [
  '❯ /mcp',
  '────────────────────────────────',
  '  Telegram MCP Server',
  '  Status:           ✘ failed',
  '  Command:          bun run --cwd /path/telegram',
  '  ❯ 1. Reconnect',
  '    2. Disable',
  '  ↑/↓ to navigate · Enter to select · Esc to back',
].join('\n')
const SUBMENU_DISABLED_TOP = [
  '❯ /mcp',
  '────────────────────────────────',
  '  Telegram MCP Server',
  '  Status:           ◯ disabled',
  '  ❯ 1. Enable',
  '  ↑/↓ to navigate · Enter to select · Esc to back',
].join('\n')

describe('resolveAgentSession', () => {
  it('returns main channels session for main agent', () => {
    expect(resolveAgentSession('marveen')).toBe('marveen-channels')
  })

  it('returns agent-NAME for sub-agents', () => {
    expect(resolveAgentSession('samu')).toBe('agent-samu')
    expect(resolveAgentSession('zara')).toBe('agent-zara')
  })
})

describe('resolveAgentProviderType', () => {
  it('returns configured provider for agent with explicit config', () => {
    expect(resolveAgentProviderType('slacker')).toBe('slack')
  })

  it('falls back to CHANNEL_PROVIDER for unconfigured agents', () => {
    expect(resolveAgentProviderType('samu')).toBe('telegram')
  })
})

describe('selectedSubmenuLine', () => {
  it('returns the numbered row marked with the cursor', () => {
    expect(selectedSubmenuLine(SUBMENU_CONNECTED_TOP)).toBe('  ❯ 1. View tools')
    expect(selectedSubmenuLine(SUBMENU_FAILED_TOP)).toBe('  ❯ 1. Reconnect')
    expect(selectedSubmenuLine(SUBMENU_CONNECTED_ON_RECONNECT)).toBe('  ❯ 2. Reconnect')
  })

  it('returns null when no cursor is present', () => {
    expect(selectedSubmenuLine('  View tools\n  Reconnect')).toBeNull()
  })

  // REGRESSION (2026-06-02 reconnect-loop, CC 2.1.160): the `❯ /mcp` input
  // echo at the top of the pane must NOT be mistaken for the menu cursor. A
  // bare `/❯/` returned that line every time, so target.test() never matched
  // the action row and we logged "could not place cursor on target option".
  it('ignores the "❯ /mcp" input-echo line and returns the numbered menu row', () => {
    const pane = [
      '❯ /mcp',
      '  Telegram MCP Server',
      '  Status:           ✘ failed',
      '  ❯ 1. Reconnect',
      '    2. Disable',
    ].join('\n')
    expect(selectedSubmenuLine(pane)).toBe('  ❯ 1. Reconnect')
  })

  it('returns null when only the input echo carries a cursor (no numbered row)', () => {
    expect(selectedSubmenuLine('❯ /mcp\n  Telegram MCP Server')).toBeNull()
  })
})

describe('chooseSubmenuTarget', () => {
  it('prefers Reconnect when present', () => {
    expect(chooseSubmenuTarget(SUBMENU_CONNECTED_TOP)?.source).toBe('reconnect')
    expect(chooseSubmenuTarget(SUBMENU_FAILED_TOP)?.source).toBe('reconnect')
  })

  it('falls back to Enable in the disabled state', () => {
    const t = chooseSubmenuTarget(SUBMENU_DISABLED_TOP)
    expect(t?.test('❯ Enable')).toBe(true)
    expect(t?.source).not.toBe('reconnect')
  })

  it('never targets Disable when no Reconnect/Enable exists', () => {
    expect(chooseSubmenuTarget('plugin:x\n❯ View tools\n  Disable')).toBeNull()
  })

  it('does not mistake "Disable" for an Enable target', () => {
    // \benable\b must not match the "Disable" row.
    expect(chooseSubmenuTarget('plugin:x\n❯ View tools\n  Disable')).toBeNull()
  })

  it('uses status header as ground truth: disabled status -> Enable even if pane contains the word "reconnect"', () => {
    // 2026-06-01 20:02 incident: stage 1 logged
    //   "could not place cursor on target option ... target: reconnect"
    // while the plugin was actually `◯ disabled`. Cause was a stray
    // "reconnect" substring elsewhere in the pane (Claude Code's own
    // footer / scrollback). Status header is now authoritative.
    const paneWithDisabledStatusAndFooterText = [
      'Plugin:telegram:telegram MCP Server',
      '',
      'Status:           ◯ disabled',
      '',
      '❯ 1. Enable',
      '',
      '↑/↓ to navigate · Enter to select · Esc to back',
      '※ Run claude --debug to see error logs / use /mcp to reconnect',
    ].join('\n')
    const t = chooseSubmenuTarget(paneWithDisabledStatusAndFooterText)
    expect(t?.test('Enable')).toBe(true)
    expect(t?.source).not.toBe('reconnect')
  })

  it('uses status header: failed status -> Reconnect', () => {
    const failedPane = [
      'Plugin:telegram:telegram MCP Server',
      'Status:           ✗ failed',
      '❯ 1. Reconnect',
    ].join('\n')
    expect(chooseSubmenuTarget(failedPane)?.source).toBe('reconnect')
  })

  it('detects the CC 2.1.160 failed glyph ✘ (U+2718) via the status header, not a label fallback', () => {
    // The pane carries NO "reconnect" label text, so the only path that can
    // return RECONNECT_RX is the Status header. This isolates the glyph match:
    // with the old `[✗x×]` class the ✘ (U+2718) would miss and this returns
    // null (2026-06-02 glyph drift).
    const pane = [
      '  Telegram MCP Server',
      '  Status:           ✘ failed',
      '  ❯ 1. Restart',
    ].join('\n')
    expect(chooseSubmenuTarget(pane)?.source).toBe('reconnect')
  })

  it('handles the ◯/○ glyph variants Claude Code has shipped', () => {
    const withHollow = 'Status: ○ disabled\n❯ Enable'
    const withCircled = 'Status: ◯ disabled\n❯ Enable'
    expect(chooseSubmenuTarget(withHollow)?.source).toBe(ENABLE_RX.source)
    expect(chooseSubmenuTarget(withCircled)?.source).toBe(ENABLE_RX.source)
  })
})

// Re-export the regex for the glyph-variant test (defined in helper file)
const ENABLE_RX = /\benable\b/i

// Live-shape /mcp server LIST as CC 2.1.160 renders it: top input echo
// `❯ /mcp`, then ~7 entries grouped by section header lines. Headers
// (`User MCPs (...)`, the bare `claude.ai` group, `Built-in MCPs (always
// available)`) have NO mid-dot separator; server rows do. The cursor here is
// on `plugin:telegram:telegram`, marked FAILED so the row has NO `N tools`
// suffix -- the EFiveen review point (B): recovery operates on disabled/
// failed rows, the matcher MUST pick those up too.
function listPaneCursorOn(idx: number): string {
  const rows = [
    '  User MCPs (/home/efi/.claude.json)',
    '  obsidian-memory · ✔ connected · 15 tools',
    '  claude.ai',
    '  claude.ai Gmail · △ needs authentication',
    '  claude.ai Google Calendar · ✔ connected · 8 tools',
    '  Built-in MCPs (always available)',
    '  plugin:telegram:telegram · ✘ failed',                 // no "N tools" suffix
    '  plugin:slack-channel:marveen-marketplace · ◯ disabled', // no "N tools" suffix
  ]
  // Mark the row at idx with the cursor (replace the leading two spaces with `❯ `).
  rows[idx] = rows[idx]!.replace(/^  /, '❯ ')
  return [
    '❯ /mcp',
    '─────────────────────────',
    '  Manage MCP servers',
    '  8 servers',
    ...rows,
    ' ↑/↓ to navigate · Enter to confirm · Esc to cancel',
  ].join('\n')
}

const TELEGRAM_ROW_IDX = 6   // index in the `rows` array above (FAILED telegram)
const SLACK_ROW_IDX = 7      // DISABLED slack
const TOP_ROW_IDX = 1        // obsidian-memory (where the cursor would land first)

describe('selectedListRow', () => {
  it('returns the server row marked with the cursor (has mid-dot separator)', () => {
    const pane = listPaneCursorOn(TELEGRAM_ROW_IDX)
    const row = selectedListRow(pane)
    expect(row).not.toBeNull()
    expect(row).toContain('plugin:telegram:telegram')
    expect(row).toContain(' · ')
  })

  it('also picks up the cursor on a DISABLED row (no "N tools" suffix)', () => {
    // EFiveen review point B: recovery targets disabled rows too.
    const pane = listPaneCursorOn(SLACK_ROW_IDX)
    const row = selectedListRow(pane)
    expect(row).toContain('plugin:slack-channel:marveen-marketplace')
    expect(row).toContain('◯ disabled')
    expect(row).not.toContain('tools')
  })

  it('also picks up the cursor on a FAILED row (no "N tools" suffix)', () => {
    // EFiveen review point B: recovery targets failed rows too.
    const pane = listPaneCursorOn(TELEGRAM_ROW_IDX)
    const row = selectedListRow(pane)
    expect(row).toContain('✘ failed')
    expect(row).not.toContain('tools')
  })

  it('ignores the "❯ /mcp" input-echo line (no mid-dot) AND section headers', () => {
    // The `❯ /mcp` echo carries a `❯` but NO ` · `, so it can't shadow the
    // real cursor row -- this is the immunity the §9 navigator depends on.
    // Same for the section headers (`User MCPs`, bare `claude.ai`,
    // `Built-in MCPs`): they have a leading `❯`-less indentation and no
    // mid-dot, so they're not selectable cursor rows.
    const pane = listPaneCursorOn(TELEGRAM_ROW_IDX)
    const row = selectedListRow(pane)
    expect(row).not.toContain('/mcp')
    expect(row).not.toContain('User MCPs')
    expect(row).not.toContain('Built-in')
  })

  it('returns null when no row is selected', () => {
    expect(selectedListRow('  Manage MCP servers\n  no cursor here\n')).toBeNull()
  })
})

describe('attemptChannelMcpReconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The new navigator captures the LIST after every Down. Helper to queue the
  // step-and-verify sequence: start cursor at `from`, end at `to`, then the
  // submenu pane after Enter.
  function queueListWalk(from: number, to: number, submenu: string): void {
    // The first capture is the initial LIST pane.
    mockCapturePane.mockReturnValueOnce(listPaneCursorOn(from))
    if (from !== to) {
      // Step through intermediate rows (Down moves cursor by 1, no wrap needed
      // for a short walk in these tests).
      const dir = from < to ? 1 : -1
      for (let i = from + dir; (dir > 0 ? i <= to : i >= to); i += dir) {
        mockCapturePane.mockReturnValueOnce(listPaneCursorOn(i))
      }
    }
    mockCapturePane.mockReturnValueOnce(submenu) // submenu capture after Enter
  }

  it('failed state: walks the list onto plugin:telegram:telegram, activates Reconnect (already selected, no submenu Down)', () => {
    queueListWalk(TOP_ROW_IDX, TELEGRAM_ROW_IDX, SUBMENU_FAILED_TOP)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
    // Regression guard from §8: the old code blindly pressed Down inside the
    // submenu and could land on "Disable". In the failed state, the cursor
    // is already on row 1, so NO Down is needed after entering the submenu.
    // The list-walk Downs are sent before Enter (=open submenu); after Enter
    // there should be NO Down. We check this by counting Downs sent AFTER
    // the first Enter (which opens the submenu).
    const calls = mockExecFileSync.mock.calls
    const firstEnterIdx = calls.findIndex(
      (c) => Array.isArray(c[1]) && c[1][0] === 'send-keys' && c[1].includes('Enter') && !c[1].includes('/mcp'),
    )
    const downsAfterFirstEnter = calls.slice(firstEnterIdx + 1).filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downsAfterFirstEnter.length).toBe(0)
  })

  it('connected state: walks the list, then steps Down inside the submenu onto Reconnect', () => {
    // Mock a CONNECTED telegram row instead of the default FAILED one.
    const connectedListRows = [
      '❯ /mcp',
      '  Manage MCP servers',
      '❯ plugin:telegram:telegram · ✔ connected · 6 tools',
    ].join('\n')
    mockCapturePane
      .mockReturnValueOnce(connectedListRows)        // list: cursor already on telegram row
      .mockReturnValueOnce(SUBMENU_CONNECTED_TOP)    // submenu: cursor on View tools (row 1)
      .mockReturnValueOnce(SUBMENU_CONNECTED_ON_RECONNECT) // after 1x Down: cursor on Reconnect

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
  })

  it('disabled state: activates Enable on row 1', () => {
    // Default fixture has slack as the disabled row; rewire to put telegram
    // in the disabled state by mocking a custom list pane.
    const disabledList = [
      '❯ /mcp',
      '  Manage MCP servers',
      '❯ plugin:telegram:telegram · ◯ disabled',
    ].join('\n')
    mockCapturePane
      .mockReturnValueOnce(disabledList)
      .mockReturnValueOnce(SUBMENU_DISABLED_TOP)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Enable')
  })

  it('returns reason="no_action" when the submenu offers no Reconnect/Enable', () => {
    // Status header absent AND no Reconnect/Enable label -- e.g. an
    // unrecognized submenu state. chooseSubmenuTarget returns null.
    queueListWalk(TOP_ROW_IDX, TELEGRAM_ROW_IDX, 'Plugin:telegram:telegram MCP Server\n  ❯ 1. View tools\n    2. Disable')

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no_action')
    expect(result.message).toContain('No Reconnect/Enable')
  })

  it('returns reason="capture" when capture fails after /mcp', () => {
    mockCapturePane.mockReturnValueOnce(null)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('capture')
    expect(result.message).toContain('capture')
  })

  it('returns reason="nav_list" with telegram pattern when no row matches within LIST_MAX_STEPS', () => {
    // 17 captures (initial + 16 Down steps), none containing the telegram row.
    for (let i = 0; i < 18; i++) {
      mockCapturePane.mockReturnValueOnce(
        '  Manage MCP servers\n❯ obsidian-memory · ✔ connected · 15 tools\n  some-other · ✔ connected',
      )
    }

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('nav_list')
    expect(result.message).toContain('telegram')
  })

  it('uses correct session for sub-agents', () => {
    // List pane with the slack plugin row marked under the cursor.
    const slackList = [
      '❯ /mcp',
      '  Manage MCP servers',
      '❯ plugin:slack-channel:marveen-marketplace · ✘ failed',
    ].join('\n')
    const slackSubmenu = [
      '  Plugin:slack-channel:marveen-marketplace MCP Server',
      '  Status:           ✘ failed',
      '  ❯ 1. Reconnect',
    ].join('\n')
    mockCapturePane
      .mockReturnValueOnce(slackList)
      .mockReturnValueOnce(slackSubmenu)

    attemptChannelMcpReconnect('slacker')

    // Intent: sub-agent session routing -> the keystrokes target the
    // `agent-slacker` tmux session. Assert on the args, not the absolute tmux
    // path (resolveFromPath returns the real binary location, which varies by
    // host -- /usr/bin/tmux here, /usr/local/bin/tmux elsewhere).
    const slackerSendKeys = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1][0] === 'send-keys' && c[1][2] === 'agent-slacker',
    )
    expect(slackerSendKeys.length).toBeGreaterThan(0)
  })

  it('sends Escape on error to clean up menu state', () => {
    mockExecFileSync.mockImplementationOnce(() => { /* Escape */ })
    mockExecFileSync.mockImplementationOnce(() => { /* sleep */ })
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('tmux dead') })

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    const escapeCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Escape'),
    )
    expect(escapeCalls.length).toBeGreaterThan(0)
  })
})
