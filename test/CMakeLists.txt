project(test.erdblick)
enable_testing()

if (NOT TARGET Catch2::Catch2WithMain)
  message(FATAL_ERROR "Catch2::Catch2WithMain is required but was not configured in cmake/deps.cmake.")
endif()

if (Catch2_SOURCE_DIR)
  list(APPEND CMAKE_MODULE_PATH "${Catch2_SOURCE_DIR}/extras")
endif()

include(Catch)
include(CTest)

add_executable(test.erdblick
  test-visualization.cpp)

target_link_libraries(test.erdblick
  PUBLIC
    erdblick-core
    Catch2::Catch2WithMain)

catch_discover_tests(test.erdblick)

add_executable(test.erdblick-style-plan
  test-style-filter-plan.cpp)

target_link_libraries(test.erdblick-style-plan
  PUBLIC
    erdblick-core
    Catch2::Catch2WithMain)

catch_discover_tests(test.erdblick-style-plan)

add_executable(test.erdblick-subset-renderer
  test-subset-renderer.cpp)

target_link_libraries(test.erdblick-subset-renderer
  PUBLIC
    erdblick-core
    Catch2::Catch2WithMain)

catch_discover_tests(test.erdblick-subset-renderer)
