#pragma once

#include <emscripten/bind.h>

#include "mapget/model/featurelayer.h"

#include "buffer.h"
#include "style.h"
#include "testdataprovider.h"

class FeatureLayerRenderer
{
public:
    FeatureLayerRenderer();
    void render(
        const FeatureLayerStyle& style,
        const std::shared_ptr<mapget::TileFeatureLayer>& layer,
        SharedUint8Array& glbResultBuffer);
};

EMSCRIPTEN_BINDINGS(FeatureLayerRendererBind)
{
    // JS code must access the array using its pointer and size specification,
    // we do not need to expose writeToArray().
    emscripten::class_<SharedUint8Array>("SharedUint8Array")
        .constructor()
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
    emscripten::class_<TestDataProvider>("TestDataProvider")
        .constructor()
        .function("getTestLayer", &TestDataProvider::getTestLayer);
}
