#ifndef ERDBLICK_FEATURELAYERSTYLE_H
#define ERDBLICK_FEATURELAYERSTYLE_H

#include <cstdint>
#include <emscripten/bind.h>
#include "SharedUint8Array.h"

class FeatureLayerStyle
{
public:
    FeatureLayerStyle(SharedUint8Array& yamlArray);

    /*
    const& vector<FeatureStyleRule> rules();
    */
};


EMSCRIPTEN_BINDINGS(FeatureLayerStyleBind)
{
    emscripten::class_<FeatureLayerStyle>("FeatureLayerStyle")
        .constructor<SharedUint8Array&>();
}

#endif  // ERDBLICK_FEATURELAYERSTYLE_H
