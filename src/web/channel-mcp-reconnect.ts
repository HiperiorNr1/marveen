import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, CHANNEL_PROVIDER } from '../config.js'
import { readAgentChannelProvider } from './agent-config.js'
import { agentSessionName, capturePane } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { getProvider, type ChannelProviderType } from '../channel-provider.js'

const TMUX = resolveFromPath('tmux')
const MAX_UP_ATTEMPTS = 8

// `reason` lets the caller (channel-monitor) distinguish a NAVIGATOR failure
// (`nav_list`/`nav_submenu`/`capture` -- the /mcp menu could not be driven, i.e.
// the recovery mechanism itself is broken) from "drove fine but the plugin
// offered no safe action" (`no_action`). The monitor surfaces the former as a
// visible operator alert so a broken navigator is never masked by a lucky
// poller self-heal.
export type ReconnectFailReason =
  | 'nav_list'
  | 'nav_submenu'
  | 'no_action'
  | 'capture'
  | 'error'

export interface ReconnectResult {
  ok: boolean
  message: string
  reason?: ReconnectFailReason
}

export function resolveAgentSession(agentName: string): string {
  if (agentName === MAIN_AGENT_ID) return MAIN_CHANNELS_SESSION
  return agentSessionName(agentName)
}

export function resolveAgentProviderType(agentName: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(agentName)
  if (perAgent === 'slack' || perAgent === 'telegram') return perAgent
  return CHANNEL_PROVIDER
}

function getPluginPattern(providerType: ChannelProviderType): RegExp {
  const provider = getProvider(providerType)
  const escaped = provider.pluginPaneId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped, 'i')
}

// Max Down presses we'll spend trying to land the cursor on the target
// option inside the plugin submenu.
const SUBMENU_MAX_STEPS = 6
const RECONNECT_RX = /reconnect/i
// Word-anchored so it never matches the "Disable" option (which we must
// never activate). "Disable" contains no "enable" substring anyway, but the
// boundary keeps intent explicit.
const ENABLE_RX = /\benable\b/i
// Plugin-state markers Claude Code renders in the submenu header line
// `Status: <glyph> <word>`. We use the STATUS as authoritative when present,
// because scanning the whole pane for "reconnect"/"enable" is fragile in two
// ways: (a) Claude Code's own footer line ("Use /mcp to reconnect") triggers
// a false RECONNECT match even for disabled plugins; (b) action labels can
// change order across CC versions. Status text is rendered once, plugin-
// header-line, and is the ground truth for what action menu is offered.
//   ✔ connected -> View tools / Reconnect / Disable
//   ✗ failed    -> Reconnect / ...
//   ◯ disabled  -> Enable
// The ◯ vs ○ ambiguity is real (Claude Code has shipped both); match either.
const DISABLED_STATUS_RX = /Status:\s*[◯○]\s*disabled/i
// The failed glyph drifted across Claude Code versions: pre-2.1 shipped `✗`
// (U+2717), 2.1.160 renders `✘` (U+2718, hexdump-confirmed 2026-06-02). Match
// both (plus the ASCII fallbacks) so a glyph bump can't silently un-detect the
// failed state and drop us onto the footer fallback.
const FAILED_STATUS_RX = /Status:\s*[✗✘xX×]\s*failed/i
// Claude Code's TUI marks the selected SUBMENU row with a `❯` cursor on a
// NUMBERED action row (`❯ 1. Reconnect`). A bare `/❯/` is NOT safe: in CC
// 2.1.160 the `/mcp` slash command stays echoed in the input line at the top
// of the captured pane as `❯ /mcp`, so the first `❯` line is the input echo,
// not the menu cursor. Matching only the numbered-row form keeps the input
// echo from shadowing the selection (2026-06-02 reconnect-loop: every step
// returned `❯ /mcp`, target.test never matched -> "could not place cursor on
// target option").
const SUBMENU_CURSOR_RX = /❯\s+\d+\.\s/

/** The numbered submenu row currently marked with the `❯` cursor, or null. */
export function selectedSubmenuLine(pane: string): string | null {
  for (const raw of pane.split('\n')) {
    if (SUBMENU_CURSOR_RX.test(raw)) return raw
  }
  return null
}

