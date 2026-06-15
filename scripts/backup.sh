#!/usr/bin/env bash
# Marveen backup.
#
# The archive has two top-level groups so a restore is unambiguous about
# where each file belongs (see docs/MIGRATION.md):
#
#   repo/   -> extract under the project root (this repo)
#     store/claudeclaw.db (+ -shm/-wal; WAL-checkpointed before copy)
#     store/.dashboard-token   (dashboard bearer)
#     .env                     (project root secrets)
#     scheduled-tasks.json     (legacy, if present)
#     assets/meetings/**       (meeting transcripts/memos)
#     agents/*/CLAUDE.md, SOUL.md, .mcp.json
#     agents/*/.claude/channels/{telegram,slack,discord}/.env, access.json
#
#   home/   -> extract under $HOME
#     .claude/skills/**            (the self-built skill library)
#     .claude/scheduled-tasks/**   (file-based scheduled tasks: SKILL.md + config)
#     .claude/channels/*/.env      (MAIN orchestrator channel token)
#     .claude/channels/*/access.json, invites.json, approved/**  (pairing state)
#     Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist (launchd jobs)
#
# Output: $BACKUP_DIR/claudeclaw-YYYYmmdd-HHMMSS.tar.gz[.age]
# Retention: keeps the most recent $BACKUP_KEEP archives, prunes the rest.
#
# Configuration sources, in precedence order (high -> low):
#   1. explicit process environment (BACKUP_* set non-empty in the shell that
#      invokes backup.sh)
#   2. project .env (key=value lines, last definition wins, quotes stripped)
#   3. built-in defaults shown below.
#
# Putting the values in .env means a systemd / launchd / cron timer just runs
# `backup.sh --report --source=scheduled` -- the encryption mode and recipient
# come from .env, not from a baked-in EnvironmentFile or inline env prefix.
# Manual CLI and dashboard-triggered runs see the same config.
#
# Environment overrides (all optional, defaults shown):
#   BACKUP_DIR=${REPO_ROOT}/backups
#   BACKUP_KEEP=14
#   BACKUP_LOG=${REPO_ROOT}/store/backups.log
#   BACKUP_ENCRYPTION=none          # one of: none | key
#     - none (default, backward-compat): tar.gz plaintext; archive contains
#       tokens in cleartext. Loud warning every run. STRONGLY RECOMMENDED to
#       switch to 'key' in production deployments -- see docs/MIGRATION.md.
#     - key:  age -r <recipient> wrapper. Public key on this machine, private
#             key kept off-site by the operator. Unattended-safe.
#   BACKUP_AGE_RECIPIENT=           # required when BACKUP_ENCRYPTION=key.
#                                   # An `age1...` public key string (or a path
#                                   # to a recipients file). See docs/MIGRATION.md.
#   BACKUP_ENCRYPT_CMD=             # ADVANCED escape-hatch. If set, replaces the
#                                   # built-in `age` pipeline -- the tar.gz is
#                                   # piped through this command string. Use for
#                                   # gpg/openssl/custom flows. Output extension
#                                   # is appended by ${BACKUP_ENCRYPT_EXT:-.enc}.
#   BACKUP_ENCRYPT_EXT=             # extension for the escape-hatch output (e.g.
#                                   # .gpg, .enc). Used together with BACKUP_ENCRYPT_CMD.
#
# Flags:
#   --report               Write a row to store/claudeclaw.db (backup_jobs table)
#                          with status, size, duration, encryption flag, source.
#   --source=cli|scheduled|manual   Tag the report row (default: cli).
#
# Restore (preserve modes so the 0600 token files stay private):
#   scripts/restore.sh <archive>        # automated path (recommended)
#   tar -xpzf <archive> -C /tmp/restore # manual fallback (none-encryption only)
# Full runbook: docs/MIGRATION.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# .env reader for BACKUP_* keys. Precedence (high -> low):
#   1. explicit process environment (set non-empty before invoking backup.sh)
#   2. project .env (last definition wins, surrounding quotes stripped)
#   3. built-in default passed to this helper
# Without (2) the scheduled timer would have to bake encryption into the
# unit file; with (2) every invocation path (manual CLI, systemd/launchd/
# cron timer, dashboard trigger) sees identical config from one source.
# Mirrors the existing MAIN_AGENT_ID parse pattern below.
_read_env_or() {
  local key="$1" default="$2"
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    local v
    v="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "${REPO_ROOT}/.env" 2>/dev/null \
      | tail -1 \
      | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
    [[ -n "${v}" ]] && { printf '%s' "${v}"; return; }
  fi
  printf '%s' "${default}"
}

