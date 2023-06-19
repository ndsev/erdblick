#ifndef ERDBLICK_FEATURELAYERRENDERER_H
#define ERDBLICK_FEATURELAYERRENDERER_H

#include <emscripten/bind.h>

#include "mapget/model/featurelayer.h"

#include "shareduint8array.h"
#include "featurelayerstyle.h"
#include "testdataprovider.h"

class FeatureLayerRenderer
{
public:
    FeatureLayerRenderer();
    SharedUint8Array& render(
        const FeatureLayerStyle& style,
        const std::shared_ptr<mapget::TileFeatureLayer>& layer);
private:
    std::shared_ptr<SharedUint8Array> glbArray;
};

EMSCRIPTEN_BINDINGS(FeatureLayerRendererBind)
{
    // JS code must access the array using its pointer and size specification,
    // we do not need to expose writeToArray().
    emscripten::class_<SharedUint8Array>("SharedUint8Array")
        .constructor<uint32_t>()
        .function("getSize", &SharedUint8Array::getSize)
        .function("getPointer", &SharedUint8Array::getPointer);
    emscripten::class_<FeatureLayerRenderer>("FeatureLayerRenderer")
        .constructor()
        .function("render", &FeatureLayerRenderer::render);
    emscripten::class_<FeatureLayerStyle>("FeatureLayerStyle")
        .constructor<SharedUint8Array&>();
    emscripten::class_<mapget::TileFeatureLayer>("TileFeatureLayer")
        .smart_ptr<std::shared_ptr<mapget::TileFeatureLayer>>("std::shared_ptr<mapget::TileFeatureLayer>");
    // For reference, the below binding is not enough, throwing an
    // UnboundTypeError at runtime when getTestLayer is called in demo.js.
    // emscripten::register_vector<std::shared_ptr<mapget::TileFeatureLayer>>("TileFeatureLayerPtr");
    emscripten::class_<TestDataProvider>("TestDataProvider")
        .constructor()
        .function("getTestLayer", &TestDataProvider::getTestLayer);
}

#endif  // ERDBLICK_FEATURELAYERRENDERER_H
