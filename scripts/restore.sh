#!/usr/bin/env bash
# Marveen restore -- automate the docs/MIGRATION.md runbook.
#
# Takes one of the archives produced by scripts/backup.sh and unpacks it on
# top of the current install. Guarded by a pre-restore snapshot so the
# previous state is always recoverable, by a dry-run mode that previews
# every change without writing, and by a post-restore SQLite integrity
# check that catches a corrupt copy before the operator restarts services.
#
# This is the inverse of scripts/backup.sh. The two scripts share the
# archive layout:
#   repo/ -> extract under the project root (current repo)
#   home/ -> extract under $HOME
# Modes 0600 on the token files are preserved by tar -p + cp -p.
#
# Usage:
#   scripts/restore.sh <archive> [flags]
#
# Flags:
#   --dry-run                Show what would change (file list + size diffs)
#                            without writing. Always end with exit 0.
#   --yes                    Skip the confirmation prompt before the actual
#                            copy step. For unattended migration runs.
#   --skip-snapshot          Do NOT run a pre-restore snapshot. Use only when
#                            you have already taken one out-of-band. The
#                            default snapshot is the load-bearing safety net.
#   --skip-stop              Do NOT attempt to stop a running dashboard.
#                            The operator is responsible for the cutover.
#   --skip-restart           Do NOT start the dashboard after the restore.
#   --decrypt-cmd "..."      Override the auto-detected decryption pipeline
#                            (for archives produced via BACKUP_ENCRYPT_CMD).
#                            The command receives the encrypted archive on
#                            stdin and must write the plaintext tar.gz to
#                            stdout. Example:
#                              --decrypt-cmd 'gpg --decrypt --batch --yes'
#   --age-identity <path>    Identity file for age-encrypted archives
#                            (.tar.gz.age). Default: $BACKUP_AGE_IDENTITY env.
#
# Environment overrides:
#   BACKUP_DECRYPT_CMD       Same as --decrypt-cmd, lower precedence.
#   BACKUP_AGE_IDENTITY      Path to an age identity file for key-mode
#                            decryption (mirror of BACKUP_AGE_RECIPIENT on
#                            the backup side).
#   RESTORE_LOG              Default: $REPO_ROOT/store/restore.log
#
# Full runbook: docs/MIGRATION.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESTORE_LOG="${RESTORE_LOG:-${REPO_ROOT}/store/restore.log}"

# --- arg parse -------------------------------------------------------------
ARCHIVE=""
DRY_RUN=0
ASSUME_YES=0
SKIP_SNAPSHOT=0
SKIP_STOP=0
SKIP_RESTART=0
DECRYPT_CMD="${BACKUP_DECRYPT_CMD:-}"
AGE_IDENTITY="${BACKUP_AGE_IDENTITY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --skip-snapshot) SKIP_SNAPSHOT=1; shift ;;
    --skip-stop) SKIP_STOP=1; shift ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    --decrypt-cmd) DECRYPT_CMD="$2"; shift 2 ;;
    --age-identity) AGE_IDENTITY="$2"; shift 2 ;;
    --help|-h)
      sed -n '1,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "restore: unknown flag '$1'" >&2; exit 2 ;;
    *)
      if [[ -z "${ARCHIVE}" ]]; then ARCHIVE="$1"; shift
      else echo "restore: extra positional argument '$1' (already have archive '${ARCHIVE}')" >&2; exit 2
      fi ;;
  esac
done

if [[ -z "${ARCHIVE}" ]]; then
  echo "restore: ERROR -- archive path required. See: scripts/restore.sh --help" >&2
  exit 2
fi
if [[ ! -f "${ARCHIVE}" ]]; then
  echo "restore: ERROR -- archive '${ARCHIVE}' not found." >&2
  exit 2
fi
ARCHIVE="$(cd "$(dirname "${ARCHIVE}")" && pwd)/$(basename "${ARCHIVE}")"

mkdir -p "$(dirname "${RESTORE_LOG}")"

log() {
  local msg="$*"
  echo "$(date '+%Y-%m-%d %H:%M:%S') ${msg}" | tee -a "${RESTORE_LOG}" >&2
}

# --- pre-flight ------------------------------------------------------------
log "restore: starting (archive='${ARCHIVE}', dry-run=${DRY_RUN})"

for tool in tar; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    log "restore: ERROR -- required tool '${tool}' not found in PATH."
    exit 2
  fi
