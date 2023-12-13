#!/usr/bin/env bash
set -e
source "./build/conanbuild.sh"

set -eu

cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=build/conan_toolchain.cmake \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_CONAN=OFF \
    -DCMAKE_BUILD_TYPE=Release

cmake --build build -- -j
