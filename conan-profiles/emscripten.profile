include(default)

[settings]
os=Emscripten
arch=wasm
compiler=clang
compiler.version=15
compiler.libcxx=libc++
build_type=Release

[tool_requires]
emsdk/3.1.50
nodejs/16.3.0
