#ifndef ERDBLICK_FEATURELAYERRENDERER_H
#define ERDBLICK_FEATURELAYERRENDERER_H

#include <emscripten/bind.h>

class FeatureLayerRenderer {
public:
  uint32_t test_binary_size();
  void test_binary(char *memoryBuffer);
  __UINT64_TYPE__ test_binary_two();
};

class RenderObject {
public:
  uint32_t getGlbSize();
  __UINT64_TYPE__ getGlbPtr();
private:
  std::vector<uint8_t> glb;
};

extern "C" {

EMSCRIPTEN_KEEPALIVE
void *getFMR() {
  return new FeatureLayerRenderer();
}

EMSCRIPTEN_KEEPALIVE
void fillBuffer(FeatureLayerRenderer *fmr, char *memoryBuffer) {
  fmr->test_binary(memoryBuffer);
}

EMSCRIPTEN_KEEPALIVE
void *emscripten_malloc(uint32_t size) {
  return malloc(size);
}

EMSCRIPTEN_KEEPALIVE
uint64_t testBinaryTwo(FeatureLayerRenderer *fmr) {
  return fmr->test_binary_two();
}

}

EMSCRIPTEN_BINDINGS(FLTest) {
  emscripten::class_<FeatureLayerRenderer>("FeatureLayerRenderer")
      .constructor()
      .function("test_binary_size", &FeatureLayerRenderer::test_binary_size)
      .function("test_binary_two", &FeatureLayerRenderer::test_binary_two)
      .function("test_binary", &FeatureLayerRenderer::test_binary,
                emscripten::allow_raw_pointers());
}

#endif // ERDBLICK_FEATURELAYERRENDERER_H
