#include <vector>
#include <string>

#include "tiny_gltf.h"
#include "boxfile.c"

#include "include/FeatureLayerRenderer.h"

FeatureLayerRenderer::FeatureLayerRenderer() : r_() {}

const RenderObject& FeatureLayerRenderer::render() {
  return r_;
}

RenderObject::RenderObject() {
  glb.assign(std::begin(boxfile), std::end(boxfile));
}

uint32_t RenderObject::getGlbSize() {
  return boxfile_len;
}

__UINT64_TYPE__ RenderObject::getGlbPtr() {
  return reinterpret_cast<__UINT64_TYPE__>(glb.data());
}