// Max Down presses we'll spend walking the /mcp SERVER LIST cursor onto the
// target plugin row. Down wraps around the list, so this is a safety bound,
// not a traversal limit -- the live list is ~7 servers; 16 covers a long list
// with margin.
const LIST_MAX_STEPS = 16
// In the /mcp SERVER LIST, the cursor `❯` marks a server row, and every server
// row carries an inline status separated by a mid-dot ` · ` -- e.g.
// `❯ plugin:telegram:telegram · ✔ connected · 31 tools`, or in the recovery
// states we actually act on, `· ✘ failed` / `· ◯ disabled` (which carry NO
// `N tools` suffix). The `❯ /mcp` input echo and the section headers
// (`User MCPs (...)`, `Built-in MCPs (always available)`, the bare `claude.ai`
// group line) carry no ` · `, so requiring the mid-dot picks the real cursor
// row and is immune to the input-echo shadow (CC 2.1.160).
const LIST_MIDDOT = ' · '

/** The /mcp server-list row currently marked with the `❯` cursor, or null. */
export function selectedListRow(pane: string): string | null {
  for (const raw of pane.split('\n')) {
    if (raw.includes('❯') && raw.includes(LIST_MIDDOT)) return raw
  }
  return null
}

/**
 * Pick which action to drive in the plugin submenu based on what the pane
 * offers. Authoritative source is the `Status: <glyph> <word>` header that
 * Claude Code renders for every plugin in the submenu -- because scanning
 * for the option labels themselves false-positives on CC's own footer text
 * ("Use /mcp to reconnect", etc.) and pulled stage-1 onto Reconnect even
 * for disabled plugins (2026-06-01 20:02 incident: "could not place cursor
 * on target option ... target: reconnect" while the plugin was actually
 * `◯ disabled` and only an Enable row existed).
 *
 *   ◯ disabled -> Enable
 *   ✗ failed   -> Reconnect
 *   ✔ connected -> Reconnect (View tools is safe, Disable is forbidden)
 *
 * Returns null when neither status nor option label is found -- in that
 * case we must NOT press anything, because the remaining option could be
 * "Disable".
 */
export function chooseSubmenuTarget(pane: string): RegExp | null {
  // Status-first: ground truth, immune to footer false-positives.
  if (DISABLED_STATUS_RX.test(pane)) return ENABLE_RX
  if (FAILED_STATUS_RX.test(pane)) return RECONNECT_RX
  // Fallback: status header absent (older CC versions or partial captures).
  // Prefer Reconnect -- if the plugin were truly disabled it would not
  // expose a Reconnect row, so seeing one means we are NOT disabled.
  if (RECONNECT_RX.test(pane)) return RECONNECT_RX
  if (ENABLE_RX.test(pane)) return ENABLE_RX
  return null
}

function send(session: string, ...keys: string[]): void {
  execFileSync(TMUX, ['send-keys', '-t', session, ...keys], { timeout: 3000 })
}

function settle(seconds: string, timeoutMs: number): void {
  execFileSync('/bin/sleep', [seconds], { timeout: timeoutMs })
}

function safeEscape(session: string): void {
  try { send(session, 'Escape') } catch { /* best effort */ }
}

/**
 * Drive the /mcp menu deterministically: read the SERVER LIST, step the
 * cursor onto the row whose text matches `pluginPattern` (case-insensitive),
 * then enter and activate the safe action (Reconnect / Enable, status-first
 * per chooseSubmenuTarget). Replaces the previous blind Up-walk finder
 * (telegram-reconnect-loop-fix-2026-06-02 §9): with multiple MCP servers in
 * the list and two channel plugins enabled, the blind algorithm could not
 * reliably land on telegram and logged "plugin submenu not found".
 *
 * Down-stepping wraps the list cursor, so the start position does not
 * matter; LIST_MAX_STEPS is a safety bound. The submenu stage reuses the
 * existing chooseSubmenuTarget / SUBMENU_CURSOR_RX logic from §8 (CC 2.1.160
 * numbered-row + ✘ glyph).
 *
 * Returns a structured `reason` on failure so the monitor can distinguish a
 * broken navigator (nav_list / nav_submenu / capture -- the menu could not be
 * driven, i.e. the recovery mechanism itself is broken) from "drove fine but
 * the plugin offered no safe action" (no_action). The monitor surfaces the
 * former as a visible operator alert (channel-monitor handleMarveenDown) so
 * a broken navigator is never masked by a lucky poller self-heal.
 */
