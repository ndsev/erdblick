#ifndef ERDBLICK_FEATURELAYERSTYLE_H
#define ERDBLICK_FEATURELAYERSTYLE_H

#include <emscripten/bind.h>
#include <cstdint>
#include "FeatureStyleRule.h"
#include "SharedUint8Array.h"

class FeatureLayerStyle
{
public:
    explicit FeatureLayerStyle(SharedUint8Array& yamlArray);
    [[nodiscard]] bool isValid() const;
    const std::vector<FeatureStyleRule>& rules();

private:
    std::vector<FeatureStyleRule> rules_;
    bool valid_ = false;
};

EMSCRIPTEN_BINDINGS(FeatureLayerStyleBind)
{
    emscripten::class_<FeatureLayerStyle>("FeatureLayerStyle").constructor<SharedUint8Array&>();
}

#endif  // ERDBLICK_FEATURELAYERSTYLE_H
