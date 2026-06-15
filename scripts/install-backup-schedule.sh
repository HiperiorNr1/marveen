#!/usr/bin/env bash
# Marveen backup scheduler -- OS-aware installer for the daily backup.
#
# Marveen tracks scheduled tasks for agents at ~/.claude/scheduled-tasks/,
# but a system-level backup does not need an agent context: it is a
# self-contained shell script. Wake an agent every night to run it would
# burn tokens and queue behind whatever else the agent is doing. Instead,
# this script installs an OS-native timer that runs `scripts/backup.sh
# --report --source=scheduled` on a cron schedule. The --report flag pipes
# the result into store/claudeclaw.db backup_jobs so the dashboard sees the
# run regardless of whether an agent ever fired.
#
# Backends, in preference order:
#   1. systemd --user (Linux)   -- a user.timer + user.service unit pair
#   2. launchd      (macOS)     -- a ~/Library/LaunchAgents/*.plist
#   3. crontab      (anywhere)  -- appended entry, fallback when nothing else
#
# Usage:
#   install-backup-schedule.sh [--uninstall|--status]
#                              [--schedule "<cron>"] [--backend <name>]
#                              [--dry-run]
#
# Flags:
#   --uninstall                Remove the schedule (any backend).
#   --status                   Print which backend is installed + next firing.
#   --schedule "<cron-5-field>"  Default: '0 3 * * *' (03:00 daily). Only
#                              simple expressions are supported on systemd
#                              (mapped to OnCalendar); for full cron syntax
#                              use --backend crontab.
#   --backend systemd|launchd|crontab
#                              Override the auto-detection. Mostly for tests.
#   --dry-run                  Print what would be installed/removed, exit 0.
#
# Encryption: NOT a flag of this script. backup.sh reads BACKUP_ENCRYPTION
# and BACKUP_AGE_RECIPIENT (and the rest of BACKUP_*) from the project .env
# at start-up, so the timer just runs the script and inherits whatever the
# .env says. To enable key-mode encryption, edit .env:
#     BACKUP_ENCRYPTION=key
#     BACKUP_AGE_RECIPIENT=age1xxxxxxx...
# and the next timer fire picks it up. See docs/MIGRATION.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_SCRIPT="${REPO_ROOT}/scripts/backup.sh"
LABEL="marveen-backup"
SYSTEMD_UNIT_DIR="${HOME}/.config/systemd/user"
SYSTEMD_SERVICE="${LABEL}.service"
SYSTEMD_TIMER="${LABEL}.timer"
LAUNCHD_LABEL="com.marveen.backup"
LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
LAUNCHD_LOG_DIR="${REPO_ROOT}/store"
CRONTAB_TAG="# marveen-backup -- managed by scripts/install-backup-schedule.sh"

# Resolve MAIN_AGENT_ID via the same logic backup.sh uses, so the launchd
# label namespace matches the rest of the fleet on hosts that customized it.
MAIN_AGENT_ID="marveen"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  _mid="$(grep -E '^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=' "${REPO_ROOT}/.env" 2>/dev/null \
    | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
  [[ -n "${_mid}" ]] && MAIN_AGENT_ID="${_mid}"
fi
LAUNCHD_LABEL="com.${MAIN_AGENT_ID}.backup"
LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"

# --- arg parse -------------------------------------------------------------
MODE="install"
SCHEDULE="0 3 * * *"
BACKEND=""
DRY_RUN=0

# Encryption config is NOT injected into the timer environment. backup.sh
# resolves BACKUP_ENCRYPTION / BACKUP_AGE_RECIPIENT (and the other BACKUP_*
# keys) from the project .env at start-up, so every invocation path -- this
# scheduled timer, the manual `bash scripts/backup.sh`, the dashboard
# trigger -- sees the same config from one source. To enable encryption,
# put `BACKUP_ENCRYPTION=key` + `BACKUP_AGE_RECIPIENT=age1...` in .env
# (see docs/MIGRATION.md) and re-install the timer; nothing about THIS
# script changes.

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) MODE="uninstall"; shift ;;
    --status) MODE="status"; shift ;;
    --schedule) SCHEDULE="$2"; shift 2 ;;
    --schedule=*) SCHEDULE="${1#--schedule=}"; shift ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --backend=*) BACKEND="${1#--backend=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h)
      sed -n '1,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "install-backup-schedule: unknown flag '$1'" >&2; exit 2 ;;
  esac
