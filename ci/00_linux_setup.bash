#!/usr/bin/env bash

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
echo "Setting up Emscripten in: $ci_dir"
cd "$ci_dir"

export PATH=$PATH:"$ci_dir/../node_modules/.bin/"
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
git pull
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