BACKUP_DIR="${BACKUP_DIR:-$(_read_env_or BACKUP_DIR "${REPO_ROOT}/backups")}"
BACKUP_KEEP="${BACKUP_KEEP:-$(_read_env_or BACKUP_KEEP 14)}"
BACKUP_LOG="${BACKUP_LOG:-$(_read_env_or BACKUP_LOG "${REPO_ROOT}/store/backups.log")}"
BACKUP_ENCRYPTION="${BACKUP_ENCRYPTION:-$(_read_env_or BACKUP_ENCRYPTION none)}"
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-$(_read_env_or BACKUP_AGE_RECIPIENT "")}"
BACKUP_ENCRYPT_CMD="${BACKUP_ENCRYPT_CMD:-$(_read_env_or BACKUP_ENCRYPT_CMD "")}"
BACKUP_ENCRYPT_EXT="${BACKUP_ENCRYPT_EXT:-$(_read_env_or BACKUP_ENCRYPT_EXT .enc)}"

# Flag parse. Keep tiny -- this script is single-purpose; complex CLI belongs
# in a wrapper.
REPORT=0
SOURCE_TAG="cli"
for arg in "$@"; do
  case "${arg}" in
    --report) REPORT=1 ;;
    --source=*) SOURCE_TAG="${arg#--source=}" ;;
    --help|-h)
      sed -n '1,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "backup: unknown flag '${arg}'" >&2; exit 2 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${BACKUP_DIR}/claudeclaw-${STAMP}.tar.gz"
START_MS="$(date +%s%3N 2>/dev/null || date +%s000)"
FINAL_PATH=""        # set after encryption -- this is what restore.sh reads.
BACKUP_STATUS="ok"
BACKUP_ERROR=""

# Validate config UP FRONT so an unsupported mode does not waste work.
case "${BACKUP_ENCRYPTION}" in
  none|key) ;;
  *)
    echo "backup: ERROR -- BACKUP_ENCRYPTION='${BACKUP_ENCRYPTION}' is not supported. Valid values: none | key. For custom encryption (gpg/openssl/passphrase) set BACKUP_ENCRYPT_CMD as an escape-hatch -- see docs/MIGRATION.md." >&2
    exit 2 ;;
esac
if [[ "${BACKUP_ENCRYPTION}" == "key" && -z "${BACKUP_AGE_RECIPIENT}" && -z "${BACKUP_ENCRYPT_CMD}" ]]; then
  echo "backup: ERROR -- BACKUP_ENCRYPTION=key requires BACKUP_AGE_RECIPIENT (an age1... public key string or a recipients file path). See docs/MIGRATION.md to generate a keypair." >&2
  exit 2
fi
if [[ "${BACKUP_ENCRYPTION}" == "key" && -z "${BACKUP_ENCRYPT_CMD}" ]] && ! command -v age >/dev/null 2>&1; then
  echo "backup: ERROR -- BACKUP_ENCRYPTION=key but 'age' binary not found. Install: 'brew install age' (macOS) or 'apt install age' (Debian/Ubuntu). Or set BACKUP_ENCRYPTION=none to opt out of encryption (NOT recommended -- the archive contains plaintext tokens)." >&2
  exit 2
fi

mkdir -p "${BACKUP_DIR}"
mkdir -p "$(dirname "${BACKUP_LOG}")"
cd "${REPO_ROOT}"

# Checkpoint WAL into the main DB file so the snapshot is self-contained.
# Tolerate a missing sqlite3 CLI -- just fall back to copying the files as-is.
if [[ -f store/claudeclaw.db ]] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 store/claudeclaw.db 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null || true
fi

# --- Build the two path lists (each relative to its own base). -------------
# tar refuses missing entries, which would fail the whole backup on a fresh
# machine (no agents yet) -- so we only list paths that actually exist.
REPOLIST="$(mktemp -t claudeclaw-repo.XXXXXX)"
HOMELIST="$(mktemp -t claudeclaw-home.XXXXXX)"
MANIFEST="$(mktemp -t claudeclaw-manifest.XXXXXX)"
STAGE="$(mktemp -d -t claudeclaw-stage.XXXXXX)"

# add_if <listfile> <base> <relpath>  -- append relpath when <base>/<relpath> exists.
add_if() {
  local list="$1" base="$2" rel="$3"
  if [[ -e "${base}/${rel}" ]]; then echo "${rel}" >> "${list}"; fi
}

