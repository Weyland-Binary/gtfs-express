#!/usr/bin/env bash
# refresh-facts.sh — regenerate the verified-facts block in CLAUDE.md
#
# Run: bash scripts/refresh-facts.sh
# Exit codes:
#   0 = CLAUDE.md was up-to-date OR was updated successfully
#   1 = source files missing
#   2 = FACTS markers missing from CLAUDE.md
#   3 = --check mode and CLAUDE.md is stale
#
# --check : dry-run; exit 3 if the block would change. Use in CI to enforce freshness.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_MD="$ROOT_DIR/CLAUDE.md"
ROUTES_FILE="$ROOT_DIR/GTFS-EXPRESS-API/src/routes/gtfsRoutes.js"
# The in-house validator was retired. The catalogue
# (rules.json) and locale files are still maintained in src/utils/ as
# the source of truth for the canonical validator's report
# normalisation.
RULES_JSON="$ROOT_DIR/GTFS-EXPRESS-API/src/utils/rules.json"
LOCALE_EN="$ROOT_DIR/GTFS-EXPRESS-API/src/utils/locales/en.json"
DOCKERFILE_API="$ROOT_DIR/GTFS-EXPRESS-API/Dockerfile"
EDIT_SERVICE="$ROOT_DIR/GTFS-EXPRESS-API/src/services/editService.js"
SCHEMA_FILE="$ROOT_DIR/GTFS-EXPRESS-API/src/services/db/schema.js"
TRANSLATIONS="$ROOT_DIR/GTFS-EXPRESS-WEB/src/i18n/translations.js"
COMPONENTS_DIR="$ROOT_DIR/GTFS-EXPRESS-WEB/src/components"
CONTEXTS_DIR="$ROOT_DIR/GTFS-EXPRESS-WEB/src/contexts"
API_TESTS_DIR="$ROOT_DIR/GTFS-EXPRESS-API/__tests__"
AGENTS_DIR="$ROOT_DIR/.claude/agents"

check_mode=0
if [[ "${1:-}" == "--check" ]]; then
  check_mode=1
fi

for f in "$ROUTES_FILE" "$RULES_JSON" "$LOCALE_EN" "$DOCKERFILE_API" "$SCHEMA_FILE" "$TRANSLATIONS"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: missing source file: $f" >&2
    exit 1
  fi
done

# ── i18n consistency gate ──────────────────────────────────────────────
# Verifies that the 8 languages of translations.js have the exact same set
# of keys, no duplicates, and no `t("key")` source-code call references a
# missing key. Fail-fast in --check mode (CI-friendly).
if ! node "$ROOT_DIR/scripts/i18n-check.js" >/dev/null 2>&1; then
  if [[ $check_mode -eq 1 ]]; then
    echo "i18n check FAILED. Re-run with full output:" >&2
    node "$ROOT_DIR/scripts/i18n-check.js" >&2
    exit 4
  fi
  # Non-check mode: warn but continue so refresh still updates the facts.
  echo "⚠️  i18n drift detected — run 'node scripts/i18n-check.js' for details." >&2
fi

# ── Facts ──────────────────────────────────────────────────────────────
api_routes=$(grep -cE 'router\.(get|post|put|patch|delete)\(' "$ROUTES_FILE")
# Catalogue is rules.json. Use fs.readFileSync to avoid require()'s
# Windows-vs-POSIX path quirks under Git Bash.
rule_count=$(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).rules).length)" "$RULES_JSON" 2>/dev/null || echo 0)
locale_en_keys=$(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))).length)" "$LOCALE_EN" 2>/dev/null || echo 0)
# MobilityData canonical validator JAR version, pinned in the Dockerfile.
validator_jar_version=$(grep -oE 'GTFS_VALIDATOR_VERSION=[0-9]+\.[0-9]+\.[0-9]+' "$DOCKERFILE_API" | head -1 | sed 's|^GTFS_VALIDATOR_VERSION=||')
if [[ -z "$validator_jar_version" ]]; then
  validator_jar_version="unknown"
fi
languages=$(grep -cE '^  [a-z]{2}: \{' "$TRANSLATIONS")
en_keys=$(awk '/^  en: \{/,/^  \},/' "$TRANSLATIONS" | grep -cE '^\s+"[^"]+":')
fr_keys=$(awk '/^  fr: \{/,/^  \},/' "$TRANSLATIONS" | grep -cE '^\s+"[^"]+":')
components=$(find "$COMPONENTS_DIR" -name '*.js' | wc -l | tr -d ' ')
contexts=$(find "$CONTEXTS_DIR" -name '*.js' | wc -l | tr -d ' ')
if [[ -d "$AGENTS_DIR" ]]; then
  agents=$(find "$AGENTS_DIR" -maxdepth 1 -name '*.md' ! -name 'README.md' 2>/dev/null | wc -l | tr -d ' ')
else
  agents=0
fi

if [[ -d "$API_TESTS_DIR" ]]; then
  api_test_files=$(find "$API_TESTS_DIR" -name '*.test.js' 2>/dev/null | wc -l | tr -d ' ')
else
  api_test_files=$(find "$ROOT_DIR/GTFS-EXPRESS-API/src" -name '*.test.js' 2>/dev/null | wc -l | tr -d ' ')
fi

