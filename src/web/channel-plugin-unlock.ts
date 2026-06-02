// Post-respawn channel-plugin unlock for in-process tmux respawn-pane paths.
//
// scripts/channels.sh already runs an unlock probe after launching the main
// session (see PR #231 / #232): wait for the bun-poller, and if it never
// appears, the plugin is stuck in a Failed/disabled state and a manual
// /mcp + Up + Enter + Enter sequence is the only known revive. That helper
// covers cold launches (launchd start, manual `launchctl kickstart`).
//
// What it does NOT cover: the in-process respawn-pane recovery paths in
// channel-monitor.ts (resumeMarveenSession and respawnMarveenSessionFresh).
// Those call `tmux respawn-pane` directly with the claude command, completely
// bypassing channels.sh - so the post-init unlock never runs. The
// 2026-06-01 18:55 incident demonstrated this end-to-end: the keep-alive
// staleness watchdog fired respawnMarveenSessionFresh at 18:55:09, the new
// session came up cleanly, but the Telegram plugin landed in `◯ disabled`
// (likely a side-effect of a prior unlock-while-already-running cycle
// disabling it) and stayed there because no unlock probe was scheduled.
// The channel was offline for ~6 minutes until manually rescued via /mcp.
//
// This module is the in-process equivalent of the channels.sh probe.
// schedulePluginUnlockAfterRespawn() is fire-and-forget from the JS respawn
// paths; it waits past the cold-start window, gates on a provider-scoped
// liveness check (hasProviderPoller in channel-poller-liveness.ts: no
// matching poller under the claude pid = this provider's plugin is not
// running), and if it needs to act, sends the same /mcp + Up + Enter +
// Enter sequence. The Up wraps to the bottom of the
// MCP server list (where plugin:<provider>:<provider> lives), the first Enter
// opens its action menu, and the second Enter selects whichever first action
// is offered - "Enable" for disabled, "Reconnect" for failed. Both revive
// the plugin; the only failure mode (selecting "View tools" or "Disable" on
// a healthy plugin) is precluded by the bun-absence gate.
//
// Same caveat as channels.sh: while the keystrokes are being delivered the
// session cannot accept other input, but the helper runs in a setTimeout off
// the recovery thread and only fires once per respawn, so the cost is bounded.

import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { type ChannelProviderType, getProvider } from '../channel-provider.js'
import { hasProviderPoller } from './channel-poller-liveness.js'
import { driveMcpPluginAction } from './channel-mcp-reconnect.js'

const TMUX = resolveFromPath('tmux')

// Mirror of scripts/channels.sh post-init grace. The plugin handshake
// (bun spawn + Telegram getMe + sendMessage) usually completes within 15s
// of the claude TUI being interactive. After scheduleIdentitySetup's
// 8s modal-dismiss + 5s /name + a ~1s safety buffer, the prompt is ready
// around T+15s. We wait another 20s on top of that so a healthy plugin
// has time to write its bot.pid and spawn the bun child before we read.
// Total: T+35s post-respawn.
const UNLOCK_PROBE_DELAY_MS = 35_000

// If the bun child still hasn't appeared the first time we look, give it
// one more grace window before we conclude the plugin is wedged. Some
// installs see the bun process appear only after the first inbound poll,
// which can be delayed if Telegram's long-poll happens to be quiet.
const UNLOCK_PROBE_RETRY_DELAY_MS = 15_000
const UNLOCK_PROBE_MAX_RETRIES = 2

function getSessionClaudePid(session: string): number | null {
  try {
    const raw = execFileSync(TMUX, ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      timeout: 3000,
      encoding: 'utf-8',
    }).trim().split('\n')[0]
    const pid = parseInt(raw ?? '', 10)
    return Number.isFinite(pid) && pid > 1 ? pid : null
  } catch (err) {
    logger.warn({ err, session }, 'channel-plugin-unlock: failed to read session claude pid')
    return null
  }
}

// True iff at least one `bun` child is reparented under the claude pid -
// Captured pane lines we use to refuse the keystrokes. Two safety gates:
// (a) the session must be at the bypass-permissions footer (the TUI's idle
// state). If we still see the modal/dialog prompt or the Resume-from-summary
// screen, the unlock keystrokes would land in the wrong context. (b) we
// never send keystrokes if this provider's poller *is* running - that would
// risk toggling the plugin into Disable, the 2026-06-01 18:55 root cause.
// Note: liveness uses hasProviderPoller (provider-specific DFS under the
// claude pid) instead of `pgrep -P <pid> bun`. With two channel plugins
// enabled (e.g. telegram + synology-chat), the bare bun check counted the
// other plugin's bun child as "healthy" and silently skipped unlock for the
// dead provider (telegram-reconnect-loop-fix-2026-06-02).
function isSessionReadyForUnlock(session: string): boolean {
  try {
    const pane = execFileSync(TMUX, ['capture-pane', '-t', session, '-p'], {
      timeout: 3000,
      encoding: 'utf-8',
    })
    // Idle footer: claude renders this footer line once the TUI is ready
    // for input. Matches the empirical signature used by detectPaneState
    // for the 'idle' state.
    if (!/bypass permissions on/.test(pane)) return false
    // Refuse if any modal is visible.
    if (/Resume from summary/.test(pane)) return false
    if (/Open System Settings/.test(pane)) return false
    return true
  } catch (err) {
    logger.warn({ err, session }, 'channel-plugin-unlock: capture-pane failed')
    return false
  }
}

