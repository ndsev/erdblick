#!/usr/bin/env bash

set -e

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
source "$ci_dir/emsdk/emsdk_env.sh"

export EMSCRIPTEN="$ci_dir/emsdk/upstream/emscripten"
export PATH="$PATH:$ci_dir/../node_modules/.bin/"

cd "$ci_dir/.."

CMAKE_PRESET="${1:-release}"

cmake --build --preset "$CMAKE_PRESET" -- -j"$(nproc)"
