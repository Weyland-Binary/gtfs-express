#!/usr/bin/env bash
# install-hooks.sh — installs local git hooks for this repo.
#
# Currently installs:
#   - pre-push : blocks push if CLAUDE.md facts block is stale.
#
# Run once after `git clone` or whenever hooks change:
#   bash scripts/install-hooks.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$ROOT_DIR/.git/hooks"

if [[ ! -d "$HOOK_DIR" ]]; then
  echo "ERROR: not a git repository ($HOOK_DIR missing)" >&2
  exit 1
fi

PRE_PUSH="$HOOK_DIR/pre-push"
cat > "$PRE_PUSH" <<'HOOK'
#!/usr/bin/env bash
# Blocks push when CLAUDE.md facts block is stale.
# Bypass with --no-verify only when strictly needed.

set -e
root="$(git rev-parse --show-toplevel)"
if [[ -x "$root/scripts/refresh-facts.sh" ]]; then
  if ! bash "$root/scripts/refresh-facts.sh" --check > /dev/null 2>&1; then
    echo "✘ CLAUDE.md facts block is STALE."
    echo "  Run: bash scripts/refresh-facts.sh"
    echo "  Then re-commit the updated CLAUDE.md."
    exit 1
  fi
fi
HOOK

chmod +x "$PRE_PUSH"
echo "✓ pre-push hook installed at $PRE_PUSH"
echo "  It blocks push when CLAUDE.md facts are stale."
