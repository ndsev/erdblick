#!/usr/bin/env bash
set -euo pipefail

# The runner starts in erdblick's root, but keep this launcher independent of cwd.
FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$FIXTURE_DIR/../../.." && pwd)"
DATASOURCE_SCRIPT="$FIXTURE_DIR/datasource.py"

if [[ -x "$ROOT/venv/bin/python" ]]; then
  exec "$ROOT/venv/bin/python" "$DATASOURCE_SCRIPT" "$@"
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 "$DATASOURCE_SCRIPT" "$@"
fi

if command -v python >/dev/null 2>&1; then
  exec python "$DATASOURCE_SCRIPT" "$@"
fi

echo "No Python interpreter found for $DATASOURCE_SCRIPT" >&2
exit 1
