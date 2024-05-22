#!/usr/bin/env bash

set -e

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
source "$ci_dir/emsdk/emsdk_env.sh"
cd "$ci_dir/.."

export EMSCRIPTEN="$ci_dir/emsdk/upstream/emscripten"
export PATH=$PATH:"$(pwd)/node_modules/.bin/"

rm -rf build && mkdir build
cd build
mkdir deps
mkdir assets
emcmake cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF ..
cmake --build . -- -j
