#!/usr/bin/env bash
set -eu

rm -rf build && mkdir build
mkdir -p build/deps
mkdir -p build/assets

conan install . -pr:b default -pr:h conan-profiles/emscripten.profile \
    -s build_type=Release -b missing -of build
