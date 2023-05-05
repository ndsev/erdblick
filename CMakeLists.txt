cmake_minimum_required(VERSION 3.26)
project(erdblick)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_FLAGS "-Wall")

include_directories(src/include)

add_executable(FeatureLayerRenderer
  src/include/FeatureLayerRenderer.h
  src/FeatureLayerRenderer.cpp
)

set_target_properties(FeatureLayerRenderer PROPERTIES LINK_FLAGS "\
	--bind \
	-s ENVIRONMENT=web \
	-s MODULARIZE=1 \
	-s EXPORT_NAME='\"libFeatureLayerRenderer\"' \
	-s EXPORTED_RUNTIME_METHODS='[\"cwrap\", \"ccall\"]' \
")