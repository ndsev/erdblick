#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -x "$ROOT/venv/bin/python" ]]; then
  echo "venv/bin/python not found. Create venv and pip install mapget first." >&2
  exit 1
fi

"$ROOT/venv/bin/python" -c "import mapget" 2>/dev/null || {
  echo "Python package 'mapget' is not installed in venv." >&2
  exit 1
}

if [[ ! -x "$ROOT/venv/bin/mapget" ]]; then
  cat >"$ROOT/venv/bin/mapget" <<'EOF'
#!/usr/bin/env bash
exec "$(dirname "$0")/python" -m mapget "$@"
EOF
  chmod +x "$ROOT/venv/bin/mapget"
fi

MAPGET_BIN="$ROOT/venv/bin/mapget" npm run test:integration "$@"

