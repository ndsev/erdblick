#ifndef ERDBLICK_FEATURELAYERSTYLE_H
#define ERDBLICK_FEATURELAYERSTYLE_H

#include <emscripten/bind.h>
#include <cstdint>
#include "featurestylerule.h"
#include "shareduint8array.h"

class FeatureLayerStyle
{
public:
    explicit FeatureLayerStyle(SharedUint8Array& yamlArray);
    [[nodiscard]] bool isValid() const;
    [[nodiscard]] const std::vector<FeatureStyleRule>& rules() const;

private:
    std::vector<FeatureStyleRule> rules_;
    bool valid_ = false;
};

#endif  // ERDBLICK_FEATURELAYERSTYLE_H
