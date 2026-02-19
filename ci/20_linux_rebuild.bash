#!/usr/bin/env bash

set -e

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
source "$ci_dir/emsdk/emsdk_env.sh"

export EMSCRIPTEN="$ci_dir/emsdk/upstream/emscripten"
export PATH="$PATH:$ci_dir/../node_modules/.bin/"

cd "$ci_dir/.."

CMAKE_PRESET="${1:-release}"

# Reconfigure on each rebuild so preset switches (e.g. release -> debug) update CMAKE_BUILD_TYPE
# in the existing build directory before invoking the build.
#
# Note: a stale build dir can have `FETCHCONTENT_UPDATES_DISCONNECTED=ON` in `build/CMakeCache.txt`,
# which prevents FetchContent/CPM dependencies from fetching new tags during reconfigure.
emcmake cmake --preset "$CMAKE_PRESET" -DFETCHCONTENT_UPDATES_DISCONNECTED=OFF
cmake --build --preset "$CMAKE_PRESET" -- -j"$(nproc)"
