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

add_custom_target(static-web-files ALL
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/static" "${CMAKE_BINARY_DIR}")
