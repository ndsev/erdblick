#!/usr/bin/env bash
set -e

SOURCE_LOC=$1
BUILD_MODE=$2  # New parameter for build mode
if [ -z $SOURCE_LOC ]; then
  echo "No source location supplied."
  exit 1
fi

echo "Using source dir @ $SOURCE_LOC."
cd "$SOURCE_LOC" || exit 1

echo "Collecting npm modules."
npm install

echo "Building Angular distribution files."
npm run lint

# Determine which build mode to use
if [[ -n "$NG_DEVELOP" ]]; then
  npm run build -- -c development
elif [[ "$BUILD_MODE" == "visualization-only" ]]; then
  echo "Building in visualization-only mode."
  npm run build -- -c visualization-only
else
  npm run build
fi

exit 0