# Migration runbook — moving the fleet to a new machine

Goal: move the whole Marveen fleet to a stronger host with **zero
data loss** and minimal downtime. Read this end to end before starting.

The single most important rule: **ONE BOT = ONE POLLER.** A Telegram/Slack bot
token may only be long-polled by one running session. Do **not** run the old
and new machine against the same token at once — the second poller gets HTTP
409 Conflict and inbound messages are split/lost. Cut over (old off → new on),
never overlap.

## Backup configuration

`scripts/backup.sh` resolves its configuration from THREE sources, in this
precedence order:

1. explicit process environment (e.g. `BACKUP_ENCRYPTION=key bash backup.sh`)
2. project `.env` (one `key=value` per line; last definition wins; surrounding
   matching quotes are stripped)
3. the built-in defaults shown in the table below

Putting the values in `.env` means a scheduled timer (systemd / launchd /
cron) just runs `bash backup.sh --report --source=scheduled` -- the
encryption mode and recipient are read at start-up. Manual CLI, dashboard-
triggered, and scheduled runs all see the same config.

| Variable | Default | Purpose |
|---|---|---|
| `BACKUP_DIR` | `<repo>/backups` | Destination directory for archives. |
| `BACKUP_KEEP` | `14` | Number of most-recent archives to retain. |
| `BACKUP_LOG` | `<repo>/store/backups.log` | Append-only operator log. |
| `BACKUP_ENCRYPTION` | `none` | `none` or `key`. See "Encryption" below. Default is `none` to keep zero-config installs working unchanged; switch to `key` in production. |
| `BACKUP_AGE_RECIPIENT` | unset | Required when `BACKUP_ENCRYPTION=key`. An `age1...` public key string OR a path to an age recipients file. |
| `BACKUP_ENCRYPT_CMD` | unset | **Advanced** escape-hatch. If set, replaces the built-in `age` pipeline -- the tar.gz is piped through this command string. Use for gpg/openssl/passphrase or custom flows. Pairs with `BACKUP_ENCRYPT_EXT`. |
| `BACKUP_ENCRYPT_EXT` | `.enc` | Output extension when `BACKUP_ENCRYPT_CMD` is set. |

Flags:
- `--report` writes a row to `store/claudeclaw.db` `backup_jobs` table (status,
  size, duration, encryption mode, source). The dashboard reads from this
  table.
- `--source=cli|scheduled|manual` tags the report row. Default: `cli`.

## Encryption

The archive always contains plaintext tokens by definition (dashboard bearer,
channel bot tokens, `.env` secrets). Encrypt it at rest. Two built-in modes
plus an escape-hatch.

### Mode 1: `BACKUP_ENCRYPTION=key` (strongly recommended)

