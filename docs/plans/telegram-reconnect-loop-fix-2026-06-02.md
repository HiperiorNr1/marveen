# Telegram reconnect-loop fix — implementation plan

Author: EFiveen · 2026-06-02 · for: Dev (review-then-implement)
Kanban: tg-reconnect-2026 · Priority: high

> Handoff mode: this is EFiveen's plan. **Dev reviews it critically FIRST.**
> If sound → implement. If you disagree on any decision point below, flag back
> to EFiveen (reviewer) before coding. Upstream-affecting → see §5.

## 1. Symptom

EFiveen (main `efiveen-channels`) Telegram channel drops and the recovery
cascade never recovers it: `soft → save → resume → hard → gave_up`, looping
for hours. Operator-visible alert: *"Session resume nem segitett. Hard restart
(systemctl) most a efiveen-channels session-on..."* (channel-monitor.ts:709).
Reported to recur on a second deployment (home "Marvin", older Claude Code, no
synology-chat) → not a Claude Code regression.

## 2. Evidence (2026-06-02, this host)

- `store/dashboard.log` 09:49–13:24: continuous hard-restart loop, twice
  `gave_up` (10:11, 13:18).
- After EVERY respawn: `channel-plugin-unlock: bun child present, plugin
  healthy - no unlock needed` — the false positive (see §3, Fix 1).
- Live process tree: main session (`efiveen-channels`, claude pid) has **no
  telegram bun poller** child, only a `synology-chat` bun child. Dev's session
  (`agent-dev`) has a healthy telegram poller on a *different* token/state dir.
- No `409 Conflict` logged in the current cycle → not active token contention
  right now; the cascade is stuck because the dead telegram plugin is never
  revived.
- Main telegram state lives at `~/.claude/channels/telegram/` (plugin DEFAULT),
  intact (.env/access.json/approved/inbox, since May 12).
  `<INSTALL_DIR>/.claude/channels/telegram` does **not** exist.
- `.claude/settings.json` enabledPlugins: `telegram=true`, **`synology-chat=true`
  (added today, commit 191d957, 11:27)** → two bun pollers under the main session.

## 3. Root causes (three layers)

