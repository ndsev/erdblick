#!/usr/bin/env bash

set -e

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
source "$ci_dir/emsdk/emsdk_env.sh"

export EMSCRIPTEN="$ci_dir/emsdk/upstream/emscripten"

cd "$ci_dir/../build"
cmake --build . -- -j
# Patch the TS bindings
printf "\n declare var libErdblickCore: any; \n export default libErdblickCore; \n" >> ./libs/core/erdblick-core.d.ts