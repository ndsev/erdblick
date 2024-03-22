include(FetchContent)
include(ExternalProject)

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
  INSTALL_COMMAND ""
  STEP_TARGETS build)

function (add_cesium_lib TARGET)
  ExternalProject_Get_Property(cesiumnative
    SOURCE_DIR BINARY_DIR)
  message(STATUS "Adding Cesium library: ${TARGET} (${BINARY_DIR}/${TARGET}/${CMAKE_STATIC_LIBRARY_PREFIX}${TARGET}${CMAKE_STATIC_LIBRARY_SUFFIX})")

  add_library(${TARGET} STATIC IMPORTED)
  set_target_properties(${TARGET} PROPERTIES
    IMPORTED_LOCATION "${BINARY_DIR}/${TARGET}/${CMAKE_STATIC_LIBRARY_PREFIX}${TARGET}${CMAKE_STATIC_LIBRARY_SUFFIX}"
    INTERFACE_INCLUDE_DIRECTORIES "${SOURCE_DIR}/${TARGET}/include")
  add_dependencies(${TARGET} cesiumnative-build)
endfunction()

add_cesium_lib(CesiumUtility)
add_cesium_lib(Cesium3DTilesWriter)
add_cesium_lib(CesiumGeospatial)
add_cesium_lib(CesiumGltf)
add_cesium_lib(CesiumGltfWriter)
