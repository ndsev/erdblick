#pragma once

#include <cstdint>
#include "buffer.h"
#include "rule.h"

namespace erdblick
{

class FeatureLayerStyle
{
public:
    explicit FeatureLayerStyle(SharedUint8Array const& yamlArray);
    [[nodiscard]] bool isValid() const;
    [[nodiscard]] const std::vector<FeatureStyleRule>& rules() const;

private:
    std::vector<FeatureStyleRule> rules_;
    bool valid_ = false;
};

}