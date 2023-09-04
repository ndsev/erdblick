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

    /**
     * Convert a TileFeatureLayer to a GLB buffer. Returns the
     * cartesian origin of the tile. If there are no features to render,
     * either because the layer is empty or because no style rule matched,
     * then the size of the result buffer will be zero.
     */
    mapget::Point render(
        const FeatureLayerStyle& style,
        const std::shared_ptr<mapget::TileFeatureLayer>& layer,
        SharedUint8Array& result);

    /**
     * Create a Cesium tileset-wrapper for a GLB-converted TileFeatureLayer URL.
     */
    void makeTileset(
        std::string const& tileGlbUrl,
        mapget::Point const& origin,
        SharedUint8Array& glbResultBuffer);
};

}
