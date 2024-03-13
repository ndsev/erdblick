#!/usr/bin/env bash
set -eu
rm -rf build
mkdir -p build/deps
mkdir -p build/assets

conan install . -pr:b default -pr:h conan-profiles/emscripten.profile \
    -s build_type=Release -s compiler.cppstd=20 -b missing -b editable \
    -of build