done

if [[ ! -x "${BACKUP_SCRIPT}" ]]; then
  echo "install-backup-schedule: ERROR -- ${BACKUP_SCRIPT} not found or not executable." >&2
  exit 2
fi

# --- backend detection ----------------------------------------------------
detect_backend() {
  if [[ -n "${BACKEND}" ]]; then
    echo "${BACKEND}"
    return
  fi
  case "$(uname -s)" in
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user --quiet status >/dev/null 2>&1; then
        echo systemd; return
      fi
      ;;
    Darwin)
      if command -v launchctl >/dev/null 2>&1; then
        echo launchd; return
      fi
      ;;
  esac
  if command -v crontab >/dev/null 2>&1; then
    echo crontab; return
  fi
  echo none
}

# --- cron -> systemd OnCalendar mapping ----------------------------------
# Supports the common simple cases: "0 H * * *" (daily at H:M), "M H * * *"
# (daily at H:M), "M H * * D" (weekly), "M H D * *" (monthly). Falls back
# to crontab for anything more complex.
cron_to_oncalendar() {
  local cron="$1"
  read -r MM HH DD MO DOW <<<"${cron}"
  if [[ ! "${MM}" =~ ^[0-9]+$ || ! "${HH}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  local time
  printf -v time "%02d:%02d:00" "${HH}" "${MM}"
  if [[ "${DD}" == "*" && "${MO}" == "*" && "${DOW}" == "*" ]]; then
    echo "*-*-* ${time}"; return 0
  fi
  if [[ "${DD}" == "*" && "${MO}" == "*" && "${DOW}" =~ ^[0-9]+$ ]]; then
    local days=(Sun Mon Tue Wed Thu Fri Sat)
    echo "${days[${DOW}]} *-*-* ${time}"; return 0
  fi
  if [[ "${MO}" == "*" && "${DOW}" == "*" && "${DD}" =~ ^[0-9]+$ ]]; then
    printf -v dd "%02d" "${DD}"
    echo "*-*-${dd} ${time}"; return 0
  fi
  return 1
}

# --- systemd backend ------------------------------------------------------
write_systemd_units() {
  local oncal="$1"
  mkdir -p "${SYSTEMD_UNIT_DIR}"
  # backup.sh self-resolves BACKUP_* from .env (see docs/MIGRATION.md);
  # nothing about encryption needs to be baked into the unit file. To enable
  # encryption, edit .env and the next timer fire picks it up.
  cat > "${SYSTEMD_UNIT_DIR}/${SYSTEMD_SERVICE}" <<EOF
[Unit]
Description=Marveen backup (scripts/backup.sh --report --source=scheduled)
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${REPO_ROOT}
ExecStart=/usr/bin/env bash ${BACKUP_SCRIPT} --report --source=scheduled
# Run with a tame nice + ionice so a 3am backup never starves the dashboard.
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
# The script appends to its own log; service stdout/stderr go to journald.
StandardOutput=journal
StandardError=journal
EOF
  cat > "${SYSTEMD_UNIT_DIR}/${SYSTEMD_TIMER}" <<EOF
[Unit]
Description=Marveen backup timer
Requires=${SYSTEMD_SERVICE}

[Timer]
OnCalendar=${oncal}
Persistent=true
Unit=${SYSTEMD_SERVICE}

[Install]
WantedBy=timers.target
EOF
}

install_systemd() {
  local oncal
  if ! oncal="$(cron_to_oncalendar "${SCHEDULE}")"; then
    echo "install-backup-schedule: ERROR -- cron expression '${SCHEDULE}' cannot be mapped to OnCalendar; pass --backend crontab to install via cron instead." >&2
    exit 2
  fi
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would write ${SYSTEMD_UNIT_DIR}/${SYSTEMD_SERVICE}"
    echo "[dry-run] would write ${SYSTEMD_UNIT_DIR}/${SYSTEMD_TIMER}  (OnCalendar=${oncal})"
    echo "[dry-run] would: systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_TIMER}"
    return 0
  fi
  write_systemd_units "${oncal}"
  systemctl --user daemon-reload
  systemctl --user enable --now "${SYSTEMD_TIMER}"
  echo "install-backup-schedule: installed systemd timer (OnCalendar=${oncal}). Next firing:"
  systemctl --user list-timers "${SYSTEMD_TIMER}" --no-pager || true
}

uninstall_systemd() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would: systemctl --user disable --now ${SYSTEMD_TIMER}; rm ${SYSTEMD_UNIT_DIR}/${SYSTEMD_TIMER} ${SYSTEMD_UNIT_DIR}/${SYSTEMD_SERVICE}"
    return 0
  fi
  systemctl --user disable --now "${SYSTEMD_TIMER}" 2>/dev/null || true
  rm -f "${SYSTEMD_UNIT_DIR}/${SYSTEMD_TIMER}" "${SYSTEMD_UNIT_DIR}/${SYSTEMD_SERVICE}"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "install-backup-schedule: removed systemd timer + service for ${LABEL}."
}

status_systemd() {
  if [[ -f "${SYSTEMD_UNIT_DIR}/${SYSTEMD_TIMER}" ]]; then
    systemctl --user list-timers "${SYSTEMD_TIMER}" --no-pager || true
    systemctl --user is-enabled "${SYSTEMD_TIMER}" 2>/dev/null || true
  else
    echo "install-backup-schedule: no systemd timer installed."
  fi
}

# --- launchd backend ------------------------------------------------------
launchd_calendar_xml() {
  # Map a simple "M H * * *" cron to StartCalendarInterval entries. For full
  # cron syntax, advise crontab.
  local cron="$1"
  read -r MM HH DD MO DOW <<<"${cron}"
  if [[ ! "${MM}" =~ ^[0-9]+$ || ! "${HH}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  cat <<EOF
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key><integer>${HH}</integer>
      <key>Minute</key><integer>${MM}</integer>
EOF
  if [[ "${DOW}" =~ ^[0-9]+$ ]]; then
    echo "      <key>Weekday</key><integer>${DOW}</integer>"
  fi
  if [[ "${DD}" =~ ^[0-9]+$ ]]; then
    echo "      <key>Day</key><integer>${DD}</integer>"
  fi
  cat <<EOF
    </dict>
EOF
}

install_launchd() {
  local cal
  if ! cal="$(launchd_calendar_xml "${SCHEDULE}")"; then
    echo "install-backup-schedule: ERROR -- cron expression '${SCHEDULE}' cannot be mapped to launchd StartCalendarInterval; pass --backend crontab instead." >&2
    exit 2
  fi
  # backup.sh self-resolves BACKUP_* from .env (see docs/MIGRATION.md); the
  # plist carries no encryption-related EnvironmentVariables.
  local plist_content
  plist_content="$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${BACKUP_SCRIPT}</string>
    <string>--report</string>
    <string>--source=scheduled</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>
${cal}
  <key>StandardOutPath</key><string>${LAUNCHD_LOG_DIR}/backups.launchd.out.log</string>
  <key>StandardErrorPath</key><string>${LAUNCHD_LOG_DIR}/backups.launchd.err.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF
  )"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would write ${LAUNCHD_PLIST}"
    echo "${plist_content}"
    echo "[dry-run] would: launchctl unload ${LAUNCHD_PLIST} 2>/dev/null; launchctl load ${LAUNCHD_PLIST}"
    return 0
  fi
  mkdir -p "$(dirname "${LAUNCHD_PLIST}")"
  echo "${plist_content}" > "${LAUNCHD_PLIST}"
  launchctl unload "${LAUNCHD_PLIST}" 2>/dev/null || true
  launchctl load "${LAUNCHD_PLIST}"
  echo "install-backup-schedule: installed launchd plist at ${LAUNCHD_PLIST}."
}

uninstall_launchd() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would: launchctl unload ${LAUNCHD_PLIST}; rm ${LAUNCHD_PLIST}"
    return 0
  fi
  launchctl unload "${LAUNCHD_PLIST}" 2>/dev/null || true
  rm -f "${LAUNCHD_PLIST}"
  echo "install-backup-schedule: removed launchd plist ${LAUNCHD_PLIST}."
}

status_launchd() {
  if [[ -f "${LAUNCHD_PLIST}" ]]; then
    launchctl list "${LAUNCHD_LABEL}" 2>/dev/null || true
  else
    echo "install-backup-schedule: no launchd plist installed."
  fi
}

# --- crontab backend ------------------------------------------------------
crontab_line() {
  # backup.sh self-resolves BACKUP_* from .env (see docs/MIGRATION.md); no
  # inline env prefix needed. The cron line just `cd`s into the repo so the
  # script's REPO_ROOT discovery is right and .env is picked up.
  echo "${SCHEDULE} cd ${REPO_ROOT} && /bin/bash ${BACKUP_SCRIPT} --report --source=scheduled >> ${REPO_ROOT}/store/backups.log 2>&1 ${CRONTAB_TAG}"
}

install_crontab() {
  local line
  line="$(crontab_line)"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would append to user crontab:"
    echo "  ${line}"
    return 0
  fi
  # Filter out any pre-existing managed entries before appending the new one
  # (idempotent). Tolerate an empty crontab.
  local existing
  existing="$(crontab -l 2>/dev/null || true)"
  printf '%s\n' "${existing}" | grep -v -F "${CRONTAB_TAG}" | { cat; echo "${line}"; } | crontab -
  echo "install-backup-schedule: installed crontab entry."
}

uninstall_crontab() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would remove the managed crontab entry tagged '${CRONTAB_TAG}'."
    return 0
  fi
  local existing
  existing="$(crontab -l 2>/dev/null || true)"
  if [[ -z "${existing}" ]]; then
    echo "install-backup-schedule: no crontab to clean."
    return 0
  fi
  printf '%s\n' "${existing}" | grep -v -F "${CRONTAB_TAG}" | crontab -
  echo "install-backup-schedule: removed managed crontab entry."
}

