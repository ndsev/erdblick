#include <vector>
#include <string>

#include "tiny_gltf.h"
#include "duckfile.c"

#include "include/FeatureLayerRenderer.h"

namespace erdblick {

uint32_t FeatureLayerRenderer::test_binary_size() {
  return duckfile_len;
}

uint8_t* FeatureLayerRenderer::test_binary() {
  // Printf statements will end up in the console.
  printf("hello, world!\n");

  auto buffer_size = test_binary_size();
  uint8_t duck[buffer_size];

  for (int i = 0; i < buffer_size; i++) {
    duck[i] = duckfile[i];
  }

  auto ptr = &duck[0];
  return ptr;
}

}