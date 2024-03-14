#!/usr/bin/env bash
set -eu

NODE_VERSION="21"
SOURCE_LOC="$1"
BUILD_DIR="${SOURCE_LOC}/build"

if [ -z "$SOURCE_LOC" ]; then
  echo "No source location supplied."
  exit 1
fi

echo "Using source dir @ $SOURCE_LOC."
cd "$SOURCE_LOC"

echo "Installing nvm"
export NVM_DIR="$(mktemp -d)"
git clone https://github.com/nvm-sh/nvm.git "${NVM_DIR}" -b v0.39.7
. "${NVM_DIR}/nvm.sh"

echo "Setting up Node.js ${NODE_VERSION}"
nvm install "${NODE_VERSION}"
nvm use "${NODE_VERSION}"

echo "Collecting npm modules."
npm -g install --force --include=dev
npm install

echo "Building Angular distribution files."
if [[ -z "$NG_DEVELOP" ]]; then
  npm run build -- -c production
else
  npm run build
fi
