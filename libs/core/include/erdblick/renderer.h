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
     * Convert a TileFeatureLayer to a GLB buffer.
     * Returns the cartesian origin of the tile.
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
