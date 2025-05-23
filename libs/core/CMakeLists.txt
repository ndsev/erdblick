project(erdblick-core)

# For WASM modules, add_executable is used instead of add_library.
set(ERDBLICK_SOURCE_FILES
  include/erdblick/visualization.h
  include/erdblick/style.h
  include/erdblick/rule.h
  include/erdblick/buffer.h
  include/erdblick/color.h
  include/erdblick/testdataprovider.h
  include/erdblick/aabb.h
  include/erdblick/parser.h
  include/erdblick/geometry.h
  include/erdblick/inspection.h
  include/erdblick/search.h
  include/erdblick/layer.h

  include/erdblick/cesium-interface/object.h
  include/erdblick/cesium-interface/primitive.h
  include/erdblick/cesium-interface/cesium.h
  include/erdblick/cesium-interface/point-conversion.h
  include/erdblick/cesium-interface/points.h
  include/erdblick/cesium-interface/labels.h
  include/erdblick/cesium-interface/billboards.h

  src/visualization.cpp
  src/style.cpp
  src/rule.cpp
  src/color.cpp
  src/buffer.cpp
  src/aabb.cpp
  src/parser.cpp
  src/geometry.cpp
  src/inspection.cpp
  src/search.cpp
  src/layer.cpp

  src/cesium-interface/object.cpp
  src/cesium-interface/primitive.cpp
  src/cesium-interface/cesium.cpp
  src/cesium-interface/points.cpp
  src/cesium-interface/labels.cpp
  src/cesium-interface/billboards.cpp
)

if(${CMAKE_SYSTEM_NAME} STREQUAL "Emscripten")
  # Defaulting to debug symbols if the build type is Debug
  if (CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -g")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -g")
  endif()

  list(APPEND ERDBLICK_SOURCE_FILES src/bindings.cpp)
  add_executable(erdblick-core ${ERDBLICK_SOURCE_FILES})
  target_compile_definitions(erdblick-core PUBLIC EMSCRIPTEN)
  # For Address Sanitization, uncomment the next line and
  #  add sanitize-address to the LINK_FLAGS.
  # target_compile_options(erdblick-core PRIVATE -fsanitize=address)
  # -fsanitize=address \
  set_target_properties(erdblick-core PROPERTIES LINK_FLAGS "\
    --bind \
    --profiling \
    --emit-tsd erdblick-core.d.ts \
    -s ENVIRONMENT=web \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME='\"libErdblickCore\"' \
    -s WASM_BIGINT=1 \
    -s JS_MATH=0 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s SINGLE_FILE=1 \
    -s EXPORTED_RUNTIME_METHODS=HEAPU8 \
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
    CesiumUtility
    Cesium3DTilesWriter
    CesiumGeospatial
    CesiumGltf
    CesiumGltfWriter
    glm
    mapget-model
    yaml-cpp)
