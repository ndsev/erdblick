#!/usr/bin/env bash

set -e

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
source "$ci_dir/emsdk/emsdk_env.sh"

export EMSCRIPTEN="$ci_dir/emsdk/upstream/emscripten"
export PATH="$PATH:$ci_dir/../node_modules/.bin/"

cd "$ci_dir/.."

BUILD_VARIANT="${1:-profiling}"
case "$BUILD_VARIANT" in
  profiling|profile)
    CMAKE_PRESET="release"
    export ERDBLICK_PROFILE_BUILD="TRUE"
    unset NG_DEVELOP NG_BUILD_MANGLE
    ;;
  production|release)
    CMAKE_PRESET="release"
    unset ERDBLICK_PROFILE_BUILD NG_DEVELOP NG_BUILD_MANGLE
    ;;
  debug|debug-wasm)
    CMAKE_PRESET="$BUILD_VARIANT"
    unset ERDBLICK_PROFILE_BUILD NG_BUILD_MANGLE
    ;;
  *)
    echo "Unsupported build variant '$BUILD_VARIANT'. Use profiling, production, debug, or debug-wasm." >&2
    exit 2
    ;;
esac

# Reconfigure on each rebuild so preset switches (e.g. release -> debug) update CMAKE_BUILD_TYPE
# in the existing build directory before invoking the build.
#
# Note: a stale build dir can have `FETCHCONTENT_UPDATES_DISCONNECTED=ON` in `build/CMakeCache.txt`,
# which prevents FetchContent/CPM dependencies from fetching new tags during reconfigure.
emcmake cmake --preset "$CMAKE_PRESET" -DFETCHCONTENT_UPDATES_DISCONNECTED=OFF
cmake --build --preset "$CMAKE_PRESET" -- -j"$(nproc)"
