#include <vector>
#include <string>

#include "include/FeatureLayerRenderer.h"

namespace erdblick {

// TODO pass binary data instead.
static std::string glb = "./assets/Box.glb";

std::string FeatureLayerRenderer::test() {
  // Printf statements will end up in the console.
  printf("hello, world!\n");

  return glb;
}

}