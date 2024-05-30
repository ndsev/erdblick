#pragma once

#include "mapget/model/featurelayer.h"
#include "cesium-interface/object.h"

namespace erdblick
{

class FeatureLayerSearch
{
public:
    explicit FeatureLayerSearch(mapget::TileFeatureLayer& tfl);

    /** Returns a list of Tuples of (Map Tile Key, Feature ID). */
    NativeJsValue filter(std::string const& q);

    /** Returns list of Tuples of (Trace Name, Trace Values). */
    NativeJsValue traceResults();

private:
    mapget::TileFeatureLayer& tfl_;
};

}