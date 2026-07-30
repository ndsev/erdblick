project(erdblick-core)

# For WASM modules, add_executable is used instead of add_library.
set(ERDBLICK_SOURCE_FILES
  include/erdblick/visualization.h
  include/erdblick/subset-renderer.h
  include/erdblick/style.h
  include/erdblick/style-validation.h
  include/erdblick/style-filter-plan.h
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

  include/erdblick/interop/js-object.h
  include/erdblick/geo/point-conversion.h

  src/subset-renderer.cpp
  src/style.cpp
  src/style-validation.cpp
  src/style-filter-plan.cpp
  src/rule.cpp
  src/color.cpp
  src/buffer.cpp
  src/aabb.cpp
  src/parser.cpp
  src/geometry.cpp
  src/inspection.cpp
  src/search.cpp
  src/layer.cpp

  src/interop/base64.h
  src/interop/js-object.cpp
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
  target_compile_options(erdblick-core PRIVATE -msimd128)
  set_property(TARGET erdblick-core PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
  # For Address Sanitization, uncomment the next line and
  #  add sanitize-address to the LINK_FLAGS.
  # target_compile_options(erdblick-core PRIVATE -fsanitize=address)
  # -fsanitize=address \
  set(erdblick_link_flags
    "--bind"
    "--profiling"
    "--emit-tsd erdblick-core.d.ts"
    "-s SINGLE_FILE=1"
    "-s ENVIRONMENT=web"
    "-s MODULARIZE=1"
    "-s EXPORT_ES6=1"
    "-s EXPORT_NAME='\"libErdblickCore\"'"
    "-s WASM_BIGINT=1"
    "-s LEGALIZE_JS_FFI=0"
    "-s JS_MATH=0"
    "-s ALLOW_MEMORY_GROWTH=1"
    "-s FILESYSTEM=0"
    "-s EXPORTED_RUNTIME_METHODS=HEAPU8"
    "-s SAFE_HEAP=0"
    # Keep C++ failures catchable at the embind boundary. Disabling catching
    # turns an otherwise reportable malformed subset into a poisoned WASM
    # runtime which can only surface the generic "Aborted()" message.
    "-s DISABLE_EXCEPTION_CATCHING=0"
    # Wrap every C++ exception crossing into JavaScript in an Error carrying
    # its concrete type, what() text, and throw stack. This also exports the
    # helpers used by normalizeWasmException at explicit byte boundaries.
    "-s EXCEPTION_STACK_TRACES=1"
    "-s STACK_OVERFLOW_CHECK=0"
  )
  message(STATUS "Building ${CMAKE_BUILD_TYPE}")
  if (CMAKE_BUILD_TYPE STREQUAL "Debug")
    list(APPEND erdblick_link_flags "--profiling" "-s ASSERTIONS=1")
  else ()
    list(APPEND erdblick_link_flags "-O3" "-msimd128" "-s ASSERTIONS=0")
  endif()
  string(JOIN " " erdblick_link_flags_joined ${erdblick_link_flags})
  set_target_properties(erdblick-core PROPERTIES LINK_FLAGS "${erdblick_link_flags_joined}")
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
    glm
    mapget-model
    yaml-cpp)