# repo/ group (relative to REPO_ROOT)
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db-shm
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db-wal
add_if "${REPOLIST}" "${REPO_ROOT}" store/.dashboard-token
add_if "${REPOLIST}" "${REPO_ROOT}" store/config-overrides.json
add_if "${REPOLIST}" "${REPO_ROOT}" .env
add_if "${REPOLIST}" "${REPO_ROOT}" scheduled-tasks.json
add_if "${REPOLIST}" "${REPO_ROOT}" assets/meetings
# Per-agent identity + channel secrets (glob; missing dir is not an error).
if [[ -d agents ]]; then
  find agents -type f \
    \( -name 'CLAUDE.md' -o -name 'SOUL.md' -o -name '.mcp.json' \
       -o -name 'access.json' -o -name '.env' \) \
    -print >> "${REPOLIST}"
fi

# home/ group (relative to $HOME)
add_if "${HOMELIST}" "${HOME}" .claude/skills
add_if "${HOMELIST}" "${HOME}" .claude/scheduled-tasks
# MAIN orchestrator channel tokens + pairing state, per provider. bot.pid and
# inbox/ are runtime/transient and intentionally excluded.
if [[ -d "${HOME}/.claude/channels" ]]; then
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 \
      \( -name '.env' -o -name 'access.json' -o -name 'invites.json' \) \
      -print ) >> "${HOMELIST}"
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 -type d -name 'approved' -print ) >> "${HOMELIST}"
fi
# launchd jobs for this fleet. The job labels are com.<MAIN_AGENT_ID>.<service>
# (see src/web/main-agent.ts), so resolve MAIN_AGENT_ID the way the app does
# (src/env.ts: read from .env, default "marveen" when unset) instead of
# hardcoding one deployment's prefix. Parsing mirrors env.ts: last definition
# wins, surrounding matching quotes stripped.
MAIN_AGENT_ID="marveen"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  # `|| true`: with `set -o pipefail`, a no-match grep would otherwise fail the
  # whole substitution (and, under `set -e`, abort the backup) on any install
  # that leaves MAIN_AGENT_ID unset and relies on the "marveen" default.
  _mid="$(grep -E '^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=' "${REPO_ROOT}/.env" | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
  [[ -n "${_mid}" ]] && MAIN_AGENT_ID="${_mid}"
fi
if [[ -d "${HOME}/Library/LaunchAgents" ]]; then
  ( cd "${HOME}" && find Library/LaunchAgents -maxdepth 1 -name "com.${MAIN_AGENT_ID}.*.plist" -print ) >> "${HOMELIST}"
fi

# --- Trap + report helpers. ------------------------------------------------
# write_report() always runs in the EXIT trap when --report was passed, so
# both successes and failures show up in the dashboard. The status field is
# updated by the ERR trap when something goes wrong.
write_report() {
  [[ "${REPORT}" -eq 1 ]] || return 0
  local end_ms duration_ms size_bytes encrypted_int status_quoted archive_quoted error_quoted
  end_ms="$(date +%s%3N 2>/dev/null || date +%s000)"
  duration_ms=$((end_ms - START_MS))
  size_bytes=0
  if [[ -n "${FINAL_PATH}" && -f "${FINAL_PATH}" ]]; then
    size_bytes=$(wc -c < "${FINAL_PATH}" | awk '{print $1}')
  fi
  encrypted_int=0
  [[ "${BACKUP_ENCRYPTION}" != "none" || -n "${BACKUP_ENCRYPT_CMD}" ]] && encrypted_int=1
  if [[ ! -f "${REPO_ROOT}/store/claudeclaw.db" ]] || ! command -v sqlite3 >/dev/null 2>&1; then
    return 0
  fi
  # Self-contained schema: CREATE IF NOT EXISTS so the first --report run
  # creates the table. The dashboard's backup module reads from this table.
  sqlite3 "${REPO_ROOT}/store/claudeclaw.db" <<SQL || true
CREATE TABLE IF NOT EXISTS backup_jobs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('ok','fail')),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  archive_path TEXT,
  size_bytes INTEGER,
  encrypted INTEGER NOT NULL DEFAULT 0,
  encryption_mode TEXT,
  source TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS backup_jobs_started ON backup_jobs(started_at_ms DESC);
INSERT INTO backup_jobs (status, started_at_ms, ended_at_ms, duration_ms, archive_path, size_bytes, encrypted, encryption_mode, source, error)
VALUES ('${BACKUP_STATUS}', ${START_MS}, ${end_ms}, ${duration_ms}, $(printf "'%s'" "${FINAL_PATH//\'/\'\'}"), ${size_bytes}, ${encrypted_int}, $(printf "'%s'" "${BACKUP_ENCRYPTION//\'/\'\'}"), $(printf "'%s'" "${SOURCE_TAG//\'/\'\'}"), $(printf "'%s'" "${BACKUP_ERROR//\'/\'\'}"));
SQL
}

