#!/usr/bin/env bash

set -e

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
source "$ci_dir/emsdk/emsdk_env.sh"
cd "$ci_dir/.."

export EMSCRIPTEN="$ci_dir/emsdk/upstream/emscripten"
export PATH="$PATH:$(pwd)/node_modules/.bin/"

rm -rf build
mkdir -p build
mkdir -p build/deps
mkdir -p build/assets

CMAKE_PRESET="${1:-release}"

emcmake cmake --preset "$CMAKE_PRESET"
cmake --build --preset "$CMAKE_PRESET" -- -j"$(nproc)"