export function driveMcpPluginAction(
  session: string,
  pluginPattern: RegExp,
): ReconnectResult {
  try {
    // Dismiss any modal/input residue, then open /mcp.
    send(session, 'Escape'); settle('1', 2000)
    send(session, '/mcp', 'Enter'); settle('1', 3000)

    const listPane = capturePane(session)
    if (!listPane) {
      safeEscape(session)
      return { ok: false, reason: 'capture', message: 'Failed to capture pane after /mcp' }
    }

    // List-driven step-and-verify: walk the cursor onto the target server
    // row by re-reading the LIST cursor after each Down. The list cursor
    // marks a server row (selectedListRow requires the ` · ` separator),
    // immune to the `❯ /mcp` input-echo shadow and the section-header lines
    // (`User MCPs (...)`, `Built-in MCPs (always available)`, the bare
    // `claude.ai` group). Down wraps the list, so a sufficiently large step
    // budget always finds a present row regardless of start position.
    let listPaneState = listPane
    let landedRow: string | null = null
    for (let step = 0; step <= LIST_MAX_STEPS; step++) {
      const sel = selectedListRow(listPaneState)
      if (sel && pluginPattern.test(sel)) {
        landedRow = sel
        break
      }
      send(session, 'Down'); settle('0.25', 1000)
      listPaneState = capturePane(session) ?? listPaneState
    }

    if (!landedRow) {
      logger.warn(
        { session, pluginPattern: pluginPattern.source, maxSteps: LIST_MAX_STEPS },
        'channel-mcp-reconnect: plugin row not found in /mcp list',
      )
      safeEscape(session); settle('0.5', 1000); safeEscape(session)
      return {
        ok: false,
        reason: 'nav_list',
        message: `Plugin row ${pluginPattern.source} not found within ${LIST_MAX_STEPS} Down steps`,
      }
    }

    // Open the submenu for the located plugin row.
    send(session, 'Enter'); settle('1', 3000)

    let submenu = capturePane(session)
    if (!submenu) {
      safeEscape(session); settle('0.5', 1000); safeEscape(session)
      return { ok: false, reason: 'capture', message: 'Failed to capture submenu pane' }
    }

    const target = chooseSubmenuTarget(submenu)
    if (!target) {
      logger.warn({ session }, 'channel-mcp-reconnect: no Reconnect/Enable option in submenu')
      safeEscape(session); settle('0.5', 1000); safeEscape(session)
      return { ok: false, reason: 'no_action', message: 'No Reconnect/Enable option in submenu' }
    }

    let onTarget = false
    for (let step = 0; step <= SUBMENU_MAX_STEPS; step++) {
      const sel = selectedSubmenuLine(submenu)
      if (sel && target.test(sel)) { onTarget = true; break }
      send(session, 'Down'); settle('0.3', 1000)
      submenu = capturePane(session) ?? submenu
    }

    if (!onTarget) {
      logger.warn(
        { session, target: target.source, maxSteps: SUBMENU_MAX_STEPS },
        'channel-mcp-reconnect: could not place cursor on target option',
      )
      safeEscape(session); settle('0.5', 1000); safeEscape(session)
      return {
        ok: false,
        reason: 'nav_submenu',
        message: `Could not select ${target.source} within ${SUBMENU_MAX_STEPS} steps`,
      }
    }

    // Activate, then back the pane out to idle (two Escapes: action menu ->
    // server list -> prompt). Without the second Escape detectPaneState stays
    // non-idle and inter-agent / scheduled traffic piles up (2026-06-01 19:25
    // incident, mirror of the unlock.ts comment).
    send(session, 'Enter'); settle('2', 4000)
    safeEscape(session); settle('0.5', 1000); safeEscape(session)

    const action = target === RECONNECT_RX ? 'Reconnect' : 'Enable'
    logger.info(
      { session, action, row: landedRow.trim() },
      'channel-mcp-reconnect: completed',
    )
    return { ok: true, message: `Activated ${action} via /mcp` }
  } catch (err) {
    logger.warn({ err, session }, 'channel-mcp-reconnect failed')
    safeEscape(session)
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Reconnect a channel MCP plugin in the named agent's tmux session by driving
 * the /mcp menu. Thin wrapper around driveMcpPluginAction that resolves the
 * agent's session, provider, and plugin pattern.
 */
export function attemptChannelMcpReconnect(agentName: string): ReconnectResult {
  const session = resolveAgentSession(agentName)
  const providerType = resolveAgentProviderType(agentName)
  const pluginPattern = getPluginPattern(providerType)
  const r = driveMcpPluginAction(session, pluginPattern)
  if (r.ok) {
    logger.info({ agentName, provider: providerType }, 'channel-mcp-reconnect: agent reconnect ok')
  }
  return r
}
