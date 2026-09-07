cmake_minimum_required(VERSION 3.24)
project(erdblick)

include(FetchContent)

set(CMAKE_CXX_STANDARD 20)

# Treat warnings as errors.
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

set(CPM_DOWNLOAD_ALL ON)
set(CPM_USE_LOCAL_PACKAGES OFF)
if (NOT COMMAND CPMAddPackage)
  if (NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CPM.cmake/CMakeLists.txt")
    message(FATAL_ERROR
      "Missing CPM submodule at cmake/CPM.cmake. "
      "Run: git submodule update --init --recursive cmake/CPM.cmake")
  endif()
  # If this build tree previously used a different CPM checkout, stale cache
  # variables can make CPM.cmake return early before defining CPMAddPackage.
  foreach(_erdblick_cpm_var CPM_INITIALIZED CPM_DIRECTORY CPM_FILE CPM_VERSION CPM_PACKAGES)
    unset(${_erdblick_cpm_var} CACHE)
    unset(${_erdblick_cpm_var})
  endforeach()
  add_subdirectory(cmake/CPM.cmake)
endif ()
include(cmake/deps.cmake)

# Emscripten's TypeScript-definition generation invokes `tsc` while linking.
# Make the repository's locked TypeScript toolchain available before that link
# instead of falling back to a potentially incompatible runner installation.
if(CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  set(ERDBLICK_NPM_INSTALL_MARKER
    "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/.bin/tsc")
  add_custom_command(
    OUTPUT "${ERDBLICK_NPM_INSTALL_MARKER}"
    COMMAND npm ci
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    DEPENDS
      "${CMAKE_CURRENT_SOURCE_DIR}/package.json"
      "${CMAKE_CURRENT_SOURCE_DIR}/package-lock.json"
    COMMENT "Installing locked erdblick Node.js dependencies"
    VERBATIM)
  add_custom_target(erdblick-npm-dependencies
    DEPENDS "${ERDBLICK_NPM_INSTALL_MARKER}")
endif()

# Erdblick Core Library
add_subdirectory(libs/core)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  add_subdirectory(test)
else()
  add_dependencies(erdblick-core erdblick-npm-dependencies)
  set_property(TARGET erdblick-core PROPERTY RULE_LAUNCH_LINK
    "${CMAKE_COMMAND} -E env PATH=${CMAKE_CURRENT_SOURCE_DIR}/node_modules/.bin:$ENV{PATH}")

  # Angular Build
  add_custom_target(erdblick-ui ALL
    COMMAND bash "${CMAKE_SOURCE_DIR}/build-ui.bash" "${CMAKE_SOURCE_DIR}" all
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    DEPENDS erdblick-core)
endif()
