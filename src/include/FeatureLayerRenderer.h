#ifndef ERDBLICK_FEATURELAYERRENDERER_H
#define ERDBLICK_FEATURELAYERRENDERER_H

#include <emscripten/bind.h>

namespace erdblick {

class FeatureLayerRenderer {
public:
  std::string test();
};


EMSCRIPTEN_BINDINGS(FLTest) {
  emscripten::class_<FeatureLayerRenderer>("FeatureLayerRenderer")
      .constructor()
      .function("test", &FeatureLayerRenderer::test);
}

}

#endif // ERDBLICK_FEATURELAYERRENDERER_H
