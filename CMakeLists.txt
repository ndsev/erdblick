cmake_minimum_required(VERSION 3.26)
project(erdblick)

include(FetchContent)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_FLAGS "-Wall")

include_directories(src/include)

add_executable(FeatureLayerRenderer
  src/include/FeatureLayerRenderer.h
  src/FeatureLayerRenderer.cpp
)

set_target_properties(FeatureLayerRenderer PROPERTIES LINK_FLAGS "\
	--bind \
	-s ENVIRONMENT=web \
	-s MODULARIZE=1 \
	-s EXPORT_NAME='\"libFeatureLayerRenderer\"' \
	-s EXPORTED_RUNTIME_METHODS='[\"cwrap\", \"ccall\"]' \
	-s WASM_BIGINT=1 \
")

  configure_file("${CMAKE_SOURCE_DIR}/static/index.html" "${CMAKE_BINARY_DIR}/index.html" @ONLY)
  configure_file("${CMAKE_SOURCE_DIR}/static/demo.js" "${CMAKE_BINARY_DIR}/demo.js" @ONLY)

  configure_file("${CMAKE_SOURCE_DIR}/static/deps/three.js" "${CMAKE_BINARY_DIR}/deps/three.js" @ONLY)
  configure_file("${CMAKE_SOURCE_DIR}/static/deps/GLTFLoader.js" "${CMAKE_BINARY_DIR}/deps/GLTFLoader.js" @ONLY)
  configure_file("${CMAKE_SOURCE_DIR}/static/deps/meshline.js" "${CMAKE_BINARY_DIR}/deps/meshline.js" @ONLY)

FetchContent_Declare(tinygltf
  GIT_REPOSITORY "https://github.com/syoyo/tinygltf.git"
  GIT_TAG        "v2.8.9"
)

FetchContent_MakeAvailable(tinygltf)

target_link_libraries(FeatureLayerRenderer
  tinygltf
)
