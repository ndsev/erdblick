#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/ci/run-integration-with-venv-mapget.sh" -- tests/playwright/snap-tests --update-snapshots