### Layer A — RECOVERY BLOCKER (acute, this host): unlock probe is bun-agnostic
`src/web/channel-plugin-unlock.ts` `hasBunChild()` (lines 89–100) gates the
post-respawn `/mcp` revive on `pgrep -P <claudePid> bun` — ANY bun child counts
as "plugin healthy". Since synology-chat was enabled, the main session always
has a bun child, so `runUnlockProbe` (lines 178–184) always logs *"bun child
present, plugin healthy - no unlock needed"* and NEVER sends the `/mcp + Up +
Enter + Enter` sequence that revives a Failed/disabled telegram plugin (#231/#232).
Meanwhile the monitor's `hasChannelPluginAlive()` (channel-monitor.ts:74–169) IS
provider-specific (telegram match at 98–100), correctly reports telegram down,
and escalates the cascade forever. The two liveness checks disagree.

`scripts/channels.sh` post-init unlock uses the same bun-agnostic `pgrep -P bun`
→ same blind spot on cold launch.

### Layer B — STALE-POLLER EVICTION targets the wrong dir for the main agent
- `respawnMarveenSessionFresh()` (channel-monitor.ts:407–432, the Linux
  hard-restart path) does **not** call `reapChannelOrphans()` at all, unlike
  `resumeMarveenSession()` (line 292). So a hard restart never evicts a
  contending poller.
- Worse, even where reap runs, `reapChannelOrphans(telegram, PROJECT_ROOT)`
  resolves `channelStateDir(telegram, PROJECT_ROOT)` =
  `<INSTALL_DIR>/.claude/channels/telegram`, and scans `ps eww` for
  `TELEGRAM_STATE_DIR=<that dir>`. But the main poller has **no
  `TELEGRAM_STATE_DIR` env at all** (it uses the plugin default
  `~/.claude/channels/telegram`). So the env-scan matches nothing and the
  real main orphan is never reaped. `channels.sh` MAIN_CHAN_DIR (line 108)
  has the identical mismatch.
- `buildMainSessionRespawnCmd()` (channel-monitor.ts:265–281) launches claude
  with no `TELEGRAM_STATE_DIR` export → the inconsistency is structural.

### Layer C — TRIGGER: sub-agent poller steal (still firing despite #237/#247)
Heartbeat/scheduled SDK sub-agents inherit the user-scope `enabledPlugins` map,
spawn their own telegram poller against the SAME default state dir/token →
409 → main poller dies. #237 (cwd isolation) + #247 (project-scope
`enabledPlugins:false`) try to close this; the 09:00 incident shows it still
fires. Root of why it still fires is unconfirmed — needs reproduction.

## 4. Proposed fixes

### Fix 1 (do first — unblocks recovery): provider-specific poller liveness
- Extract the provider-discrimination poller-liveness logic out of
  `channel-monitor.ts hasChannelPluginAlive()` into a new dependency-light
  module `src/web/channel-poller-liveness.ts` (channel-plugin-unlock.ts is
  imported BY channel-monitor.ts, so it must NOT import back — extract to a
  third module to avoid a cycle).
- Replace `hasBunChild(claudePid)` with `hasProviderPoller(claudePid, provider)`
  using that shared logic (telegram: child cmd includes `/telegram/` && bun,
  or bun && `server.ts`; NOT a bare bun match). `schedulePluginUnlockAfterRespawn`
  already receives `provider` — thread it through.
- Mirror the fix in `scripts/channels.sh` post-init unlock: replace
  `pgrep -P <pid> bun` with a provider-scoped check (e.g. `ps`-grep for the
  `/telegram/` poller under the pid), so cold launches aren't fooled by the
  synology bun either.
- Unit test: liveness fixtures with (telegram-only), (synology-only →
  telegram=false), (telegram+synology → telegram=true).

### Fix 2: deterministic main-agent state dir + reap on every respawn
- **DECIDED (2026-06-02, EFiveen reviewer ← Dev option C): export
  `TELEGRAM_STATE_DIR=$HOME/.claude/channels/telegram` (no migration).** Set it
  in BOTH `buildMainSessionRespawnCmd()` (after the PATH export, ~line 272) and
  `channels.sh` (before `new-session`). This points at the Claude Code DEFAULT
  location where the main state already lives (since 2026-05-12) — so poller
  behaviour is unchanged, but the env var is now present and the reap env-scan
  (`TELEGRAM_STATE_DIR=<HOME>/...`) + bot.pid both find the main poller. Zero
  data-loss risk; no dual reap logic. Rejected: (a) migrate to INSTALL_DIR
  (needless migration risk), (b) parameterise reap to the default (dual logic).
- **Completion requirement (do NOT half-apply):** the export alone fixes where
  the poller *registers*; the reap must scan the SAME dir. Align all three to
  `$HOME/.claude/channels/<provider>`: the export, `channels.sh` `MAIN_CHAN_DIR`
  (line 108, currently `$INSTALL_DIR/...`), and the `reapChannelOrphans(...)`
  call sites in channel-monitor.ts (currently `channelStateDir(provider,
  PROJECT_ROOT)` → must resolve to the HOME dir for the MAIN agent). Confirm the
  plugin default is HOME-based, not cwd-based (live evidence: state is in
  `~/.claude/channels/telegram` though cwd is INSTALL_DIR → confirmed HOME-based).
- Contract test: lock the PRESENCE of `TELEGRAM_STATE_DIR=` and the
  `.claude/channels/<provider>` suffix (HOME prefix is unknown at test time).
- Add `reapChannelOrphans(provider.type, <main state dir>)` to
  `respawnMarveenSessionFresh()` before the respawn-pane, mirroring
  `resumeMarveenSession()`.
- Contract test (`channel-stability-contract.test.ts`): lock that
  `buildMainSessionRespawnCmd` exports `TELEGRAM_STATE_DIR` (like it locks PATH),
  and that the fresh-respawn path reaps.

### Fix 3 (trigger, separate change): close sub-agent poller steal
- Reproduce: spawn a heartbeat/scheduled sub-agent, confirm whether it loads
  the telegram plugin despite the #247 project-scope `enabledPlugins:false`.
- Likely angles to check: user-scope vs project-scope merge order in the SDK
  spawn; the disable-write racing the spawn; sub-agent cwd not picking up the
  project settings. Fix at the source so no second poller ever starts.
- Lower urgency than 1+2 (those make the system self-heal even when C fires),
  but C is what knocks telegram down in the first place.

## 5. Upstream-impact analysis (Szotasz/marveen)

- Fix 1: `channel-plugin-unlock.ts` + `channels.sh` are core/upstream. The
  bug bites any install running two channel providers (slack+telegram, or our
  synology+telegram). **Upstream PR candidate.**
- Fix 2: pure upstream bug (fresh-respawn skips reap; state-dir mismatch).
  **Strong upstream PR candidate.**
- Fix 3: #237/#247 are upstream; this is their follow-through. **Upstream PR
  candidate.**
- synology-chat itself stays fork-local (EFi marketplace) — do NOT reference
  synology specifics in upstream PRs; frame as "any second channel-plugin bun
  poller".

PR gating (Krisztián, 2026-06-02): propose upstream PR **only tomorrow**, and
only if (a) our fix runs problem-free for ~24h, AND (b) nobody upstream has
landed an equivalent fix by then. Until then: fork-local on HiperiorNr1.

## 6. Verification

- Force the telegram plugin into Failed (or kill its poller) with synology bun
  alive → confirm the unlock probe now FIRES (`firing /mcp unlock sequence`),
  not the false "healthy" log; telegram recovers.
- Trigger a hard restart → confirm `reapChannelOrphans` runs and the main
  orphan (correct state dir) is killed.
- 24h watch: `store/dashboard.log` shows no `gave_up`, no reconnect loop.
- `bun test` green incl. new fixtures + contract locks.

## 7. NEW (2026-06-02 16:45, EFiveen) — Layer A is NOT fixed: CC 2.1.160 `/mcp` menu drift

After Fix 1+2 landed (b61c52a, 85d1b9c, 14:28–14:31) the cascade STILL loops on
this host. Krisztián reports the session "falls apart" intermittently — that
*is* this bug: every soft-reconnect fails → the cascade escalates to stage-4
`respawnMarveenSessionFresh()`, which restarts the whole `efiveen-channels`
session (and at 16:24 the stuck-tool-call-watcher's hard restart even failed,
16:27 the entire tmux server restarted). The user-visible "szétesés" is the
hard-restart fallout, not a separate fault.

### Evidence (live, this host)
- `store/dashboard.log` 16:04 and 16:33–16:34:
  `channel-mcp-reconnect: could not place cursor on target option` `target: "reconnect"`
  then `Could not select reconnect within 6 steps`. Repeats every cycle.
- The probe DID open the submenu (passed the `plugin:telegram:telegram`
  match gate) and chose `RECONNECT_RX`, but stepping the `❯` cursor Down
  `SUBMENU_MAX_STEPS` (6) never landed on a `/reconnect/i` row.

### Root cause: the submenu-parsing regexes in `channel-mcp-reconnect.ts` no
longer match what Claude Code **2.1.160** renders. Two structural suspects,
either of which produces exactly this failure (need a ground-truth capture to
confirm which):
  1. **Pointer glyph drift** — `POINTER_RX = /❯/` (line 59). If 2.1.160 marks
     the selected row with a different glyph / reverse-video-no-glyph, then
     `selectedSubmenuLine()` always returns null → `sel && target.test(sel)`
     never true → "could not place cursor" even though the row exists.
  2. **Status-header drift** — `DISABLED_STATUS_RX` / `FAILED_STATUS_RX`
     (lines 54–55) no longer match the 2.1.160 `Status:` line, so
     `chooseSubmenuTarget()` falls through to the line-94 footer fallback
     (`RECONNECT_RX.test(pane)` matches CC's own "Use /mcp to reconnect"
     footer) and picks Reconnect when no selectable Reconnect ROW exists.

`channel-plugin-unlock.ts`'s blind `/mcp + Up + Enter + Enter` (the cold-start
unlock probe) carries the SAME version assumption and is equally stale.

### Confirmed dead-end: no scriptable reconnect
`claude mcp` exposes only `add / add-from-claude-desktop / add-json / get /
list / remove / reset-project-choices / serve` — **no `reconnect` / `enable` /
`restart`**. A running session can only be revived by driving the TUI `/mcp`
menu (or a fresh respawn). So Layer A must be fixed in-place, not bypassed.

### For Dev — required next steps
1. Capture ground truth on 2.1.160: open `/mcp`, select a plugin server in
   each state (connected / failed / disabled), `tmux capture-pane -p`, and
   record the EXACT `Status:` line text, the action ROW labels, and the
   selected-row marker glyph.
2. Update `DISABLED_STATUS_RX`, `FAILED_STATUS_RX`, `POINTER_RX`, and the
   action-label regexes to the 2.1.160 rendering; mirror in
   `channel-plugin-unlock.ts`. Add fixtures captured from 2.1.160 so the
   next CC bump fails loudly in tests, not silently in production.
3. Consider: if menu-driving stays this fragile, gate the cascade so a
   failing soft-reconnect does NOT keep escalating to session-destroying
   hard restarts (cap, or prefer an explicit operator alert over a restart
   loop). Layer C (the trigger) remains the real cure.

Handoff: Krisztián (2026-06-02) — fix stays fully with Dev; EFiveen does not
touch the code. Supervisor/systemd gap (no `~/.config/systemd/user/marveen*`
units; nohup fallback has no auto-restart if the tmux server dies) noted but
deferred by Krisztián — separate change, not now.

## 8. GROUND TRUTH + fix design (2026-06-02 ~17:00, Dev)

Captured the real CC 2.1.160 `/mcp` rendering from an **isolated scratch
claude** (temp dir, `--strict-mcp-config --mcp-config` with one connected +
one failed synthetic server, `--settings` forcing all channel plugins OFF so
the probe could not steal the telegram token). Two synthetic servers + a
toggled Disable gave all three states. Exact bytes via `hexdump`.

### 8.1 What 2.1.160 actually renders

Server LIST rows (status is INLINE, there is no `Status:` header in the list):
```
❯ probe-connected · ✔ connected · 31 tools
  probe-failed · ✘ failed
  probe-connected · ◯ disabled