status_crontab() {
  crontab -l 2>/dev/null | grep -F "${CRONTAB_TAG}" || echo "install-backup-schedule: no managed crontab entry."
}

# --- dispatch -------------------------------------------------------------
BACKEND_RESOLVED="$(detect_backend)"
if [[ "${BACKEND_RESOLVED}" == "none" ]]; then
  echo "install-backup-schedule: ERROR -- no supported scheduler found (need systemd --user, launchd, or crontab)." >&2
  exit 2
fi
echo "install-backup-schedule: backend=${BACKEND_RESOLVED} mode=${MODE} schedule='${SCHEDULE}'"

case "${MODE}:${BACKEND_RESOLVED}" in
  install:systemd)    install_systemd ;;
  install:launchd)    install_launchd ;;
  install:crontab)    install_crontab ;;
  uninstall:systemd)  uninstall_systemd ;;
  uninstall:launchd)  uninstall_launchd ;;
  uninstall:crontab)  uninstall_crontab ;;
  status:systemd)     status_systemd ;;
  status:launchd)     status_launchd ;;
  status:crontab)     status_crontab ;;
  *) echo "install-backup-schedule: ERROR -- unsupported mode/backend pair '${MODE}/${BACKEND_RESOLVED}'." >&2; exit 2 ;;
esac
