cmake_minimum_required(VERSION 3.26)
project(erdblick)

include(FetchContent)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_FLAGS "-Wall")

# External dependencies.

FetchContent_Declare(tinygltf
  GIT_REPOSITORY "https://github.com/syoyo/tinygltf.git"
  GIT_TAG        "v2.8.9"
  GIT_SHALLOW    ON)
FetchContent_MakeAvailable(tinygltf)

FetchContent_Declare(mapget
  GIT_REPOSITORY "https://github.com/Klebert-Engineering/mapget"
  GIT_TAG        "issue/4-pymapget"
  GIT_SHALLOW    ON)
FetchContent_MakeAvailable(mapget)

FetchContent_Declare(yaml-cpp
  GIT_REPOSITORY "https://github.com/jbeder/yaml-cpp.git"
  GIT_TAG        "yaml-cpp-0.7.0"
  GIT_SHALLOW    ON)
FetchContent_MakeAvailable(yaml-cpp)

add_subdirectory(libs/renderer)

configure_file("${CMAKE_SOURCE_DIR}/static/index.html" "${CMAKE_BINARY_DIR}/index.html" @ONLY)
configure_file("${CMAKE_SOURCE_DIR}/static/demo.js" "${CMAKE_BINARY_DIR}/demo.js" @ONLY)

configure_file("${CMAKE_SOURCE_DIR}/static/deps/three.js" "${CMAKE_BINARY_DIR}/deps/three.js" @ONLY)
configure_file("${CMAKE_SOURCE_DIR}/static/deps/GLTFLoader.js" "${CMAKE_BINARY_DIR}/deps/GLTFLoader.js" @ONLY)
configure_file("${CMAKE_SOURCE_DIR}/static/deps/BufferGeometryUtils.js" "${CMAKE_BINARY_DIR}/deps/BufferGeometryUtils.js" @ONLY)
configure_file("${CMAKE_SOURCE_DIR}/static/deps/LICENSE" "${CMAKE_BINARY_DIR}/deps/LICENSE" @ONLY)

configure_file("${CMAKE_SOURCE_DIR}/static/styles/demo-style.yaml" "${CMAKE_BINARY_DIR}/styles/demo-style.yaml" @ONLY)