```

Plugin SUBMENU (after Enter on a row) — HAS a `Status:` header, action rows
are **numbered**:
```
  Probe-failed MCP Server
  Status:           ✘ failed
  Command:          ...
  ❯ 1. Reconnect
    2. Disable
```
- connected: `Status: ✔ connected` · rows `1. View tools / 2. Reconnect / 3. Disable` · cursor opens on row 1 (View tools)
- failed:    `Status: ✘ failed`    · rows `1. Reconnect / 2. Disable`              · cursor on row 1 (Reconnect)
- disabled:  `Status: ◯ disabled`  · row  `1. Enable`                              · cursor on row 1 (Enable)

Glyph codepoints (confirmed by hexdump):
| state | glyph | UTF-8 | codepoint | current regex matches? |
|---|---|---|---|---|
| connected | ✔ | `e2 9c 94` | U+2714 | n/a (not a target state) |
| failed | ✘ | `e2 9c 98` | U+2718 | **NO** — `FAILED_STATUS_RX` only has `✗`=U+2717 |
| disabled | ◯ | `e2 97 af` | U+25EF | YES — `[◯○]` includes U+25EF |

### 8.2 Root cause (confirmed, two defects)

**Defect 1 (PRIMARY — fully explains the live log).** The `/mcp` slash command
stays **echoed in the input line** at the top of the captured pane:
```
❯ /mcp        <- input echo (line ~15)
...
  ❯ 1. Reconnect   <- the REAL submenu cursor (line ~24)