on_err() {
  BACKUP_STATUS="fail"
  BACKUP_ERROR="line ${BASH_LINENO[0]:-?}: ${BASH_COMMAND:-?}"
  echo "${STAMP} backup: FAILED -- ${BACKUP_ERROR}" >> "${BACKUP_LOG}" 2>/dev/null || true
}
on_exit() {
  rm -f "${REPOLIST}" "${HOMELIST}" "${MANIFEST}"
  rm -rf "${STAGE}"
  write_report
}
trap on_err ERR
trap on_exit EXIT

if [[ ! -s "${REPOLIST}" && ! -s "${HOMELIST}" ]]; then
  echo "backup: nothing to archive" >&2
  exit 0
fi

# --- Manifest (stored at the archive root for self-description). -----------
{
  echo "Marveen backup ${STAMP}"
  echo "host: $(hostname 2>/dev/null || echo '?')   user: ${USER:-?}   home: ${HOME}"
  echo "repo root: ${REPO_ROOT}"
  echo "encryption mode: ${BACKUP_ENCRYPTION}${BACKUP_ENCRYPT_CMD:+ (escape-hatch BACKUP_ENCRYPT_CMD)}"
  echo "Restore: scripts/restore.sh <archive>   # automated, recommended"
  echo "         tar -xpzf <archive> -C <tmp>; copy repo/* -> project root, home/* -> \$HOME.   # manual fallback (none only)"
  echo "See docs/MIGRATION.md for the full runbook (TCC, launchd paths, one-bot-one-poller, venv rebuild)."
  echo "--- repo/ ---"; sed 's,^,repo/,' "${REPOLIST}" 2>/dev/null || true
  echo "--- home/ ---"; sed 's,^,home/,' "${HOMELIST}" 2>/dev/null || true
} > "${MANIFEST}"

# --- Assemble the archive via a staging dir, then one plain tar. -----------
# The repo/ and home/ groups are produced by copying into a staging tree, NOT
# by tar name-substitution: bsdtar's `-s` and GNU tar's `--transform` are
# mutually incompatible (on GNU tar, `-s` is `--same-order` and takes no
# argument), so a substitution-based build is not portable. Staging + a single
# `tar -czf -C "${STAGE}" .` works identically on macOS (bsdtar) and Linux
# (GNU tar). Everything backed up is small (a few MB), so the copy is cheap;
# `cp -pR` preserves modes so the 0600 token files stay private.
cp "${MANIFEST}" "${STAGE}/MANIFEST.txt"

stage_group() {  # stage_group <listfile> <base> <group>
  local list="$1" base="$2" group="$3" rel parent
  [[ -s "${list}" ]] || return 0
  while IFS= read -r rel; do
    [[ -z "${rel}" ]] && continue
    parent="$(dirname "${rel}")"
    mkdir -p "${STAGE}/${group}/${parent}"
    cp -pR "${base}/${rel}" "${STAGE}/${group}/${parent}/"
  done < "${list}"
}

stage_group "${REPOLIST}" "${REPO_ROOT}" repo
stage_group "${HOMELIST}" "${HOME}" home

# Archive only the top-level entries that exist (a group dir is absent when
# its list was empty), so tar never errors on a missing entry and the names
# stay clean (no leading "./").
( cd "${STAGE}" && tar -czf "${ARCHIVE}" MANIFEST.txt \
    $( [[ -d repo ]] && echo repo ) $( [[ -d home ]] && echo home ) )
FINAL_PATH="${ARCHIVE}"

