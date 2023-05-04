#/usr/bin/bash

ci_dir="$(realpath ${BASH_SOURCE[0]} | xargs -I{} dirname {})"
echo "Setting up Emscripten in: $ci_dir"
cd "$ci_dir"

git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
git pull
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
