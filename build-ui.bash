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

echo "Patch erblick-core TS definitions."
printf "\ndeclare var libErdblickCore: any; \nexport default libErdblickCore; \n" >> "$SOURCE_LOC/build/libs/core/erdblick-core.d.ts"

echo "Building Angular distribution files."
ng build -c production

exit 0
