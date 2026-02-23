### Dependencies via CPM

set(ERDBLICK_MAPGET_SOURCE_DIR "" CACHE PATH
  "Local mapget source directory to use instead of fetching from Git.")

if (NOT DEFINED NOSERDE_DEFAULT_VECTOR_STORAGE)
  set(NOSERDE_DEFAULT_VECTOR_STORAGE ON CACHE BOOL
    "Default noserde::Buffer storage policy to vector_byte_storage")
endif()

if (NOT TARGET yaml-cpp)
  CPMAddPackage(
    URI "gh:jbeder/yaml-cpp#yaml-cpp-0.9.0"
    GIT_SHALLOW OFF
    OPTIONS
      "YAML_CPP_BUILD_TESTS OFF"
      "YAML_CPP_BUILD_TOOLS OFF"
      "YAML_CPP_BUILD_CONTRIB OFF")
endif()

if (NOT TARGET mapget-model)
  set(_erdblick_mapget_source_dir "${ERDBLICK_MAPGET_SOURCE_DIR}")
  if ("${_erdblick_mapget_source_dir}" STREQUAL ""
      AND EXISTS "${CMAKE_CURRENT_LIST_DIR}/../../mapget/CMakeLists.txt")
    set(_erdblick_mapget_source_dir "${CMAKE_CURRENT_LIST_DIR}/../../mapget")
  endif()

  if (NOT "${_erdblick_mapget_source_dir}" STREQUAL "")
    message(STATUS "Using local mapget from ${_erdblick_mapget_source_dir}")
    CPMAddPackage(
      NAME mapget
      SOURCE_DIR "${_erdblick_mapget_source_dir}"
      OPTIONS
        "MAPGET_WITH_WHEEL OFF"
        "MAPGET_WITH_SERVICE OFF"
        "MAPGET_WITH_HTTPLIB OFF"
        "MAPGET_ENABLE_TESTING OFF"
        "MAPGET_BUILD_EXAMPLES OFF")
  else()
    CPMAddPackage(
      NAME mapget
      GIT_REPOSITORY "https://github.com/ndsev/mapget.git"
      GIT_TAG "noserde"
      GIT_SHALLOW OFF
      OPTIONS
        "MAPGET_WITH_WHEEL OFF"
        "MAPGET_WITH_SERVICE OFF"
        "MAPGET_WITH_HTTPLIB OFF"
        "MAPGET_ENABLE_TESTING OFF"
        "MAPGET_BUILD_EXAMPLES OFF")
  endif()
endif()

if (NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten" AND NOT TARGET Catch2::Catch2WithMain)
  CPMAddPackage(
    URI "gh:catchorg/Catch2@3.3.2"
    OPTIONS
      "CATCH_INSTALL_DOCS OFF"
      "CATCH_INSTALL_EXTRAS OFF")

  if (Catch2_SOURCE_DIR)
    list(APPEND CMAKE_MODULE_PATH "${Catch2_SOURCE_DIR}/extras")
  endif()
endif()
