#pragma once

#include <emscripten/bind.h>
#include <cstdint>
#include "buffer.h"
#include "rule.h"

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
