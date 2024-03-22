[settings]
os=Emscripten
arch=wasm
compiler=clang
compiler.version=15
compiler.libcxx=libc++
compiler.cppstd=20

[tool_requires]
# See https://github.com/emscripten-core/emsdk/blob/3.1.47/emscripten-releases-tags.json
# for latest version with linux-arm64 support
emsdk/3.1.50