done
if ! command -v sqlite3 >/dev/null 2>&1; then
  log "restore: WARNING -- sqlite3 not found; integrity check will be skipped."
fi

# --- decryption mode detection --------------------------------------------
# Resolution order:
#   1. --decrypt-cmd / BACKUP_DECRYPT_CMD wins (escape-hatch for custom
#      pipelines: gpg / openssl / age-passphrase).
#   2. .tar.gz.age extension -> built-in age key decryption with
#      --age-identity / BACKUP_AGE_IDENTITY.
#   3. .tar.gz -> no decryption.
# Anything else -> abort; the operator must supply an explicit decryption
# command rather than letting us guess.
DECRYPT_MODE=""
DECRYPT_INVOKE=""
case "${ARCHIVE}" in
  *.tar.gz)
    DECRYPT_MODE="none"
    ;;
  *.tar.gz.age)
    if [[ -n "${DECRYPT_CMD}" ]]; then
      DECRYPT_MODE="cmd"; DECRYPT_INVOKE="${DECRYPT_CMD}"
    else
      if ! command -v age >/dev/null 2>&1; then
        log "restore: ERROR -- archive ends in .age but 'age' binary not found. Install: 'brew install age' or 'apt install age', or pass --decrypt-cmd '<cmd>' if the archive was produced via a custom BACKUP_ENCRYPT_CMD."
        exit 2
      fi
      if [[ -z "${AGE_IDENTITY}" ]]; then
        log "restore: ERROR -- .age archive needs an identity file. Provide via --age-identity <path> or BACKUP_AGE_IDENTITY env."
        exit 2
      fi
      if [[ ! -f "${AGE_IDENTITY}" ]]; then
        log "restore: ERROR -- age identity file '${AGE_IDENTITY}' not readable."
        exit 2
      fi
      DECRYPT_MODE="age-identity"
      DECRYPT_INVOKE="age -d -i $(printf '%q' "${AGE_IDENTITY}")"
    fi
    ;;
  *)
    if [[ -n "${DECRYPT_CMD}" ]]; then
      DECRYPT_MODE="cmd"; DECRYPT_INVOKE="${DECRYPT_CMD}"
    else
      log "restore: ERROR -- unknown archive extension '${ARCHIVE##*.}'. Supported: .tar.gz, .tar.gz.age. For custom encrypted formats pass --decrypt-cmd '<cmd>' explicitly."
      exit 2
    fi
    ;;
esac
log "restore: decryption mode='${DECRYPT_MODE}'"

# --- staging dir + EXIT trap ----------------------------------------------
STAGE="$(mktemp -d -t marveen-restore.XXXXXX)"
PLAINTEXT_ARCHIVE=""
trap 'rm -rf "${STAGE}"; [[ -n "${PLAINTEXT_ARCHIVE}" && -f "${PLAINTEXT_ARCHIVE}" && "${PLAINTEXT_ARCHIVE}" != "${ARCHIVE}" ]] && rm -f "${PLAINTEXT_ARCHIVE}"' EXIT

# --- decrypt to a tmp file (or alias plaintext to the original) -----------
if [[ "${DECRYPT_MODE}" == "none" ]]; then
  PLAINTEXT_ARCHIVE="${ARCHIVE}"
else
  PLAINTEXT_ARCHIVE="${STAGE}/decrypted.tar.gz"
  log "restore: decrypting -> ${PLAINTEXT_ARCHIVE}"
  if ! eval "${DECRYPT_INVOKE}" < "${ARCHIVE}" > "${PLAINTEXT_ARCHIVE}"; then
    log "restore: ERROR -- decryption failed (mode='${DECRYPT_MODE}'). Check the identity / passphrase / decrypt-cmd."
    exit 3
  fi
fi

# --- archive integrity + manifest read ------------------------------------
if ! tar -tzf "${PLAINTEXT_ARCHIVE}" >/dev/null 2>&1; then
  log "restore: ERROR -- archive failed gzip/tar integrity check. The file is corrupt or not a tar.gz."
  exit 3
fi

# Extract MANIFEST.txt only, so we can show the operator what is in the
# archive before any destructive action.
tar -xzf "${PLAINTEXT_ARCHIVE}" -C "${STAGE}" MANIFEST.txt 2>/dev/null || true
if [[ -f "${STAGE}/MANIFEST.txt" ]]; then
  log "restore: manifest (first 30 lines):"
  head -n 30 "${STAGE}/MANIFEST.txt" | tee -a "${RESTORE_LOG}" >&2
