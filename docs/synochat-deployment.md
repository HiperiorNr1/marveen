# SynoChat deployment (EFi-only, NOT upstream)

The Synology Chat plugin lives at `~/.claude/plugins/efi-src/synology-chat/`
(EFi fork-local, not part of Szotasz/marveen). It runs in two modes that share
the same `index.ts`:

| Mode | Spawned by | Process shape | Listens on 3421? |
|---|---|---|---|
| MCP-only (reply tool) | Claude Code plugin loader, per agent | `bun run --cwd ... --silent start` | NO -- gated off |
| HTTP listener (NAS -> us inbound) | This systemd user unit | `bun run index.ts` | YES |

The MCP-only instance is auto-spawned by Claude Code for every agent that has
the plugin enabled. The HTTP listener is a SEPARATE, single-instance bridge
that receives Synology Chat's outgoing webhook on TCP/3421. Without it, NAS
-> us messages never arrive (outbound us -> NAS still works via MCP, masking
the fault).

## systemd user unit

`~/.config/systemd/user/efiveen-synochat-http.service`. Key choices:

- `Restart=always` mirrors `efiveen-channels.service`. A bridge must come back
  on clean exits too (port leak after Bun upgrade, unhandled promise reject
  that translates to exit 0), not only on non-zero failures.
- `StartLimitIntervalSec=0` disables systemd's start-rate limiter for the same
  reason -- a critical bridge must never permanently give up.
- `Environment=SYNOLOGY_CHAT_HTTP_ENABLED=1` is load-bearing. `index.ts:844`
  gates `Bun.serve()` on this flag so the MCP-only instance can leave it unset
  and not double-bind the port; the unit MUST set it.
- `Wants=efiveen-dashboard.service` (not Requires/BindsTo) only sequences
  startup order, NOT cascading restarts. The script's vault-token resolver
  (`index.ts:81 resolveVault`) hits the dashboard's `/api/vault` to expand
  `${VAULT:...}` placeholders, so it needs the dashboard up at first boot.
  If the dashboard restarts, the listener is untouched.

## Install

```bash
systemctl --user daemon-reload
systemctl --user enable --now efiveen-synochat-http.service
```

Verify:

```bash
systemctl --user is-active efiveen-synochat-http.service   # active
ss -tlnp | grep ':3421 '                                    # bun listening
```

## Don'ts

- Do NOT broad-`pkill -f 'bun run'` -- the MCP-only instance
  (`bun run --cwd ... --silent start`) is the reply tool for the channels
  session. Target by PID instead. The listener is `bun run index.ts`; the
  MCP-only is `bun run --cwd <plugin-dir> ...start`.
- Do NOT add the listener launch to `scripts/channels.sh`. That script is
  upstream-tracked (Szotasz/marveen). The listener lifecycle must stay
  independent of the channels session: a channels-session restart should
  not knock NAS -> us inbound offline.
