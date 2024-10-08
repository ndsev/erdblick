#pragma once

#include "cesium-interface/object.h"
#include "layer.h"

namespace erdblick
{

/**
 * Wrap the given simfil query in an any operator to ensure, that
 * it returns a boolean, and limit wildcard evaluations to the necessary
 * minimum.
 */
std::string anyWrap(std::string_view const& q);

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
