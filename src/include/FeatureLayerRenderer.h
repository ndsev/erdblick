#ifndef ERDBLICK_FEATURELAYERRENDERER_H
#define ERDBLICK_FEATURELAYERRENDERER_H

#include <emscripten/bind.h>

namespace erdblick {

class FeatureLayerRenderer {
public:
  uint32_t test_binary_size();
  uint8_t* test_binary();
};


EMSCRIPTEN_BINDINGS(FLTest) {
  emscripten::class_<FeatureLayerRenderer>("FeatureLayerRenderer")
      .constructor()
      .function("test_binary_size", &FeatureLayerRenderer::test_binary_size)
      .function("test_binary", &FeatureLayerRenderer::test_binary,
                emscripten::allow_raw_pointers());
}

}

#endif // ERDBLICK_FEATURELAYERRENDERER_H
