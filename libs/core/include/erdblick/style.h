#pragma once

#include <cstdint>
#include "buffer.h"
#include "rule.h"
#include "cesium-interface/cesium-object.h"

#include <array>
#include <string_view>
#include <unordered_map>
#include <regex>
#include <optional>

namespace erdblick
{

enum class FeatureStyleOptionType
{
    Bool,
    Color,
    String
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
    bool internal_ = false;

    template <class LambdaT>
    void convertValue(std::string const& v, LambdaT callback) const {
        switch (type_) {
        case FeatureStyleOptionType::Bool:
            callback(std::ranges::equal(
                v,
                std::string_view("true"),
                [](char a, char b) { return std::tolower(a) == std::tolower(b); }));
            break;
        case FeatureStyleOptionType::String:
        case FeatureStyleOptionType::Color:
            callback(v);
            break;
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
    [[nodiscard]] std::string const& name() const;
    [[nodiscard]] bool hasLayerAffinity(std::string const& layerName) const;
    [[nodiscard]] bool defaultEnabled() const;
    [[nodiscard]] uint32_t supportedHighlightModesMask() const;
    [[nodiscard]] bool supportsHighlightMode(FeatureStyleRule::HighlightMode mode) const;
    [[nodiscard]] std::vector<uint32_t> const& candidateRuleIndices(
        FeatureStyleRule::HighlightMode mode,
        std::string_view featureTypeId) const;

private:
    static constexpr size_t kHighlightModeCount = 3;
    using RuleIndexList = std::vector<uint32_t>;
    struct RuleIndexCacheEntry {
        std::array<RuleIndexList, kHighlightModeCount> byMode{};
    };
    struct TransparentStringHash {
        using is_transparent = void;
        size_t operator()(std::string_view value) const noexcept {
            return std::hash<std::string_view>{}(value);
        }
        size_t operator()(std::string const& value) const noexcept {
            return std::hash<std::string_view>{}(value);
        }
    };
    struct TransparentStringEqual {
        using is_transparent = void;
        bool operator()(std::string const& lhs, std::string const& rhs) const noexcept {
            return lhs == rhs;
        }
        bool operator()(std::string_view lhs, std::string_view rhs) const noexcept {
            return lhs == rhs;
        }
        bool operator()(std::string const& lhs, std::string_view rhs) const noexcept {
            return std::string_view(lhs) == rhs;
        }
        bool operator()(std::string_view lhs, std::string const& rhs) const noexcept {
            return lhs == std::string_view(rhs);
        }
    };

    std::vector<FeatureStyleRule> rules_;
    std::vector<FeatureStyleOption> options_;
    bool valid_ = false;
    bool enabled_ = true;
    std::string name_;
    std::optional<std::regex> layerAffinity_;
    std::array<RuleIndexList, kHighlightModeCount> ruleIndicesByMode_{};
    uint32_t highlightModeMask_ = 0;
    mutable std::unordered_map<std::string, RuleIndexCacheEntry, TransparentStringHash, TransparentStringEqual>
        ruleIndicesByTypeCache_;
};

}
