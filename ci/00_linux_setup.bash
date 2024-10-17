#!/usr/bin/env bash

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
echo "Setting up Emscripten in: $ci_dir"
cd "$ci_dir"

export PATH=$PATH:"$ci_dir/../node_modules/.bin/"
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
git pull
# For some reason, emsdk>=3.1.68 leads to an error when compiling fmt
# due to more restrictive constexpr checks.
./emsdk install 3.1.67
./emsdk activate 3.1.67
source ./emsdk_env.sh
