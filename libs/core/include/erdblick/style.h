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
#include <vector>

namespace erdblick
{

/** Supported option value kinds for style-sheet level user-configurable settings. */
enum class FeatureStyleOptionType
{
    Bool,
    Color,
    String
};

/** User-facing stylesheet category used to distinguish ordinary and reusable search styles. */
enum class StyleCategory
{
    Base,
    Search
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

/** Literal or option-backed color used by a constrained interaction effect. */
struct InteractionEffectColor
{
    std::optional<glm::fvec4> literal;
    std::optional<std::string> optionId;
};

/** Presentation-only effect applied to already materialized interaction geometry. */
struct InteractionEffect
{
    std::optional<InteractionEffectColor> tint;
    float tintMix = 1.0f;
    float opacity = 1.0f;
    float edgeWidth = 0.0f;
    std::optional<InteractionEffectColor> haloColor;
    float haloRadius = 0.0f;
    float haloOpacity = 0.0f;
    std::optional<InteractionEffectColor> stripeColor;
    float stripeSpacing = 0.0f;
    float stripeWidth = 0.0f;
    float stripeOpacity = 0.0f;
    float stripeAngle = 45.0f;
    float stripeOffset = 0.0f;
    float stripeSoftness = 1.0f;

    [[nodiscard]] NativeJsValue toJsValue(NativeJsValue const& options) const;
};

/** One local Boolean option assignment contained in a style-level preset. */
struct FeatureStylePresetValue
{
    /** Construct an empty preset-value placeholder. */
    FeatureStylePresetValue() = default;
    /** Parse one validated preset-value declaration from YAML. */
    explicit FeatureStylePresetValue(YAML::Node const& yaml);

    std::string optionId_;
    bool value_ = false;
};

/** A named option combination owned by, and affine with, one feature-layer style. */
struct FeatureStylePreset
{
    /** Construct an empty preset placeholder. */
    FeatureStylePreset() = default;
    /** Parse one validated preset declaration from YAML. */
    explicit FeatureStylePreset(YAML::Node const& yaml);

    std::string id_;
    std::string name_;
    std::vector<FeatureStylePresetValue> values_;
};

/**
 * Parsed feature-layer style sheet containing rules, options, and quick lookup caches.
 *
 * The class front-loads YAML parsing and precomputes rule index tables so render
 * code can cheaply ask for relevant rules by highlight mode, LOD, and feature type.
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
    /** Return the declared style-level presets. */
    [[nodiscard]] const std::vector<FeatureStylePreset>& presets() const;
    /** Return the human-readable style name. */
    [[nodiscard]] std::string const& name() const;
    /** Return the declared stylesheet category; omitted category defaults to Base. */
    [[nodiscard]] StyleCategory category() const;
    /** Check whether the optional layer-affinity regex matches a layer name. */
    [[nodiscard]] bool hasLayerAffinity(std::string const& layerName) const;
    /** Report whether the style should start enabled in the UI. */
    [[nodiscard]] bool defaultEnabled() const;
    /** Return the bitmask of highlight modes for which this style has explicit rules. */
    [[nodiscard]] uint32_t supportedHighlightModesMask() const;
    /** Check whether the style declares rules for the given highlight mode. */
    [[nodiscard]] bool supportsHighlightMode(FeatureStyleRule::HighlightMode mode) const;
    /** Check whether the style declares a local/fetched overlay effect for the mode. */
    [[nodiscard]] bool supportsInteractionEffect(FeatureStyleRule::HighlightMode mode) const;
    /** Return the effect recipe as a plain JS object, or undefined when absent. */
    [[nodiscard]] NativeJsValue interactionEffect(
        FeatureStyleRule::HighlightMode mode,
        NativeJsValue const& options) const;
    /** Map one canonical visible-tile count onto the style's integer LOD ladder. */
    [[nodiscard]] uint8_t lodForVisibleTileCount(
        uint32_t visibleTileCount,
        uint32_t defaultLod3TileThreshold) const;
    /** Interpolate the density ladder for smooth GPU presentation transitions. */
    [[nodiscard]] double presentationLodForVisibleTileCount(
        uint32_t visibleTileCount,
        uint32_t defaultLod3TileThreshold) const;
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
        uint8_t lod,
        std::string_view featureTypeId) const;

private:
    static constexpr size_t kHighlightModeCount = 3;
    static constexpr size_t kLodCount = FeatureStyleRule::kMaximumLod + 1U;
    using RuleIndexList = std::vector<uint32_t>;

    /** Cached rule-index tables for one concrete feature type. */
    struct RuleIndexCacheEntry {
        std::array<std::array<RuleIndexList, kLodCount>, kHighlightModeCount> byModeAndLod{};
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
    std::vector<FeatureStylePreset> presets_;
    StyleValidationReport validationReport_;
    bool valid_ = false;
    bool enabled_ = true;
    std::string name_;
    StyleCategory category_ = StyleCategory::Base;
    std::optional<std::regex> layerAffinity_;
    std::array<std::array<RuleIndexList, kLodCount>, kHighlightModeCount> ruleIndicesByModeAndLod_{};
    std::optional<std::array<uint32_t, kLodCount - 1U>> lodThresholds_;
    uint32_t highlightModeMask_ = 0;
    std::array<std::optional<InteractionEffect>, 2> interactionEffects_{};
    mutable std::unordered_map<std::string, RuleIndexCacheEntry, TransparentStringHash, TransparentStringEqual>
        ruleIndicesByTypeCache_;
};

}