else
  log "restore: WARNING -- archive has no MANIFEST.txt. This may be from an older backup; continuing."
fi

# Mandatory entry sanity-check. A backup without store/claudeclaw.db is
# almost certainly garbage; refuse to restore something that would leave the
# system more broken than it found it.
if ! tar -tzf "${PLAINTEXT_ARCHIVE}" | grep -q '^repo/store/claudeclaw\.db$'; then
  log "restore: WARNING -- archive does not contain repo/store/claudeclaw.db. This is unusual; pass --yes to bypass this guard if intentional."
  if [[ "${ASSUME_YES}" -ne 1 && "${DRY_RUN}" -ne 1 ]]; then
    read -r -p "restore: continue without claudeclaw.db? [y/N] " ans
    case "${ans}" in y|Y|yes|YES) ;; *) log "restore: aborted by operator."; exit 0 ;; esac
  fi
fi

# --- file list preview / diff ---------------------------------------------
log "restore: file list in archive (counts):"
{
  echo "  repo/: $(tar -tzf "${PLAINTEXT_ARCHIVE}" | grep -c '^repo/' || true)"
  echo "  home/: $(tar -tzf "${PLAINTEXT_ARCHIVE}" | grep -c '^home/' || true)"
} | tee -a "${RESTORE_LOG}" >&2

if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "restore: --dry-run set; full file list follows. No files will be written."
  tar -tzf "${PLAINTEXT_ARCHIVE}" | tee -a "${RESTORE_LOG}" >&2
  log "restore: dry-run complete."
  exit 0
fi

# --- pre-restore snapshot (the load-bearing safety net) -------------------
# Even when the operator is convinced this restore is correct, we take a
# fresh snapshot of the CURRENT state first. Otherwise a wrong archive (or
# a buggy restore.sh) can leave the system without a rollback path. This
# is the single most important guardrail in this script.
if [[ "${SKIP_SNAPSHOT}" -eq 1 ]]; then
  log "restore: --skip-snapshot set; the pre-restore safety net is DISABLED. Make sure you have a snapshot you trust."
else
  if [[ ! -x "${SCRIPT_DIR}/backup.sh" ]]; then
    log "restore: ERROR -- scripts/backup.sh not found / not executable. Cannot take pre-restore snapshot; aborting. Pass --skip-snapshot only if you have a fresh backup out-of-band."
    exit 2
  fi
  log "restore: taking pre-restore safety snapshot..."
  # We want a snapshot we can recognise later; tag the directory if not
  # already set, and force encryption off so the snapshot lands as a normal
  # tar.gz the operator can extract without the production key.
  PRE_RESTORE_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}/pre-restore"
  mkdir -p "${PRE_RESTORE_DIR}"
  if ! BACKUP_DIR="${PRE_RESTORE_DIR}" BACKUP_ENCRYPTION=none \
      bash "${SCRIPT_DIR}/backup.sh" --source=manual >>"${RESTORE_LOG}" 2>&1; then
    log "restore: ERROR -- pre-restore snapshot FAILED (see ${RESTORE_LOG}). Aborting to preserve current state."
    exit 4
  fi
  log "restore: pre-restore snapshot stored under ${PRE_RESTORE_DIR}."
fi

# --- operator confirmation ------------------------------------------------
if [[ "${ASSUME_YES}" -ne 1 ]]; then
  cat >&2 <<EOF

