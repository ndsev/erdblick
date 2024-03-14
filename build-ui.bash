#!/usr/bin/env bash
set -eu

SOURCE_LOC="$1"
BUILD_DIR="${SOURCE_LOC}/build"

if [ -z "$SOURCE_LOC" ]; then
  echo "No source location supplied."
  exit 1
fi

echo "Using source dir @ $SOURCE_LOC."
cd "$SOURCE_LOC"

echo "Collecting npm modules."
npm install

echo "Building Angular distribution files."
if [[ -z "$NG_DEVELOP" ]]; then
  npm run build -- -c production
else
  npm run build
fi
