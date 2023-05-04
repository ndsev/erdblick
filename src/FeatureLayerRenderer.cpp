#include <cstdint>
#include <vector>
#include <string>

#include "emscripten.h"

#include "include/FeatureLayerRenderer.h"

namespace erdblick
{
std::vector<uint8_t> EMSCRIPTEN_KEEPALIVE FeatureLayerRenderer::render(
    const std::string& dummyFeatureLayer,
    const std::string& dummyIdCache) {

  std::vector<uint8_t> binaryDataDummy = {2};
  return binaryDataDummy;
}

uint8_t EMSCRIPTEN_KEEPALIVE FeatureLayerRenderer::test() {
  return 42;
}

}