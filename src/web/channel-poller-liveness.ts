// Provider-specific channel-plugin poller liveness check.
//
// Background: channel-plugin-unlock.ts used to gate the post-respawn /mcp
// revive on `pgrep -P <claudePid> bun` -- ANY bun child counted as "plugin
// healthy". With two channel plugins enabled (e.g. telegram + synology-chat),
// the second plugin's bun child masks the first plugin's death, so the
// unlock probe never fires and recovery loops forever
// (telegram-reconnect-loop-fix-2026-06-02). channel-monitor.ts's
// hasChannelPluginAlive already encodes provider-specific cmd matching, but
// channel-monitor.ts imports channel-plugin-unlock.ts, so the unlock module
// cannot import back without a cycle. This module extracts the provider-
// discrimination logic so both callers agree on what "this provider's
// poller is running under the claude pid" means, without importing each
// other.
//
// What this module deliberately does NOT do:
// - No bot.pid fallback (reparented orphans). The unlock probe wants to know
//   whether the SESSION currently owns a live poller, not whether some
//   poller exists somewhere on the host. channel-monitor.ts's broader
//   liveness check keeps the bot.pid + wider-scan fallbacks for monitor
//   decisions; unlock uses only this narrower DFS check.

import { execFileSync } from 'node:child_process'
import type { ChannelProviderType } from '../channel-provider.js'
// Canonical provider-poller command matcher lives in the channel-coordinator
// (used by its keepalive liveness check); reuse it here so the unlock probe
// and the coordinator agree on what "this provider's poller" looks like,
// rather than carrying a second, drifting copy of the path-boundary rules.
import { matchesProviderPollerCmd } from '../channel-coordinator/provider-poller-match.js'

/** True if there is a process anywhere in the descendant tree of `claudePid`
 * whose command line matches the given provider's poller signature.
 *
 * `pgrep -P <pid> bun` is intentionally NOT used: it would also match a
 * different provider's bun child (synology-chat next to telegram), giving
 * the unlock probe a false "healthy" reading. */
export function hasProviderPoller(claudePid: number, provider: ChannelProviderType): boolean {
  try {
    const ps = execFileSync('/bin/ps', ['-axo', 'pid,ppid,command'], { timeout: 3000, encoding: 'utf-8' })
    const lines = ps.split('\n').slice(1)
    const childrenOf = new Map<number, number[]>()
    const cmdOf = new Map<number, string>()
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const ppid = parseInt(m[2], 10)
      cmdOf.set(pid, m[3])
      const arr = childrenOf.get(ppid) || []
      arr.push(pid)
      childrenOf.set(ppid, arr)
    }
    const stack = [claudePid]
    const seen = new Set<number>()
    while (stack.length) {
      const p = stack.pop()!
      if (seen.has(p)) continue
      seen.add(p)
      const cmd = cmdOf.get(p) || ''
      if (matchesProviderPollerCmd(cmd, provider)) return true
      for (const k of (childrenOf.get(p) || [])) stack.push(k)
    }
    return false
  } catch {
    return false
  }
}