# --- Encryption pipeline. --------------------------------------------------
# Tar is at ${ARCHIVE}. Depending on BACKUP_ENCRYPTION (and the optional
# BACKUP_ENCRYPT_CMD escape-hatch), wrap it or leave it as-is. On success,
# the cleartext tar is replaced by the encrypted output; FINAL_PATH points
# to whatever a restorer must consume. The retention prune below covers
# both .tar.gz and the encrypted variants via a single glob.
if [[ -n "${BACKUP_ENCRYPT_CMD}" ]]; then
  # Escape-hatch: caller-supplied pipeline. Used for gpg/openssl/passphrase or
  # any other tool. The output extension is BACKUP_ENCRYPT_EXT (default .enc).
  OUT="${ARCHIVE}${BACKUP_ENCRYPT_EXT}"
  # shellcheck disable=SC2086 # word-splitting on BACKUP_ENCRYPT_CMD is intentional
  if ! ( eval "${BACKUP_ENCRYPT_CMD}" < "${ARCHIVE}" > "${OUT}" ); then
    rm -f "${OUT}"
    echo "backup: ERROR -- BACKUP_ENCRYPT_CMD failed; the cleartext tar.gz remains at ${ARCHIVE}." >&2
    exit 3
  fi
  # Wipe cleartext after a successful encrypt. shred when available for a
  # secure overwrite; on macOS where shred is absent, fall back to rm.
  command -v shred >/dev/null 2>&1 && shred -u "${ARCHIVE}" 2>/dev/null || rm -f "${ARCHIVE}"
  FINAL_PATH="${OUT}"
elif [[ "${BACKUP_ENCRYPTION}" == "key" ]]; then
  # Built-in age recipient mode. The mentő gép only ever needs the PUBLIC key
  # (encrypt-only); the private key lives off-site with the operator.
  OUT="${ARCHIVE}.age"
  if ! age -r "${BACKUP_AGE_RECIPIENT}" -o "${OUT}" < "${ARCHIVE}"; then
    rm -f "${OUT}"
    echo "backup: ERROR -- age encryption failed (recipient='${BACKUP_AGE_RECIPIENT}'). The cleartext tar.gz remains at ${ARCHIVE}; resolve and re-run." >&2
    exit 3
  fi
  command -v shred >/dev/null 2>&1 && shred -u "${ARCHIVE}" 2>/dev/null || rm -f "${ARCHIVE}"
  FINAL_PATH="${OUT}"
else
  # BACKUP_ENCRYPTION=none. Loud warning: the archive contains plaintext
  # tokens (dashboard bearer, channel bot tokens, project .env). NEVER OK to
  # ship to cloud storage unencrypted.
  echo "backup: WARNING -- BACKUP_ENCRYPTION=none. Archive contains PLAINTEXT TOKENS (dashboard bearer, channel bot tokens, project .env secrets). Strongly consider switching to BACKUP_ENCRYPTION=key with an age recipient -- see docs/MIGRATION.md." >&2
fi

echo "backup: wrote ${FINAL_PATH} ($(wc -c < "${FINAL_PATH}" | awk '{print $1}') bytes; encryption=${BACKUP_ENCRYPTION}${BACKUP_ENCRYPT_CMD:+ via BACKUP_ENCRYPT_CMD})"
{
  echo "${STAMP} backup: ok ${FINAL_PATH} ($(wc -c < "${FINAL_PATH}" | awk '{print $1}') bytes; encryption=${BACKUP_ENCRYPTION})"
} >> "${BACKUP_LOG}" 2>/dev/null || true

# The archive may contain sensitive tokens if BACKUP_ENCRYPTION=none. Keep the
# directory off cloud-sync regardless: even encrypted archives are best kept
# out of providers' indexing.
echo "backup: NOTE -- keep ${BACKUP_DIR} out of cloud-sync folders (iCloud / Dropbox / Google Drive)." >&2

# Keep the newest ${BACKUP_KEEP} archives, drop the rest. Match both plaintext
# (.tar.gz) and encrypted variants so the count stays accurate after the
# encryption mode is changed. nullglob makes a missing glob expand to empty
# instead of the literal pattern, so the prune does not silently swallow real
# entries -- and importantly does not fail the ERR trap on an empty match.
# while-read (not mapfile) for macOS bash 3.2.
{
  shopt -s nullglob
  candidates=(
    "${BACKUP_DIR}"/claudeclaw-*.tar.gz
    "${BACKUP_DIR}"/claudeclaw-*.tar.gz.age
  )
  if [[ -n "${BACKUP_ENCRYPT_EXT}" && "${BACKUP_ENCRYPT_EXT}" != ".age" ]]; then
    candidates+=( "${BACKUP_DIR}"/claudeclaw-*.tar.gz"${BACKUP_ENCRYPT_EXT}" )
  fi
  shopt -u nullglob
}
if (( ${#candidates[@]} > BACKUP_KEEP )); then
  # Sort by mtime descending via ls -1t (input list cannot be empty here, so
  # ls succeeds), drop the keep-window, prune the rest.
  ls -1t "${candidates[@]}" | tail -n +$((BACKUP_KEEP + 1)) | while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    rm -f "${f}"
    echo "backup: pruned $(basename "${f}")"
  done
fi
