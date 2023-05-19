#include <vector>
#include <string>

#include "tiny_gltf.h"
#include "boxfile.c"

#include "include/FeatureLayerRenderer.h"

uint32_t FeatureLayerRenderer::test_binary_size() {
  return boxfile_len;
}

void FeatureLayerRenderer::test_binary(char *memoryBuffer) {
  // Printf statements will end up in the console.
  printf("hello, world!\n");
  auto buffer_size = test_binary_size();
  std::memcpy(memoryBuffer, boxfile, buffer_size);
}

__UINT64_TYPE__ FeatureLayerRenderer::test_binary_two() {
  auto buffer_size = test_binary_size();
  auto ptr = malloc(buffer_size);
  std::memcpy(ptr, boxfile, buffer_size);
  return reinterpret_cast<__UINT64_TYPE__>(ptr);
}
