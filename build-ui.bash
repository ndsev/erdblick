#!/usr/bin/env bash

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
if [[ -z "$NG_DEVELOP" ]]; then
  npm run build -- -c production
else
  npm run build
fi
exit 0
