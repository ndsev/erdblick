project(test.erdblick)

if (NOT TARGET Catch2)
  FetchContent_Declare(Catch2
    GIT_REPOSITORY "https://github.com/catchorg/Catch2.git"
    GIT_TAG        "v3.3.2"
    GIT_SHALLOW    ON)
  FetchContent_MakeAvailable(Catch2)
  list(APPEND CMAKE_MODULE_PATH "${CATCH2_SOURCE_DIR}/contrib")
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
