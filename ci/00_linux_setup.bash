#!/usr/bin/env bash

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
echo "Setting up Emscripten in: $ci_dir"
cd "$ci_dir" || exit 1

export PATH=$PATH:"$ci_dir/../node_modules/.bin/"
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk || exit 1
git pull

./emsdk install 4.0.20
./emsdk activate 4.0.20
source ./emsdk_env.sh
