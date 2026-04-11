#!/bin/bash
# Marveen Memory Import
# Imports memories from external sources with AI categorization

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
DIM='\033[2m'
NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
API="http://localhost:3420/api"
OLLAMA="http://localhost:11434"

echo ""
echo -e "${BOLD}Marveen Memory Import${NC}"
echo ""

SOURCE="$1"
AGENT="${2:-marveen}"

if [ -z "$SOURCE" ]; then
  echo "Hasznalat: ./scripts/import-memory.sh <forras_utvonal> [agent_id]"
  echo ""
  echo "Tamogatott formatumok:"
  echo "  - Mappa (rekurzivan beolvassa az .md, .txt, .json fajlokat)"
  echo "  - Egyetlen .md fajl"
  echo "  - Egyetlen .json fajl"
  echo "  - Egyetlen .txt fajl"
  echo "  - SQLite .db fajl (memories tabla)"
  echo ""
  echo "Pelda: ./scripts/import-memory.sh ~/openclaw/workspace marveen"
  exit 1
fi

if [ ! -e "$SOURCE" ]; then
  echo "Hiba: $SOURCE nem letezik"
  exit 1
fi

echo -e "Forras: ${BOLD}$SOURCE${NC}"
echo -e "Agens: ${BOLD}$AGENT${NC}"
echo ""

# Collect all text chunks from the source
CHUNKS_FILE="/tmp/marveen-import-chunks.json"
echo "[]" > "$CHUNKS_FILE"

collect_markdown() {
  local file="$1"
  python3 -c "
import json, sys, re

with open('$file', 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Split by headings
sections = re.split(r'\n(?=##?\s)', content)
chunks = []
for section in sections:
    text = section.strip()
    if len(text) > 20:  # Skip tiny fragments
        chunks.append(text[:2000])  # Max 2000 chars per chunk

# Append to existing chunks
with open('$CHUNKS_FILE', 'r') as f:
    existing = json.load(f)
existing.extend(chunks)
with open('$CHUNKS_FILE', 'w') as f:
    json.dump(existing, f)

print(f'  {len(chunks)} chunk')
"
}

collect_json() {
  local file="$1"
  python3 -c "
import json

with open('$file', 'r', encoding='utf-8', errors='ignore') as f:
    data = json.load(f)

chunks = []
if isinstance(data, list):
    for item in data:
        if isinstance(item, dict):
            text = item.get('content', item.get('text', item.get('value', str(item))))
        else:
            text = str(item)
        if len(str(text).strip()) > 20:
            chunks.append(str(text)[:2000])
elif isinstance(data, dict):
    for key, value in data.items():
        text = f'{key}: {value}'
        if len(text.strip()) > 20:
            chunks.append(text[:2000])

with open('$CHUNKS_FILE', 'r') as f:
    existing = json.load(f)
existing.extend(chunks)
with open('$CHUNKS_FILE', 'w') as f:
    json.dump(existing, f)

print(f'  {len(chunks)} chunk')
"
}

collect_text() {
  local file="$1"
  python3 -c "
import json

with open('$file', 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Split by double newlines (paragraphs)
paragraphs = [p.strip() for p in content.split('\n\n') if len(p.strip()) > 20]
chunks = [p[:2000] for p in paragraphs]

with open('$CHUNKS_FILE', 'r') as f:
    existing = json.load(f)
existing.extend(chunks)
with open('$CHUNKS_FILE', 'w') as f:
    json.dump(existing, f)

print(f'  {len(chunks)} chunk')
"
}

collect_sqlite() {
  local file="$1"
  python3 -c "
import json, sqlite3

conn = sqlite3.connect('$file')
chunks = []

# Try common table names
for table in ['memories', 'memory', 'notes', 'entries']:
    try:
        rows = conn.execute(f'SELECT * FROM {table}').fetchall()
        cols = [d[0] for d in conn.execute(f'SELECT * FROM {table}').description]
        content_col = None
        for c in ['content', 'text', 'body', 'value', 'note']:
            if c in cols:
                content_col = cols.index(c)
                break
        if content_col is None:
            content_col = min(1, len(cols)-1)
        for row in rows:
            text = str(row[content_col]).strip()
            if len(text) > 20:
                chunks.append(text[:2000])
        print(f'  Tabla: {table}, {len(chunks)} chunk')
        break
    except:
        continue

conn.close()

with open('$CHUNKS_FILE', 'r') as f:
    existing = json.load(f)
existing.extend(chunks)
with open('$CHUNKS_FILE', 'w') as f:
    json.dump(existing, f)
"
}

echo -e "Fajlok beolvasasa..."

if [ -d "$SOURCE" ]; then
  # Directory: recurse through files
  find "$SOURCE" -type f \( -name "*.md" -o -name "*.txt" -o -name "*.json" -o -name "*.db" \) \
    -not -path "*/node_modules/*" -not -path "*/.git/*" -not -name ".DS_Store" | while read file; do
    ext="${file##*.}"
    echo -n "  $file: "
    case "$ext" in
      md) collect_markdown "$file" ;;
      json) collect_json "$file" ;;
      txt) collect_text "$file" ;;
      db) collect_sqlite "$file" ;;
    esac
  done
elif [ -f "$SOURCE" ]; then
  ext="${SOURCE##*.}"
  echo -n "  $SOURCE: "
  case "$ext" in
    md) collect_markdown "$SOURCE" ;;
    json) collect_json "$SOURCE" ;;
    txt) collect_text "$SOURCE" ;;
    db) collect_sqlite "$SOURCE" ;;
    *) echo "Ismeretlen formatum: $ext"; exit 1 ;;
  esac
fi

TOTAL=$(python3 -c "import json; print(len(json.load(open('$CHUNKS_FILE'))))")
echo ""
echo -e "Osszesen: ${BOLD}$TOTAL chunk${NC}"

if [ "$TOTAL" -eq 0 ]; then
  echo "Nincs importalhato tartalom."
  rm -f "$CHUNKS_FILE"
  exit 0
fi

echo ""
echo -e "AI kategorizalas es importalas..."

# Send to the API for AI categorization and import
curl -s -X POST "$API/memories/import" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\": \"$AGENT\", \"chunks\": $(cat $CHUNKS_FILE)}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('ok'):
    stats = d.get('stats', {})
    print(f'')
    print(f'Import kesz!')
    print(f'   Osszesen: {d.get(\"imported\", 0)} emlek importalva')
    print(f'   Hot: {stats.get(\"hot\", 0)}')
    print(f'   Warm: {stats.get(\"warm\", 0)}')
    print(f'   Cold: {stats.get(\"cold\", 0)}')
    print(f'   Shared: {stats.get(\"shared\", 0)}')
else:
    print(f'Hiba: {d.get(\"error\", \"Ismeretlen\")}')
"

rm -f "$CHUNKS_FILE"
