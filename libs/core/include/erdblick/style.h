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
    FeatureStyleOption() = default;
    explicit FeatureStyleOption(YAML::Node const& yaml);

    std::string label_;
    std::string id_;
    FeatureStyleOptionType type_ = FeatureStyleOptionType::Bool;
    NativeJsValue defaultValue_;
    std::string description_;

    template <class LambdaT>
    void convertValue(std::string const& v, LambdaT callback) const {
        switch (type_) {
        case FeatureStyleOptionType::Bool:
            callback(std::ranges::equal(
                v,
                std::string_view("true"),
                [](char a, char b) { return std::tolower(a) == std::tolower(b); }));
        }
    }
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