# Parse Node base image from backend Dockerfile (format: FROM node:XX-alpine [AS builder]).
# Keeps the facts table in sync with the actual container runtime without manual edits.
node_version=$(grep -oE 'node:[0-9]+-alpine' "$ROOT_DIR/GTFS-EXPRESS-API/Dockerfile" | head -1 | sed 's|^node:||')
if [[ -z "$node_version" ]]; then
  node_version="unknown"
fi

# Editable GTFS files: count CREATE TABLE statements that target a GTFS spec
# table. Internal bookkeeping tables (`_edit_log`, `_edit_meta`,
# `_project_meta`) are excluded by requiring a leading lowercase letter.
gtfs_files=$(grep -cE '^CREATE TABLE IF NOT EXISTS [a-z][a-z_]* ' "$SCHEMA_FILE")

# ── Assemble block ─────────────────────────────────────────────────────
generated_on=$(date -u +"%Y-%m-%d")
new_block=$(cat <<EOF
<!-- FACTS:START -->
_Regenerated on ${generated_on} by \`scripts/refresh-facts.sh\` — do not edit by hand._

| Fact | Value | How to verify |
|---|---|---|
| API routes | ${api_routes} | \`grep -cE 'router\.(get\|post\|put\|patch\|delete)\(' gtfsRoutes.js\` |
| Validation rules (rules.json catalogue) | ${rule_count} | \`node -p "Object.keys(require('./src/utils/rules.json').rules).length"\` |
| Rule i18n keys (en.json) | ${locale_en_keys} | \`node -p "Object.keys(require('./src/utils/locales/en.json')).length"\` |
| MobilityData validator JAR | v${validator_jar_version} | \`grep GTFS_VALIDATOR_VERSION GTFS-EXPRESS-API/Dockerfile\` |
| Languages | ${languages} (en, fr, es, de, pt, zh, ar, hi) | \`grep -cE '^  [a-z]{2}: \{' translations.js\` |
| Translation keys (EN) | ${en_keys} | \`awk '/^  en: \{/,/^  \},/' translations.js \| grep -cE '^\s+"[^"]+":'\` |
| Translation keys (FR) | ${fr_keys} | \`awk '/^  fr: \{/,/^  \},/' translations.js \| grep -cE '^\s+"[^"]+":'\` |
| React components | ${components} | \`find src/components -name '*.js' \| wc -l\` |
| React contexts | ${contexts} | \`find src/contexts -name '*.js' \| wc -l\` |
| Specialized agents | ${agents} | \`find .claude/agents -maxdepth 1 -name '*.md' ! -name README.md\` |
| Backend test files | ${api_test_files} | \`find GTFS-EXPRESS-API/src -name '*.test.js'\` |
| Node version (Dockerfiles) | ${node_version} | \`grep FROM Dockerfile\` |
| Editable GTFS files | ${gtfs_files} (Schedule, Fares V1/V2, Flex) | \`grep -cE '^CREATE TABLE IF NOT EXISTS [a-z]' GTFS-EXPRESS-API/src/services/db/schema.js\` |
<!-- FACTS:END -->
EOF
)

# ── Inject into CLAUDE.md ──────────────────────────────────────────────
if ! grep -qE '^<!-- FACTS:START -->$' "$CLAUDE_MD" || ! grep -qE '^<!-- FACTS:END -->$' "$CLAUDE_MD"; then
  echo "ERROR: CLAUDE.md has no FACTS markers on dedicated lines. Add <!-- FACTS:START --> ... <!-- FACTS:END --> on their own lines." >&2
  exit 2
fi

tmp=$(mktemp)
block_file=$(mktemp)
# Write block via printf to preserve every backslash verbatim (awk -v would eat them).
printf '%s\n' "$new_block" > "$block_file"

awk -v block_file="$block_file" '
  # Anchor on a line that is exactly the marker — otherwise inline mentions
  # of <!-- FACTS:START --> inside the document body (e.g. in a rule about
  # not editing the block) match too and devour content.
  /^<!-- FACTS:START -->$/ {
    while ((getline line < block_file) > 0) print line
    close(block_file)
    in_block=1
    next
  }
  /^<!-- FACTS:END -->$/ { in_block=0; next }
  !in_block { print }
' "$CLAUDE_MD" > "$tmp"
rm "$block_file"

# Compare structural facts only — the "_Regenerated on YYYY-MM-DD_" line
# would otherwise mark the block stale every day past the last regen even
# when no fact changed, creating daily friction on /preflight and CI.
strip_regen_line() {
  sed -E '/^_Regenerated on [0-9]{4}-[0-9]{2}-[0-9]{2} by/d' "$1"
}

if diff -q <(strip_regen_line "$CLAUDE_MD") <(strip_regen_line "$tmp") > /dev/null 2>&1; then
  rm "$tmp"
  echo "CLAUDE.md is up-to-date."
  exit 0
fi

if [[ $check_mode -eq 1 ]]; then
  echo "CLAUDE.md is STALE. Run: bash scripts/refresh-facts.sh" >&2
  diff -u <(strip_regen_line "$CLAUDE_MD") <(strip_regen_line "$tmp") || true
  rm "$tmp"
  exit 3
fi

mv "$tmp" "$CLAUDE_MD"
echo "CLAUDE.md facts block updated."
echo "  API routes: ${api_routes}  | Rules: ${rule_count}  | EN keys: ${en_keys}  | Components: ${components}  | Contexts: ${contexts}  | Agents: ${agents}"
