#ifndef ERDBLICK_FEATURELAYERRENDERER_H
#define ERDBLICK_FEATURELAYERRENDERER_H

#include <emscripten/bind.h>

class RenderObject
{
public:
    RenderObject();
    uint32_t getGlbSize();
    __UINT64_TYPE__ getGlbPtr();

private:
    std::vector<uint8_t> glb;
};

class FeatureLayerRenderer
{
public:
    FeatureLayerRenderer();
    const RenderObject& render();

private:
    RenderObject r_;
};

EMSCRIPTEN_BINDINGS(FLTest)
{
    emscripten::class_<FeatureLayerRenderer>("FeatureLayerRenderer")
        .constructor()
        .function("render", &FeatureLayerRenderer::render);
    emscripten::class_<RenderObject>("RenderObject")
        .function("getGlbSize", &RenderObject::getGlbSize)
        .function("getGlbPtr", &RenderObject::getGlbPtr);
}

#endif  // ERDBLICK_FEATURELAYERRENDERER_H
