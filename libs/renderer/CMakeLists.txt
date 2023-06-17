project(ErdblickRenderer)

# For WASM modules, add_executable is used instead of add_library.
add_executable(ErdblickRenderer
  include/renderer/FeatureLayerRenderer.h
  include/renderer/FeatureLayerStyle.h
  include/renderer/FeatureStyleRule.h
  include/renderer/SharedUint8Array.h

  src/FeatureLayerRenderer.cpp
  src/FeatureLayerStyle.cpp
  src/FeatureStyleRule.cpp
  src/SharedUint8Array.cpp)

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
