cmake_minimum_required(VERSION 3.24)
include(FetchContent)

set(CMAKE_CXX_STANDARD 20)

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

find_package(glm REQUIRED)
find_package(yaml-cpp REQUIRED)

FetchContent_Declare(mapget
  GIT_REPOSITORY "https://github.com/Klebert-Engineering/mapget"
  GIT_TAG        "main"
  GIT_SHALLOW    ON)
FetchContent_MakeAvailable(mapget)

set(CESIUM_TESTS_ENABLED OFF)
set(CESIUM_GLM_STRICT_ENABLED OFF)
set(CESIUM_TRACING_ENABLED OFF)
set(DRACO_JS_GLUE OFF CACHE BOOL "Disable JS glue for Draco" FORCE)
FetchContent_Declare(
  cesiumnative
  GIT_REPOSITORY https://github.com/Klebert-Engineering/cesium-native.git
  GIT_TAG "spdlog-upgrade"
  GIT_SHALLOW ON)
FetchContent_MakeAvailable(cesiumnative)

if (NOT TARGET mapget)
  if (MAPGET_DIR)
    FetchContent_Declare(mapget
      SOURCE_DIR "${MAPGET_DIR}"
      PATCH_COMMAND conan install "${MAPGET_DIR}" -of "${CMAKE_BINARY_DIR}" --build=missing)
  else()
    FetchContent_Declare(mapget
      GIT_REPOSITORY "https://github.com/Klebert-Engineering/mapget"
      GIT_TAG        "main"
      GIT_SHALLOW    ON
      PATCH_COMMAND conan install "${MAPGET_DIR}" -of "${CMAKE_BINARY_DIR}" --build=missing)
  endif()
  FetchContent_MakeAvailable(mapget)
endif()

# Erdblick Core Library

add_subdirectory(libs/core)

if(NOT ${CMAKE_SYSTEM_NAME} STREQUAL "Emscripten")
  add_subdirectory(test)
endif()

# Angular Build

add_custom_target(erdblick-ui ALL
  COMMAND bash "${CMAKE_SOURCE_DIR}/build-ui.bash" "${CMAKE_SOURCE_DIR}"
  WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
  DEPENDS erdblick-core
)
