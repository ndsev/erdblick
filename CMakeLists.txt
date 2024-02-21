cmake_minimum_required(VERSION 3.24)
project(erdblick)

include(FetchContent)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_OSX_ARCHITECTURES "x86_64")

# Treat warnings as errors, with some exceptions for Cesium.
set (ERDBLICK_CXX_FLAGS
  "-Wall -Wno-error=sign-conversion -Wno-sign-compare -Wno-sign-conversion -Wno-unused-local-typedefs -Wno-comment -Wno-effc++")
if (CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${ERDBLICK_CXX_FLAGS} -Wno-bool-compare")
elseif (CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${ERDBLICK_CXX_FLAGS} -Wno-error=shorten-64-to-32")
endif()

# External dependencies.

message("Building for ${CMAKE_SYSTEM_NAME}.")

FetchContent_Declare(glm
    GIT_REPOSITORY "https://github.com/g-truc/glm.git"
    GIT_TAG        "0.9.9.8"
    GIT_SHALLOW    ON)
FetchContent_MakeAvailable(glm)

# Fetch cesium-native
set(CESIUM_TESTS_ENABLED OFF)
set(CESIUM_GLM_STRICT_ENABLED OFF)
set(CESIUM_TRACING_ENABLED OFF)
set(DRACO_JS_GLUE OFF CACHE BOOL "Disable JS glue for Draco" FORCE)
FetchContent_Declare(
  cesiumnative
  GIT_REPOSITORY https://github.com/Klebert-Engineering/cesium-native.git
  GIT_TAG "main"
  GIT_SHALLOW ON)
FetchContent_MakeAvailable(cesiumnative)

FetchContent_Declare(mapget
  GIT_REPOSITORY "https://github.com/Klebert-Engineering/mapget"
  GIT_TAG        "relations"
  GIT_SHALLOW    ON)
FetchContent_MakeAvailable(mapget)

FetchContent_Declare(yaml-cpp
  GIT_REPOSITORY "https://github.com/jbeder/yaml-cpp.git"
  GIT_TAG        "yaml-cpp-0.7.0"
  GIT_SHALLOW    ON)
FetchContent_MakeAvailable(yaml-cpp)

add_subdirectory(libs/core)

if(NOT ${CMAKE_SYSTEM_NAME} STREQUAL "Emscripten")
  add_subdirectory(test)
endif()
