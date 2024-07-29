#pragma once

#include <cstdint>
#include "buffer.h"
#include "rule.h"
#include "cesium-interface/object.h"

namespace erdblick
{

enum class FeatureStyleOptionType
{
    Bool,
};

struct FeatureStyleOption
{
    FeatureStyleOption(YAML::Node const& yaml);

    std::string label_;
    std::string id_;
    FeatureStyleOptionType type_;
    NativeJsValue defaultValue_;
    std::string description_;
};

class FeatureLayerStyle
{
public:
    explicit FeatureLayerStyle(SharedUint8Array const& yamlArray);
    [[nodiscard]] bool isValid() const;
    [[nodiscard]] const std::vector<FeatureStyleRule>& rules() const;
    [[nodiscard]] const std::vector<FeatureStyleOption>& options() const;

private:
    std::vector<FeatureStyleRule> rules_;
    std::vector<FeatureStyleOption> options_;
    bool valid_ = false;
};

}