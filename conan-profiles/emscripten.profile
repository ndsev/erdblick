[settings]
os=Emscripten
arch=wasm
compiler=clang
compiler.version=15
compiler.libcxx=libc++
compiler.cppstd=20
build_type=Release

[tool_requires]
emsdk/3.1.50

[replace_tool_requires]
nodejs/*: nodejs/16.20.2