function runUnlock(session: string, provider: ChannelProviderType): void {
  // List-driven navigator (telegram-reconnect-loop-fix-2026-06-02 §9):
  // replaces the blind /mcp + Up + Enter + Enter sequence. The blind Up
  // assumed the channel plugin was bottommost of the server list -- no longer
  // safe with TWO channel plugins enabled (one Up could land on the wrong
  // plugin's row and Enable the wrong service). The shared navigator parses
  // the list and steps the cursor onto the row whose text matches THIS
  // provider's plugin pattern, then activates Reconnect / Enable per status.
  //
  // Gates kept (the §9 plan-review A point): the unlock probe still requires
  // hasProviderPoller(claudePid, provider) === false AND
  // isSessionReadyForUnlock(session) BEFORE the navigator runs (caller
  // verifies both). The navigator itself returns `nav_list` / `capture` and
  // exits safely if the pane is still half-rendered, so a stale TUI cannot
  // drive a wrong row.
  const pluginPaneId = getProvider(provider).pluginPaneId
  const escaped = pluginPaneId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pluginPattern = new RegExp(escaped, 'i')
  const r = driveMcpPluginAction(session, pluginPattern)
  if (!r.ok) {
    logger.warn(
      { session, provider, reason: r.reason, message: r.message },
      'channel-plugin-unlock: navigator declined to act (unlock skipped this cycle)',
    )
    return
  }
  logger.warn({ session, provider }, 'channel-plugin-unlock: list-driven unlock activated via /mcp')
}

interface UnlockProbeState {
  session: string
  provider: ChannelProviderType
  retriesLeft: number
}

function runUnlockProbe(state: UnlockProbeState): void {
  const claudePid = getSessionClaudePid(state.session)
  if (!claudePid) {
    logger.warn({ session: state.session }, 'channel-plugin-unlock: no claude pid; skipping unlock probe')
    return
  }

  if (hasProviderPoller(claudePid, state.provider)) {
    logger.info(
      { session: state.session, claudePid, provider: state.provider },
      'channel-plugin-unlock: provider poller present, plugin healthy - no unlock needed',
    )
    return
  }

  if (!isSessionReadyForUnlock(state.session)) {
    if (state.retriesLeft > 0) {
      logger.info(
        { session: state.session, retriesLeft: state.retriesLeft },
        'channel-plugin-unlock: pane not idle yet, retrying',
      )
      setTimeout(() => runUnlockProbe({ ...state, retriesLeft: state.retriesLeft - 1 }), UNLOCK_PROBE_RETRY_DELAY_MS)
      return
    }
    logger.warn({ session: state.session }, 'channel-plugin-unlock: pane never reached idle state, abandoning')
    return
  }

  logger.warn(
    { session: state.session, claudePid, provider: state.provider },
    'channel-plugin-unlock: provider poller absent after cold-start window, firing /mcp unlock sequence',
  )
  runUnlock(state.session, state.provider)
}

/**
 * Schedule a post-respawn unlock probe for the main channels session.
 *
 * Call this fire-and-forget right after `tmux respawn-pane` in any in-process
 * recovery path (resumeMarveenSession, respawnMarveenSessionFresh, etc.).
 * The probe waits for the new claude session to finish cold-starting, then
 * checks hasProviderPoller(claudePid, provider) -- a DFS under the claude
 * pid for a process whose command matches THIS provider's poller signature
 * (NOT a bare `pgrep -P bun`, which would mistake another channel-plugin's
 * bun child for "this plugin is healthy"):
 *   - provider poller present: plugin healthy, do nothing.
 *   - provider poller absent + idle pane: send /mcp + Up + Enter + Enter to
 *     enable or reconnect whichever channel plugin is at the bottom of
 *     the MCP list.
 *   - provider poller absent + non-idle pane: retry up to UNLOCK_PROBE_MAX_RETRIES
 *     times every UNLOCK_PROBE_RETRY_DELAY_MS before giving up.
 *
 * Idempotent across multiple respawns - each call schedules its own setTimeout
 * and the unlock-keystrokes path is itself gated on poller absence, so a stale
 * probe from a previous respawn cannot toggle a healthy plugin to Disable.
 */
export function schedulePluginUnlockAfterRespawn(session: string, provider: ChannelProviderType): void {
  setTimeout(
    () => runUnlockProbe({ session, provider, retriesLeft: UNLOCK_PROBE_MAX_RETRIES }),
    UNLOCK_PROBE_DELAY_MS,
  )
  logger.info(
    { session, provider, delayMs: UNLOCK_PROBE_DELAY_MS },
    'channel-plugin-unlock: probe scheduled after respawn',
  )
}
