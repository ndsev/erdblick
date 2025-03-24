#pragma once

#include "cesium-interface/object.h"
#include "layer.h"

namespace erdblick
{

class FeatureLayerSearch
{
public:
    explicit FeatureLayerSearch(TileFeatureLayer& tfl);

    /** Returns a list of Tuples of (Map Tile Key, Feature ID). */
    NativeJsValue filter(std::string const& q);

    /** Returns list of Tuples of (Trace Name, Trace Values). */
    NativeJsValue traceResults();

private:
    TileFeatureLayer& tfl_;
};

}
