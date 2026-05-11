#pragma once

#include <cstdint>
#include "buffer.h"
#include "rule.h"
#include "interop/js-object.h"
#include "style-validation.h"

#include <array>
#include <string_view>
#include <unordered_map>
#include <regex>
#include <optional>

namespace erdblick
{

/** Supported option value kinds for style-sheet level user-configurable settings. */
enum class FeatureStyleOptionType
{
    Bool,
    Color,
    String
};

/**
 * One configurable option declared at the top level of a style sheet.
 *
 * Options are exposed to the frontend and later injected into simfil
 * evaluation contexts so rules can branch on user-controlled values.
 */
struct FeatureStyleOption
{
    /** Construct an empty option placeholder. */
    FeatureStyleOption() = default;
    /** Parse one option declaration from YAML. */
    explicit FeatureStyleOption(YAML::Node const& yaml);

    std::string label_;
    std::string id_;
    FeatureStyleOptionType type_ = FeatureStyleOptionType::Bool;
    NativeJsValue defaultValue_;
    std::string description_;
    bool internal_ = false;

    /** Convert a persisted string value into the option's typed runtime representation. */
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

/**
 * Parsed feature-layer style sheet containing rules, options, and quick lookup caches.
 *
 * The class front-loads YAML parsing and precomputes rule index tables so render
 * code can cheaply ask for relevant rules by highlight mode, fidelity, and feature type.
 */
class FeatureLayerStyle
{
public:
    /** Parse a style sheet from YAML stored in a byte buffer. */
    explicit FeatureLayerStyle(SharedUint8Array const& yamlArray);
    /** Report whether parsing succeeded and yielded a usable style. */
    [[nodiscard]] bool isValid() const;
    /** Return the structured validation report from the last parse. */
    [[nodiscard]] NativeJsValue validationReport() const;
    /** Return the rules in source order. */
    [[nodiscard]] const std::vector<FeatureStyleRule>& rules() const;
    /** Return the declared style options. */
    [[nodiscard]] const std::vector<FeatureStyleOption>& options() const;
    /** Return the human-readable style name. */
    [[nodiscard]] std::string const& name() const;
    /** Check whether the optional layer-affinity regex matches a layer name. */
    [[nodiscard]] bool hasLayerAffinity(std::string const& layerName) const;
    /** Report whether the style should start enabled in the UI. */
    [[nodiscard]] bool defaultEnabled() const;
    /** Return the minimum data stage required before this style should render. */
    [[nodiscard]] uint32_t minimumStage() const;
    /** Return the bitmask of highlight modes for which this style has explicit rules. */
    [[nodiscard]] uint32_t supportedHighlightModesMask() const;
    /** Check whether the style declares rules for the given highlight mode. */
    [[nodiscard]] bool supportsHighlightMode(FeatureStyleRule::HighlightMode mode) const;
    /** Report whether the style differentiates explicitly between low-fi and high-fi rules. */
    [[nodiscard]] bool hasExplicitLowFidelityRules() const;
    /** Check whether any rule for the given highlight mode targets relations. */
    [[nodiscard]] bool hasRelationRules(FeatureStyleRule::HighlightMode mode) const;
    /**
     * Return the candidate rule indices for a feature type in the requested render pass.
     *
     * The returned vector is borrowed from an internal cache and remains valid for the
     * lifetime of the style object.
     */
    [[nodiscard]] std::vector<uint32_t> const& candidateRuleIndices(
        FeatureStyleRule::HighlightMode mode,
        FeatureStyleRule::Fidelity fidelity,
        std::string_view featureTypeId) const;

private:
    static constexpr size_t kHighlightModeCount = 3;
    static constexpr size_t kFidelityCount = 2;
    using RuleIndexList = std::vector<uint32_t>;

    /** Cached rule-index tables for one concrete feature type. */
    struct RuleIndexCacheEntry {
        std::array<std::array<RuleIndexList, kFidelityCount>, kHighlightModeCount> byModeAndFidelity{};
    };

    /** Heterogeneous hash for the feature-type cache. */
    struct TransparentStringHash {
        using is_transparent = void;
        size_t operator()(std::string_view value) const noexcept {
            return std::hash<std::string_view>{}(value);
        }
        size_t operator()(std::string const& value) const noexcept {
            return std::hash<std::string_view>{}(value);
        }
    };

    /** Heterogeneous equality predicate for the feature-type cache. */
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
    StyleValidationReport validationReport_;
    bool valid_ = false;
    bool enabled_ = true;
    uint32_t stage_ = 0;
    std::string name_;
    std::optional<std::regex> layerAffinity_;
    std::array<std::array<RuleIndexList, kFidelityCount>, kHighlightModeCount> ruleIndicesByModeAndFidelity_{};
    uint32_t highlightModeMask_ = 0;
    bool hasExplicitLowFidelityRules_ = false;
    mutable std::unordered_map<std::string, RuleIndexCacheEntry, TransparentStringHash, TransparentStringEqual>
        ruleIndicesByTypeCache_;
};

}
