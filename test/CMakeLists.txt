project(test.erdblick)
enable_testing()

if (NOT TARGET Catch2::Catch2WithMain)
  message(FATAL_ERROR "Catch2::Catch2WithMain is required but was not configured in cmake/deps.cmake.")
endif()

if (Catch2_SOURCE_DIR)
  list(APPEND CMAKE_MODULE_PATH "${Catch2_SOURCE_DIR}/extras")
endif()

add_executable(test.erdblick
  test-visualization.cpp)

target_link_libraries(test.erdblick
  PUBLIC
    erdblick-core
    Catch2::Catch2WithMain)

include(Catch)
include(CTest)
catch_discover_tests(test.erdblick)
