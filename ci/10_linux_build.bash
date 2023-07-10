#!/usr/bin/env bash

set -e

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
source "$ci_dir/emsdk/emsdk_env.sh"
cd "$ci_dir/.."

rm -rf build && mkdir build
cd build
mkdir deps
mkdir assets
emcmake cmake -DCMAKE_BUILD_TYPE=Release ..
cmake --build .
