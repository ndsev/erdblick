#include <vector>

#include "duckfile.c"
#include "tiny_gltf.h"

#include "featurelayerrenderer.h"

FeatureLayerRenderer::FeatureLayerRenderer() = default;

SharedUint8Array& FeatureLayerRenderer::render(
    const FeatureLayerStyle& style,
    const std::shared_ptr<mapget::TileFeatureLayer>& layer)
{
    for (auto& rule : style.rules()) {
        for (auto&& feature : *layer) {
            if (rule.match(*feature)) {
                // TODO visualization.
            }
        }
    }

    glbArray = std::make_shared<SharedUint8Array>(duckfile_len);
    glbArray->writeToArray(std::begin(duckfile), std::end(duckfile));
    return *glbArray;
}

