#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$ROOT/run-integration-with-venv-mapget.sh" -- playwright/snap-tests --update-snapshots

