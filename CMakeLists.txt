cmake_minimum_required(VERSION 3.24)
project(erdblick)

include(FetchContent)

set(CMAKE_CXX_STANDARD 20)

# Treat warnings as errors, with some exceptions for Cesium.
set(ERDBLICK_CXX_FLAGS
  "-Wall -Wno-error=sign-conversion -Wno-sign-compare -Wno-sign-conversion -Wno-unused-local-typedefs -Wno-comment -Wno-effc++")
if (CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${ERDBLICK_CXX_FLAGS} -Wno-bool-compare")
elseif (CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${ERDBLICK_CXX_FLAGS} -Wno-error=shorten-64-to-32")
endif()

# Adjust CXX_FLAGS for Debug builds
if (CMAKE_BUILD_TYPE STREQUAL "Debug")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -g")
endif()

# External dependencies
message("Building for ${CMAKE_SYSTEM_NAME}.")

if (NOT TARGET mapget)
  FetchContent_Declare(mapget
    GIT_REPOSITORY "https://github.com/Klebert-Engineering/mapget"
    GIT_TAG        "v2025.5.0"
    GIT_SHALLOW    ON)
  FetchContent_MakeAvailable(mapget)
endif()

FetchContent_Declare(yaml-cpp
  GIT_REPOSITORY "https://github.com/jbeder/yaml-cpp.git"
  GIT_TAG        "0.8.0"
  GIT_SHALLOW    ON)
FetchContent_MakeAvailable(yaml-cpp)

include(cmake/cesium.cmake)

# Erdblick Core Library
add_subdirectory(libs/core)

if(NOT ${CMAKE_SYSTEM_NAME} STREQUAL "Emscripten")
  add_subdirectory(test)
else()
  # Angular Build
  add_custom_target(erdblick-ui ALL
    COMMAND bash "${CMAKE_SOURCE_DIR}/build-ui.bash" "${CMAKE_SOURCE_DIR}" all
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    DEPENDS erdblick-core)
endif()
