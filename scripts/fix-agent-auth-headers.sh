#!/usr/bin/env bash
# Backfill the missing "Authorization: Bearer $(cat store/.dashboard-token)"
# header into curl examples inside existing agents/*/CLAUDE.md files (and the
# top-level CLAUDE.md). Ships as a one-shot migration for installs created
# before the template fix -- running it is safe and idempotent.

set -e

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

TARGETS=()
[ -f "CLAUDE.md" ] && TARGETS+=("CLAUDE.md")
while IFS= read -r f; do TARGETS+=("$f"); done < <(find agents -name "CLAUDE.md" 2>/dev/null || true)

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "No CLAUDE.md files found under agents/ or project root."
  exit 0
fi

python3 - "${TARGETS[@]}" <<'PYEOF'
import re, sys, pathlib

AUTH = '  -H "Authorization: Bearer $(cat store/.dashboard-token)" \\\n'

# Pattern: a curl line targeting localhost:3420/api/... where the block
# doesn't already contain Authorization before the -d / closing quote.
curl_block_re = re.compile(
    r'(curl[^\n]*?(?:http://)?localhost:3420/api/[^\n]*\\\n'
    r'(?:\s*-H\s+[^\n]+\\\n)*)'
    r'(?!\s*-H\s+"Authorization:)'
    r'(\s*-[d]\s+)',
    re.MULTILINE,
)

inline_curl_re = re.compile(
    r'`(curl[^`]*?http://localhost:3420/api/[^`]*)`'
)

def inject_inline(match: re.Match) -> str:
    inner = match.group(1)
    if 'Authorization:' in inner:
        return match.group(0)
    patched = re.sub(r'(curl\s+(?:-[a-zA-Z]+\s+)*)',
                     r'\1-H "Authorization: Bearer $(cat store/.dashboard-token)" ',
                     inner,
                     count=1)
    return f'`{patched}`'

def patch(text: str) -> tuple[str, int]:
    new, n1 = curl_block_re.subn(lambda m: m.group(1) + AUTH + m.group(2), text)
    new, n2 = inline_curl_re.subn(inject_inline, new)
    return new, n1 + n2

for arg in sys.argv[1:]:
    p = pathlib.Path(arg)
    if not p.is_file():
        continue
    original = p.read_text()
    patched, count = patch(original)
    if count == 0:
        print(f"  = {p} (no changes)")
        continue
    p.write_text(patched)
    print(f"  ✓ {p} (patched {count} curl block{'s' if count != 1 else ''})")
PYEOF

echo ""
echo "Done. Re-check with: grep -c 'Authorization: Bearer' ${TARGETS[*]}"
