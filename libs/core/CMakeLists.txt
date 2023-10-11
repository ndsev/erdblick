project(erdblick-core)

# For WASM modules, add_executable is used instead of add_library.
set(ERDBLICK_SOURCE_FILES
  include/erdblick/renderer.h
  include/erdblick/style.h
  include/erdblick/rule.h
  include/erdblick/buffer.h
  include/erdblick/color.h
  include/erdblick/testdataprovider.h
  include/erdblick/aabb.h
  include/erdblick/stream.h

  include/erdblick/cesium-interface/object.h
  include/erdblick/cesium-interface/primitive.h
  include/erdblick/cesium-interface/cesium.h
  include/erdblick/cesium-interface/point-conversion.h

  src/renderer.cpp
  src/style.cpp
  src/rule.cpp
  src/color.cpp
  src/buffer.cpp
  src/aabb.cpp
  src/stream.cpp

  src/cesium-interface/object.cpp
  src/cesium-interface/primitive.cpp
  src/cesium-interface/cesium.cpp
  )

if(${CMAKE_SYSTEM_NAME} STREQUAL "Emscripten")
  list(APPEND ERDBLICK_SOURCE_FILES src/bindings.cpp)
  add_executable(erdblick-core ${ERDBLICK_SOURCE_FILES})
  target_compile_definitions(erdblick-core PUBLIC EMSCRIPTEN)
  set_target_properties(erdblick-core PROPERTIES LINK_FLAGS "\
    --bind \
    --profiling \
    -s ENVIRONMENT=web \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME='\"libErdblickCore\"' \
    -s WASM_BIGINT=1 \
    -s NO_DISABLE_EXCEPTION_CATCHING \
    -s JS_MATH=0 \
    -s ALLOW_MEMORY_GROWTH=1 \
  ")
else()
  add_library(erdblick-core ${ERDBLICK_SOURCE_FILES})
endif()

target_include_directories(erdblick-core
  PUBLIC
    include
  PRIVATE
    include/erdblick)

target_link_libraries(erdblick-core
  PUBLIC
    Cesium3DTilesWriter
    CesiumGeospatial
    CesiumGltf
    CesiumGltfWriter
    glm
    mapget-model
    yaml-cpp)
