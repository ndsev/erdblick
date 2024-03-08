#!/usr/bin/env bash
set -e
source "./build/conanbuild.sh"

set -eu
cmake --preset conan-release
cmake --build --preset conan-release -- -j
