#pragma once

#include "mapget/model/featurelayer.h"
#include "buffer.h"
#include "style.h"

namespace erdblick
{

class FeatureLayerRenderer
{
public:
    FeatureLayerRenderer();
    void render(
        const FeatureLayerStyle& style,
        const std::shared_ptr<mapget::TileFeatureLayer>& layer,
        SharedUint8Array& glbResultBuffer);
};

}
