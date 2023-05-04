#ifndef ERDBLICK_FEATURELAYERRENDERER_H
#define ERDBLICK_FEATURELAYERRENDERER_H

namespace erdblick {

class FeatureLayerRenderer {

public:
  std::vector<uint8_t> render(
      const std::string& dummyFeatureLayer,
      const std::string& dummyIdCache);
  uint8_t test();

};

}
#endif // ERDBLICK_FEATURELAYERRENDERER_H
