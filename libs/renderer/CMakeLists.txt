project(ErdblickRenderer)

# For WASM modules, add_executable is used instead of add_library.
add_executable(ErdblickRenderer
  include/renderer/featurelayerrenderer.h
  include/renderer/featurelayerstyle.h
  include/renderer/featurestylerule.h
  include/renderer/shareduint8array.h
  include/renderer/testdataprovider.h

  src/featurelayerrenderer.cpp
  src/featurelayerstyle.cpp
  src/featurestylerule.cpp
  src/shareduint8array.cpp)

target_include_directories(ErdblickRenderer
  PUBLIC
  include
  PRIVATE
  include/renderer)

set_target_properties(ErdblickRenderer PROPERTIES LINK_FLAGS "\
	--bind \
	-s ENVIRONMENT=web \
	-s MODULARIZE=1 \
	-s EXPORT_NAME='\"libErdblickRenderer\"' \
	-s EXPORTED_RUNTIME_METHODS='[\"cwrap\", \"ccall\"]' \
	-s WASM_BIGINT=1 \
	-s NO_DISABLE_EXCEPTION_CATCHING \
")

target_link_libraries(ErdblickRenderer
  PUBLIC
  tinygltf
  mapget-model
  yaml-cpp)
