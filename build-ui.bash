#!/usr/bin/env bash
set -e

SOURCE_LOC=$1
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
if [[ -n "$NG_DEVELOP" ]]; then
  npm run build -- -c development
else
  npm run build
fi

exit 0