```
`selectedSubmenuLine()` returns the FIRST line matching `POINTER_RX = /❯/`,
which is `❯ /mcp` — not the menu cursor. So `target.test(sel)` is run against
`"❯ /mcp"`, never matches `/reconnect/i`, the loop presses Down 6× (the input
line never moves), and we log *"could not place cursor on target option,
target: reconnect"* / *"Could not select reconnect within 6 steps"* — EXACTLY
the 16:04 / 16:33-34 log lines. This bites **every** state (connected needs to
step to row 2; failed/disabled are on row 1 but still shadowed). This is the
loop driver.

**Defect 2 (glyph drift, secondary).** `FAILED_STATUS_RX = /Status:\s*[✗x×]\s*failed/i`
does not match the 2.1.160 `✘` (U+2718). `chooseSubmenuTarget` therefore can't
read "failed" from the status header and falls through to the footer/label
fallback. For the failed state that fallback still picks Reconnect (a Reconnect
row text exists), so it is not *independently* fatal — but it is correct only
by luck and must be fixed for robustness. (`DISABLED_STATUS_RX` is fine.)

### 8.3 Fix (minimal, both in `src/web/channel-mcp-reconnect.ts`)

1. **Stop the input-line shadow.** Match the numbered menu-cursor row instead
   of any `❯`:
   ```ts
   // CC 2.1.160 keeps `❯ /mcp` echoed in the input line; the real submenu
   // cursor marks a numbered action row (`❯ 1. Reconnect`). Match that form
   // so the input echo can't shadow the selection.
   const SUBMENU_CURSOR_RX = /❯\s+\d+\.\s/
   ```
   `selectedSubmenuLine` returns the first line matching `SUBMENU_CURSOR_RX`.
2. **Add the new failed glyph:** `FAILED_STATUS_RX = /Status:\s*[✗✘xX×]\s*failed/i`
   (keep `✗` for older CC).

No change to the plugin-finding Up-loop (the live error is "could not place
cursor", which only fires AFTER the plugin submenu was found — so that stage
still works on 2.1.160; "not found" would log otherwise).

**`channel-plugin-unlock.ts` deliberately NOT changed** (diverges from §7
step 2's "mirror"): that probe is *blind* — it presses Enter on submenu row 1
and never parses Status/cursor. It only fires when the provider poller is
ABSENT (failed/disabled), and in both those states row 1 is the correct action
(Reconnect / Enable). So the regex drift does not affect it. Flagging for
reviewer: if you want defence-in-depth we can later route the unlock probe
through the same parsed navigator, but that is not needed for the acute fix and
adds risk now.

**NEXT-ROUND (EFiveen review note, 2026-06-02 — do not lose):** the unlock
probe's single `Up` "wrap to bottom of list" assumption is no longer safe now
that synology-chat is a SECOND plugin server in the `/mcp` list. One Up may
land on synology's row, open ITS submenu, and press Enter on synology's row 1
— leaving telegram un-revived. Routing the blind unlock probe through the
parsed navigator (find the telegram row by `pluginPattern`, then drive the
numbered cursor onto Reconnect/Enable) fixes this too. Tracked as the unlock
follow-up; ship with or after Layer C, not in the acute regex fix.

### 8.4 Tests (lock 2.1.160 so the next CC bump fails loudly)

- Rewrite the `SUBMENU_*` fixtures in `channel-mcp-reconnect.test.ts` to the
  REAL 2.1.160 capture **including the `❯ /mcp` input-echo line** and numbered
  rows. The current fixtures (`❯ View tools`, no input line, no numbers) encode
  the OLD rendering and are why this regressed silently.
- New regression test: `selectedSubmenuLine` on a pane that contains BOTH
  `❯ /mcp` and `❯ 2. Reconnect` returns the numbered row, never the input echo.
- `chooseSubmenuTarget` on the real `Status: ✘ failed` pane returns Reconnect
  via the STATUS header (not the fallback).
- Keep the existing connected/failed/disabled `attemptChannelMcpReconnect`
  flow tests; update their fixtures.

### 8.5 Upstream-impact

`channel-mcp-reconnect.ts` is core/upstream. Both defects are pure CC-version
drift that bites any install on CC 2.1.160 — **strong upstream PR candidate**,
same gating as §5 (fork-local now; propose upstream only after the ~24h clean
run, framed generically as "any channel plugin", no synology specifics).

### 8.6 Verification

- `bun test` green incl. the rewritten 2.1.160 fixtures + the shadow regression.
- After deploy, force telegram into failed/disabled on `efiveen-channels` and
  confirm `channel-mcp-reconnect: completed` (action Reconnect/Enable) replaces
  the "could not place cursor" log; channel recovers without a hard restart.
- 24h watch: no `gave_up`, no reconnect loop in `store/dashboard.log`.

> Status: ground truth done, fix designed. Planning-first — **awaiting
> EFiveen GO before writing code** (deliberately not coded yet).