Public-key encryption with [age](https://github.com/FiloSottile/age). The
machine doing the backup only ever needs the PUBLIC key; the matching PRIVATE
key lives off-site with you and is never on the backup host. Unattended-safe,
no prompts.

One-time keypair setup (on a separate trusted machine, NOT the backup host):

```bash
age-keygen -o marveen-backup.identity
# marveen-backup.identity contains the PRIVATE key. Keep this OFF-SITE
# (encrypted USB, password manager attachment, hardware token). Losing it
# = losing every encrypted backup.
grep '^# public key:' marveen-backup.identity   # → "# public key: age1xxxxx..."
```

Then on the backup host, set the public key in the project `.env`:

```
BACKUP_ENCRYPTION=key
BACKUP_AGE_RECIPIENT=age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Backups land as `claudeclaw-YYYYmmdd-HHMMSS.tar.gz.age`. To restore: provide
the private key to `scripts/restore.sh` (it auto-detects the `.age` extension
and prompts / reads from `BACKUP_AGE_IDENTITY` for the key).

### Mode 2: `BACKUP_ENCRYPTION=none` (shipped default, backward-compatible)

Plaintext tar.gz. The script prints a loud warning every run. This is the
shipped default so that an existing cron / launchd install that ran the
pre-2026-06-09 `backup.sh` keeps producing archives without configuration
changes. Acceptable only when the destination is itself encrypted (full-disk
encryption, encrypted volume) AND never leaves that boundary. Never sync
this archive to cloud storage unencrypted. Switch to `key` mode as soon as
you can generate and store an age keypair.

### Mode 3 (advanced): `BACKUP_ENCRYPT_CMD` escape-hatch

If you must use `gpg`, `openssl`, a passphrase, or some other custom flow,
set the command string. The script pipes the tar.gz through it and appends
`BACKUP_ENCRYPT_EXT` to the output name.

Examples (place in `.env`):

```
# GPG symmetric (passphrase-derived)
BACKUP_ENCRYPT_CMD='gpg --symmetric --cipher-algo AES256 --passphrase-file /etc/marveen/backup.pass --batch --yes --no-tty'
BACKUP_ENCRYPT_EXT=.gpg

# OpenSSL AES-256-CBC with PBKDF2
BACKUP_ENCRYPT_CMD='openssl enc -aes-256-cbc -salt -pbkdf2 -pass file:/etc/marveen/backup.pass'
BACKUP_ENCRYPT_EXT=.enc

# age passphrase mode (passphrase from a file). Requires age >= 1.1 and
# AGE_PASSPHRASE_FD support; not all packaged builds ship this.
BACKUP_ENCRYPT_CMD='env AGE_PASSPHRASE_FD=3 3</etc/marveen/backup.pass age -p'
BACKUP_ENCRYPT_EXT=.age
```

For restore, set the matching `BACKUP_DECRYPT_CMD` (see `scripts/restore.sh
--help`).

### What MUST live off-site

Whichever mode you pick, the secret-material to decrypt MUST live off-site
(and protected with its own backup). Losing it = losing every encrypted
backup. Treat the backup secret like a hardware-key recovery sheet: paper or
hardware token, not the same drive that holds the encrypted backups.

---

## 1. What moves (inventory)

Three independent stores. The tarball (`scripts/backup.sh`) covers (1) and (2);
the Docker volumes (3) are **separate** and must be moved on their own.

**(1) Repo-relative — under the project root (`repo/` group in the archive)**
- `store/claudeclaw.db` (+ `-shm`/`-wal`) — kanban, memory, messages, schedules DB
- `store/.dashboard-token` — dashboard bearer token
- `.env` — project secrets
- `scheduled-tasks.json` — legacy, if present
- `assets/meetings/**` — meeting transcripts/memos
- `agents/*/CLAUDE.md`, `SOUL.md`, `.mcp.json` — per-agent identity
- `agents/*/.claude/channels/*/.env`, `access.json` — sub-agent channel tokens + pairing

**(2) Home-relative — under `$HOME` (`home/` group in the archive)**
- `~/.claude/skills/**` — the self-built skill library
- `~/.claude/scheduled-tasks/**` — file-based scheduled tasks (SKILL.md + task-config.json)
- `~/.claude/channels/*/.env` — MAIN orchestrator channel token
- `~/.claude/channels/*/access.json`, `invites.json`, `approved/**` — pairing allowlist + approvals
- `~/Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist` -- launchd jobs (the prefix is your `MAIN_AGENT_ID`, `marveen` by default)

**(3) Docker volumes — NOT in the tarball, migrate separately**
- `stack_influxdb-data`, `stack_influxdb-config` — InfluxDB 2.7 time-series (Loxone history)
- `stack_grafana-data` — Grafana dashboards/datasources
- Source: `projects/loxonTSDB/` (compose stack). Volumes are docker-managed and
  do **not** live in the repo, so a `git clone` + tar restore does NOT bring
  them. Forgetting this silently loses all historical metrics.

**Not migrated (rebuilt natively, see pitfalls):** `.venv-whisperx`, `.venv-diar`
(Python venvs with Apple-Silicon-native wheels), `node_modules/`, `dist/`.

---

## 2. On the OLD machine (prepare)

1. Record versions so the new host matches:
   - `node -v` (currently v22.x), `claude --version` (pinned; auto-update OFF),
     `docker --version`, `tailscale version`.
2. Run a fresh backup and verify it:
   ```bash
   cd <repo> && bash scripts/backup.sh
   tar -tzf backups/claudeclaw-*.tar.gz | sed -E 's,(^[^/]+/[^/]+/).*,\1...,' | sort -u
   ```
   Confirm both `repo/...` and `home/...` groups and the `MANIFEST.txt` are present.
3. Export the Docker volumes (time-series + dashboards):
   ```bash
   cd <repo>/projects/loxonTSDB && docker compose down   # quiesce writers first
   for v in stack_influxdb-data stack_influxdb-config stack_grafana-data; do
     docker run --rm -v "$v":/from -v "$PWD":/to alpine \
       tar -czf "/to/${v}.tar.gz" -C /from .
   done
   ```
   (Or `influx backup` for InfluxDB specifically — but the volume tar is the
   simplest complete capture of both Influx and Grafana.)
4. Copy the backup archive + the three `stack_*.tar.gz` to the new machine over
   a trusted channel (USB / `scp` / Tailscale file copy). **Never** put the
   token-bearing archive in iCloud/Dropbox/Drive.
5. **Do not stop the live fleet yet** — keep it serving until the new host is
   verified and you are ready to cut over (step 4 below).

---

## 3. On the NEW machine (restore)

1. **Prereqs** (Apple Silicon native): Homebrew, `node` (match the old major
   version), Docker Desktop, Tailscale, `git`, `sqlite3`, `tmux`, `ffmpeg`,
   `python3`. The repo ships `install-macos.sh` — use it for the baseline, then
   pin `claude` to the same version and keep auto-update OFF
   (`DISABLE_AUTOUPDATER=1`) to avoid the binary-churn PATH failure.
2. **Clone the repo** to the same absolute path if possible
   (`/Users/<user>/marveen`). A different path means every launchd plist and
   any absolute reference must be updated (see pitfalls).
3. **Restore the tarball**, preserving modes (the token files are `0600`):
   ```bash
   mkdir -p /tmp/restore && tar -xpzf claudeclaw-YYYYmmdd-HHMMSS.tar.gz -C /tmp/restore
   # inspect /tmp/restore/MANIFEST.txt, then:
   rsync -a /tmp/restore/repo/  <repo>/         # repo group -> project root
   rsync -a /tmp/restore/home/  "$HOME/"        # home group -> $HOME
   ```
   Verify perms: `ls -l <repo>/store/.dashboard-token ~/.claude/channels/*/.env`
   should show `-rw-------`.
4. **Build the app** (do NOT copy `dist/` or `node_modules/` from the old box):
   ```bash
   cd <repo> && npm install && npm run build
   ```
5. **Restore the Docker volumes**, then bring the stack up:
   ```bash
   for v in stack_influxdb-data stack_influxdb-config stack_grafana-data; do
     docker volume create "$v"
     docker run --rm -v "$v":/to -v "$PWD":/from alpine \
       sh -c "cd /to && tar -xzf /from/${v}.tar.gz"
   done
   cd <repo>/projects/loxonTSDB && docker compose up -d
   ```
6. **Rebuild the Python venvs natively** (do NOT copy them — see pitfalls):
   recreate `.venv-whisperx` and `.venv-diar` with `python3 -m venv` and reinstall
   their packages so the torch/whisper wheels are arm64, not the old Intel x86_64.
7. **Fix + install the launchd jobs:**
   - If the user/home/repo path changed, edit each
     `~/Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist` (`ProgramArguments`,
     `WorkingDirectory`, `StandardOutPath`, env `HOME`/`PATH`) to the new paths.
     The label prefix is your `MAIN_AGENT_ID` (`marveen` by default).
   - Load them: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<MAIN_AGENT_ID>.<job>.plist`
     (the core jobs are `channels` and `dashboard`; load any other
     `com.<MAIN_AGENT_ID>.*` jobs you run too).
8. **Grant macOS permissions (TCC):** the first time the new processes need
   Full Disk Access / Automation / Accessibility, macOS silently blocks them
   until granted in System Settings → Privacy & Security. Grant Full Disk
   Access to the terminal/`node`/`tmux` that run the fleet, or launchd jobs will
   fail to read protected paths with no obvious error.

---

## 4. Cutover (the irreversible step — do last)

1. On the OLD machine: stop everything that polls a bot token, in this order:
   `launchctl bootout gui/$(id -u)/com.<MAIN_AGENT_ID>.channels` (and the dashboard,
   watchdogs), then confirm no `bun server.ts` / poller is left
   (`pgrep -fl "claude .*--channels"`). Leaving the old poller alive = 409 on the new one.
2. On the NEW machine: start `com.<MAIN_AGENT_ID>.channels` (and dashboard). Confirm
   a fresh poller: `pgrep -P <channels_pid>` shows a `bun` child, `bot.pid`
   appears, `getWebhookInfo` `pending_update_count` drains to 0.
3. Send a test Telegram message → it must reach the new fleet and get a reply.

---

## 5. Pitfalls (read before cutover)

- **ONE BOT = ONE POLLER.** Repeated for emphasis: stop the old poller before
  starting the new one, or inbound 409s and messages vanish. (See also
  `telegram-inbound-dead-poller` skill.)
- **macOS Full Disk Access / TCC.** New processes are blocked from protected
  paths until explicitly granted; the failure is silent. Grant FDA to the
  fleet's terminal/node/tmux up front.
- **launchd plist paths are absolute.** `ProgramArguments`
  (`/usr/local/bin/node`, `<repo>/dist/index.js`), `WorkingDirectory`, log
  paths, and `EnvironmentVariables` (`HOME`, `PATH`, `DISABLE_AUTOUPDATER`) all
  hard-code paths. If the username/home/node location differs, fix every plist
  or the jobs fail to launch.
- **Python venvs are not portable.** `.venv-whisperx` / `.venv-diar` hold
  compiled torch/whisper wheels built for the old CPU arch (Intel x86_64). On
  Apple Silicon they must be **rebuilt** (`python3 -m venv` + reinstall), never
  copied — a copied venv crashes with arch/dyld errors.
- **Docker volumes are not in the tarball.** InfluxDB history + Grafana
  dashboards live in `stack_*` docker volumes; export/import them separately
  (section 2.3 / 3.5). `git clone` + tar restore does NOT bring them.
- **Tailscale.** The dashboard's external reach (`WEB_HOST`, `DASHBOARD_PUBLIC_URL`)
  depends on the host's Tailscale identity. Install/log in Tailscale on the new
  host; the machine gets a new tailnet name/IP, so update any URL that pinned
  the old hostname. (See `marveen-dashboard-kulso-eleres` skill.)
- **claude auto-update.** Keep `DISABLE_AUTOUPDATER=1`; the global-install
  auto-updater rewrites the native binary and the `/usr/local/bin/claude`
  symlink can vanish mid-swap → "claude not found on PATH" rapid-fail loops.
- **dist vs src.** Always `npm run build` on the new host; never trust a copied
  `dist/`. The dashboard launchd job runs `node dist/index.js` directly.

---

## 6. Post-migration verification checklist

- [ ] Dashboard reachable at `http://localhost:3420` (and via Tailscale if used).
- [ ] `sqlite3 store/claudeclaw.db 'PRAGMA integrity_check;'` → `ok`.
- [ ] Kanban, memory, schedules visible in the dashboard (DB restored).
- [ ] Skills present: `ls ~/.claude/skills` matches the old count.
- [ ] Scheduled tasks present: `ls ~/.claude/scheduled-tasks` matches.
- [ ] Telegram inbound + outbound works (test message round-trip).
- [ ] Pairing intact: previously-approved chats still allowed (no re-pairing).
- [ ] InfluxDB has the history: a Flux `count()` over the Loxone measurement
      matches the old machine; Grafana dashboards render.
- [ ] All your launchd jobs are loaded: `launchctl list | grep com.<MAIN_AGENT_ID>`.
- [ ] Old machine's pollers are fully stopped (no 409).
