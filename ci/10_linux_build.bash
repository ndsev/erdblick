#/usr/bin/bash

set -e

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
source "$ci_dir/emsdk/emsdk_env.sh"
cd "$ci_dir/.."

rm -r build && mkdir build
cd build
mkdir deps
mkdir assets
emcmake cmake ..
cmake --build .
