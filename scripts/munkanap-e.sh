#!/usr/bin/env bash
# munkanap-e.sh -- eldönti, hogy MA magyar munkanap-e (Europe/Budapest).
# Kimenet: "MUNKANAP: <indok>" (exit 0) vagy "PIHENONAP: <indok>" (exit 1).
# A reggeli napindító ezt hívja: pihenőnapon csendben kilép, nem küld napindítót.
#
# Logika (precedencia):
#   1. áthelyezett munkanap (ledolgozós szombat) -> MUNKANAP (akkor is, ha szombat)
#   2. munkaszüneti nap (ünnep)                  -> PIHENONAP (akkor is, ha hétköznap)
#   3. áthelyezett pihenőnap                      -> PIHENONAP
#   4. hétvége (szo/vas)                          -> PIHENONAP
#   5. egyébként                                  -> MUNKANAP
#
# A naptár évente frissül: store/munkanaptar-<év>.json. Ha az évre nincs naptár,
# csak a hétvége-szabály érvényesül + figyelmeztet (az ünnepeket nem ismeri).

set -euo pipefail

STORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../store" && pwd)"
# Opcionális $1 = teszt-dátum (YYYY-MM-DD); enélkül a mai nap (Europe/Budapest).
if [[ -n "${1:-}" ]]; then
  TODAY="$1"
  YEAR="$(date -d "$1" +%Y)"
  DOW="$(date -d "$1" +%u)"
else
  TODAY="$(TZ=Europe/Budapest date +%Y-%m-%d)"
  YEAR="$(TZ=Europe/Budapest date +%Y)"
  DOW="$(TZ=Europe/Budapest date +%u)"   # 1=hétfő ... 6=szombat, 7=vasárnap
fi
CAL="$STORE_DIR/munkanaptar-$YEAR.json"

if [[ ! -f "$CAL" ]]; then
  # Nincs naptár erre az évre -> csak hétvége-szabály, ünnep nélkül.
  if [[ "$DOW" -ge 6 ]]; then
    echo "PIHENONAP: hétvége (nincs $YEAR-os munkanaptár, csak hétvége-szabály)"
    exit 1
  fi
  echo "MUNKANAP: hétköznap (FIGYELEM: nincs $YEAR-os munkanaptár, ünnepeket nem ellenőriz -- frissítsd: store/munkanaptar-$YEAR.json)"
  exit 0
fi

# 1. áthelyezett munkanap (ledolgozós szombat) -> munkanap
if jq -e --arg d "$TODAY" '.athelyezett_munkanapok[$d]' "$CAL" >/dev/null 2>&1; then
  echo "MUNKANAP: $(jq -r --arg d "$TODAY" '.athelyezett_munkanapok[$d]' "$CAL")"
  exit 0
fi

# 2. munkaszüneti nap (ünnep) -> pihenő
if jq -e --arg d "$TODAY" '.munkaszuneti_napok[$d]' "$CAL" >/dev/null 2>&1; then
  echo "PIHENONAP: $(jq -r --arg d "$TODAY" '.munkaszuneti_napok[$d]' "$CAL") (munkaszüneti nap)"
  exit 1
fi

# 3. áthelyezett pihenőnap -> pihenő
if jq -e --arg d "$TODAY" '.athelyezett_pihenonapok[$d]' "$CAL" >/dev/null 2>&1; then
  echo "PIHENONAP: $(jq -r --arg d "$TODAY" '.athelyezett_pihenonapok[$d]' "$CAL")"
  exit 1
fi

# 4. hétvége -> pihenő
if [[ "$DOW" -ge 6 ]]; then
  echo "PIHENONAP: hétvége"
  exit 1
fi

# 5. rendes munkanap
echo "MUNKANAP: rendes hétköznap"
exit 0
