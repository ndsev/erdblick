#include <vector>

#include "duckfile.c"
#include "tiny_gltf.h"

#include "FeatureLayerRenderer.h"

FeatureLayerRenderer::FeatureLayerRenderer() {}

SharedUint8Array& FeatureLayerRenderer::render()
{
    glbArray = std::make_shared<SharedUint8Array>(duckfile_len);
    glbArray->writeToArray(std::begin(duckfile), std::end(duckfile));
    return *glbArray;
}
