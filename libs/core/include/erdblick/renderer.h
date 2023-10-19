#pragma once

#include "mapget/model/featurelayer.h"
#include "buffer.h"
#include "style.h"
#include "cesium-interface/object.h"

namespace erdblick
{

class FeatureLayerRenderer
{
public:
    FeatureLayerRenderer();

    /**
     * Convert a TileFeatureLayer to a collection of Cesium scene
     * primitives, using a particular style sheet.
     */
    NativeJsValue
    render(const FeatureLayerStyle& style, const std::shared_ptr<mapget::TileFeatureLayer>& layer);
};

}
