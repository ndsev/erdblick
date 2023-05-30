#include <vector>

#include "duckfile.c"
#include "tiny_gltf.h"

#include "include/FeatureLayerRenderer.h"

FeatureLayerRenderer::FeatureLayerRenderer() : r_() {}

const RenderObject& FeatureLayerRenderer::render()
{
    return r_;
}

RenderObject::RenderObject()
{
    glb.assign(std::begin(duckfile), std::end(duckfile));
}

uint32_t RenderObject::getGlbSize()
{
    return duckfile_len;
}

__UINT64_TYPE__ RenderObject::getGlbPtr()
{
    return reinterpret_cast<__UINT64_TYPE__>(glb.data());
}