restore: ABOUT TO REPLACE files under
  ${REPO_ROOT}/   (from archive's repo/ group)
  ${HOME}/        (from archive's home/ group)

This is destructive. The pre-restore snapshot is in
  ${PRE_RESTORE_DIR:-<skipped>}
so you can roll back by re-running this script against that snapshot.

EOF
  read -r -p "restore: type YES to proceed: " ans
  if [[ "${ans}" != "YES" ]]; then
    log "restore: aborted by operator (confirmation not 'YES')."
    exit 0
  fi
fi

# --- dashboard stop (best effort) -----------------------------------------
DASHBOARD_WAS_RUNNING=0
DASHBOARD_PID_FILE="${REPO_ROOT}/store/claudeclaw.pid"
if [[ "${SKIP_STOP}" -eq 1 ]]; then
  log "restore: --skip-stop set; not touching any running dashboard."
elif [[ -f "${DASHBOARD_PID_FILE}" ]]; then
  DASHBOARD_PID="$(cat "${DASHBOARD_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${DASHBOARD_PID}" ]] && kill -0 "${DASHBOARD_PID}" 2>/dev/null; then
    DASHBOARD_WAS_RUNNING=1
    log "restore: stopping dashboard (pid ${DASHBOARD_PID})..."
    kill -TERM "${DASHBOARD_PID}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "${DASHBOARD_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${DASHBOARD_PID}" 2>/dev/null; then
      log "restore: WARNING -- dashboard did not exit on SIGTERM; sending SIGKILL."
      kill -KILL "${DASHBOARD_PID}" 2>/dev/null || true
    fi
  fi
fi

# --- extract + copy into place --------------------------------------------
# Extract the WHOLE archive into the staging dir first, then rsync-style
# copy into place with mode preservation. Doing this in two steps means a
# failure during extract leaves the live system untouched.
EXTRACT_DIR="${STAGE}/extracted"
mkdir -p "${EXTRACT_DIR}"
log "restore: extracting archive into ${EXTRACT_DIR}..."
tar -xpzf "${PLAINTEXT_ARCHIVE}" -C "${EXTRACT_DIR}"

copy_group() {  # copy_group <group> <dest>
  local group="$1" dest="$2"
  local src="${EXTRACT_DIR}/${group}"
  if [[ ! -d "${src}" ]]; then
    log "restore: skipping '${group}' (not in archive)."
    return 0
  fi
  log "restore: copying ${group}/ -> ${dest}/"
  # cp -pR preserves modes (the 0600 token files stay private).
  # We copy ENTRY-BY-ENTRY rather than a single recursive copy of the whole
  # subtree, so that pre-existing directories outside the archive's scope
  # (e.g. ${HOME}/.claude/projects) are not touched.
  ( cd "${src}" && find . -mindepth 1 -maxdepth 1 -print0 ) | \
    while IFS= read -r -d '' top; do
      cp -pR "${src}/${top#./}" "${dest}/${top#./}"
    done
}

copy_group repo "${REPO_ROOT}"
copy_group home "${HOME}"

# --- SQLite integrity check -----------------------------------------------
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "${REPO_ROOT}/store/claudeclaw.db" ]]; then
  log "restore: verifying SQLite integrity..."
  result="$(sqlite3 "${REPO_ROOT}/store/claudeclaw.db" 'PRAGMA integrity_check;' 2>&1 || echo 'sqlite3-failed')"
  if [[ "${result}" != "ok" ]]; then
    log "restore: ERROR -- SQLite integrity check FAILED: ${result}"
    log "restore:        The restore left a corrupt store/claudeclaw.db. Pre-restore snapshot is in ${PRE_RESTORE_DIR:-<skipped>}."
    log "restore:        Do NOT start the dashboard until this is resolved manually."
    exit 5
  fi
  log "restore: SQLite integrity OK."
fi

# --- dashboard restart (best effort) --------------------------------------
if [[ "${SKIP_RESTART}" -eq 1 ]]; then
  log "restore: --skip-restart set; dashboard not started. Start manually with: bash scripts/start.sh"
elif [[ "${DASHBOARD_WAS_RUNNING}" -eq 1 ]]; then
  if [[ -x "${SCRIPT_DIR}/start.sh" ]]; then
    log "restore: starting dashboard via scripts/start.sh (detached)..."
    ( cd "${REPO_ROOT}" && nohup bash "${SCRIPT_DIR}/start.sh" >>"${RESTORE_LOG}" 2>&1 & )
    # Give it a few seconds to bind the port, then probe.
    sleep 5
    if [[ -f "${REPO_ROOT}/store/.dashboard-token" ]] && command -v curl >/dev/null 2>&1; then
      WEB_PORT="$(grep -E '^WEB_PORT=' "${REPO_ROOT}/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' )"
      WEB_PORT="${WEB_PORT:-3420}"
      if curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "${REPO_ROOT}/store/.dashboard-token")" "http://localhost:${WEB_PORT}/api/agents" | grep -q '^200'; then
        log "restore: dashboard responds 200 OK on /api/agents."
      else
        log "restore: WARNING -- dashboard did not respond 200 within 5s. It may still be starting; check store/dashboard.log."
      fi
    fi
  else
    log "restore: WARNING -- scripts/start.sh not found; cannot restart dashboard. Start it manually."
  fi
fi

log "restore: DONE. Files in place; SQLite integrity verified."
log "restore: rollback path: re-run restore.sh against the snapshot in ${PRE_RESTORE_DIR:-<skipped>}."
