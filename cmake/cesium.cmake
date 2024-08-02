include(FetchContent)
include(ExternalProject)

block()

if (NOT CMAKE_BUILD_TYPE)
  message(FATAL_ERROR "Setting CMAKE_BUILD_TYPE is required!")
endif()

# List of cesium libs we want to expose as CMake targets
set(CESIUM_LIBS
  CesiumUtility
  Cesium3DTilesWriter
  CesiumGeospatial
  CesiumGltf
  CesiumGltfWriter)

# Use fetch content for cloning the repository durring
# configure phase. We do not call `FetchContent_MakeAvailable`,
# but instead use `ExternalProject_Add` to compile Cesium in
# isolation.
FetchContent_Declare(cesiumnative_src
  GIT_REPOSITORY "https://github.com/Klebert-Engineering/cesium-native.git"
  GIT_TAG "main"
  GIT_SUBMODULES_RECURSE YES
  GIT_PROGRESS YES)

FetchContent_GetProperties(cesiumnative_src)
if (NOT cesiumnative_src_POPULATED)
  FetchContent_Populate(cesiumnative_src)
endif()

# Cesium sets CMAKE_{DEBUG,RELEASE}_POSTFIX manually
set(CMAKE_DEBUG_POSTFIX "d")
set(CMAKE_RELEASE_POSTFIX "")

# CMake uses some pre-, post- and suffix variables to decorate
# library names with. We have to take them into account.
if (${CMAKE_BUILD_TYPE} STREQUAL "Debug")
  set(LIB_SUFFIX "${CMAKE_DEBUG_POSTFIX}${CMAKE_STATIC_LIBRARY_SUFFIX}")
else()
  set(LIB_SUFFIX "${CMAKE_RELEASE_POSTFIX}${CMAKE_STATIC_LIBRARY_SUFFIX}")
endif()

# Ninja generators _require_ a known list of byproducts.
set(CESIUM_BYPRODUCTS "")
foreach (lib ${CESIUM_LIBS})
  list(APPEND CESIUM_BYPRODUCTS "<BINARY_DIR>/${lib}/${CMAKE_STATIC_LIBRARY_PREFIX}${lib}${LIB_SUFFIX}")
endforeach()
message(STATUS "cesium byproducts: ${CESIUM_BYPRODUCTS}")

ExternalProject_Add(cesiumnative
  SOURCE_DIR ${cesiumnative_src_SOURCE_DIR}
  CMAKE_ARGS
    -DCMAKE_CXX_FLAGS=${CMAKE_CXX_FLAGS}
    -DCESIUM_TESTS_ENABLED=OFF
    -DCESIUM_GLM_STRICT_ENABLED=OFF
    -DCESIUM_TRACING_ENABLED=OFF
    -DDRACO_JS_GLUE=OFF
    -DBUILD_SHARED_LIBS=OFF
    -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
    -DCMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE}
  BUILD_BYPRODUCTS
    ${CESIUM_BYPRODUCTS}
  INSTALL_COMMAND ""
  STEP_TARGETS build
  USES_TERMINAL_CONFIGURE TRUE
  USES_TERMINAL_BUILD TRUE)

function (add_cesium_lib TARGET)
  ExternalProject_Get_Property(cesiumnative
    SOURCE_DIR BINARY_DIR)
  message(STATUS "Adding Cesium library: ${TARGET} (${BINARY_DIR}/${TARGET}/${CMAKE_STATIC_LIBRARY_PREFIX}${TARGET}${LIB_SUFFIX})")

  add_library(${TARGET} STATIC IMPORTED)
  set_target_properties(${TARGET} PROPERTIES
    IMPORTED_LOCATION "${BINARY_DIR}/${TARGET}/${CMAKE_STATIC_LIBRARY_PREFIX}${TARGET}${LIB_SUFFIX}"
    INTERFACE_INCLUDE_DIRECTORIES "${SOURCE_DIR}/${TARGET}/include")
  add_dependencies(${TARGET} cesiumnative-build)
endfunction()

foreach (lib ${CESIUM_LIBS})
  add_cesium_lib(${lib})
endforeach()

endblock()
