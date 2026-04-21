#!/usr/bin/env bash
# Backfill the missing "Authorization: Bearer $(cat store/.dashboard-token)"
# header into curl examples inside existing agents/*/CLAUDE.md files (and the
# top-level CLAUDE.md). Also swaps the stale `tier` parameter for `category`
# in memory-API example bodies. Ships as a one-shot migration for installs
# created before the template fix -- running it is safe and idempotent.

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

AUTH_INLINE = '-H "Authorization: Bearer $(cat ~/ClaudeClaw/store/.dashboard-token)" '
AUTH_BLOCK = '  -H "Authorization: Bearer $(cat ~/ClaudeClaw/store/.dashboard-token)" \\\n'

# Multi-line curl block: "curl ... localhost:3420/api/... \\" followed by -H
# lines, ending with a -d payload. Backfill the Authorization header before -d.
curl_block_re = re.compile(
    r'(curl[^\n]*?(?:http://)?localhost:3420/api/[^\n]*\\\n'
    r'(?:\s*-H\s+[^\n]+\\\n)*)'
    r'(?!\s*-H\s+"Authorization:)'
    r'(\s*-[d]\s+)',
    re.MULTILINE,
)

# Single-line curl that fits on one line. Insert the header right before the
# URL so we don't split a -X POST argument pair.
single_curl_re = re.compile(
    r'(curl[^\n`]*?)(http://localhost:3420/api/(?:memories|daily-log|messages|agents)[^\n`]*)'
)

def fix_single(match):
    prefix, tail = match.group(1), match.group(2)
    whole = prefix + tail
    if 'Authorization:' in whole:
        return whole
    return prefix + AUTH_INLINE + tail

# Inline curls wrapped in backticks (e.g. docs reference).
inline_backtick_re = re.compile(
    r'`(curl[^`]*?http://localhost:3420/api/[^`]*)`'
)

def fix_backtick(match):
    inner = match.group(1)
    if 'Authorization:' in inner:
        return match.group(0)
    patched = re.sub(
        r'(http://localhost:3420/api/)',
        AUTH_INLINE + r'\1',
        inner,
        count=1,
    )
    return f'`{patched}`'

def patch(text: str) -> int:
    original = text
    n1 = 0
    text = curl_block_re.sub(lambda m: (globals().__setitem__('_n1', globals().get('_n1', 0) + 1), m.group(1) + AUTH_BLOCK + m.group(2))[1], text)
    # (simpler: use a counter)
    n1 = len(curl_block_re.findall(original))
    text = single_curl_re.sub(fix_single, text)
    text = inline_backtick_re.sub(fix_backtick, text)
    # Swap stale tier -> category in /api/memories bodies & query strings.
    text = re.sub(r'\\?"tier\\?":\s*\\?"(hot|warm|cold|shared|TIER)\\?"',
                  lambda m: m.group(0).replace('tier', 'category'), text)
    text = re.sub(r'/api/memories\?([^"\'`\n]*&)?tier=', r'/api/memories?\1category=', text)
    if text == original:
        return 0
    p.write_text(text)
    return 1

for arg in sys.argv[1:]:
    p = pathlib.Path(arg)
    if not p.is_file():
        continue
    before = p.read_text()
    changed = patch(before)
    print(f"  {'✓' if changed else '='} {p}")
PYEOF

echo ""
echo "Done. Re-check with: grep -c 'Authorization: Bearer' ${TARGETS[*]}"
