#!/usr/bin/env bash
set -eu

BUILD_DIR="./build"
PROFILE_DIR="./conan-profiles"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/deps"
mkdir -p "$BUILD_DIR/assets"

conan install . \
    -pr:b "$PROFILE_DIR/build.profile" \
    -pr:h "$PROFILE_DIR/emscripten.profile" \
    -s build_type=Release -s compiler.cppstd=20 -b missing -b editable \
    -of "$BUILD_DIR"
