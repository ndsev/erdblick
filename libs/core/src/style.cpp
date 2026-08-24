#include <algorithm>
#include <cmath>
#include <iostream>
#include <limits>
#include <regex>
#include <set>

#include "yaml-cpp/yaml.h"
#include "simfil/simfil.h"
#include "simfil/model/nodes.h"

#include "style.h"

namespace erdblick
{

namespace {
/** Map highlight modes onto dense array indices for the precomputed rule caches. */
constexpr size_t highlightModeIndex(FeatureStyleRule::HighlightMode mode) {
    return static_cast<size_t>(mode);
}

/** Clamp an externally supplied LOD before indexing fixed rule caches. */
constexpr size_t lodIndex(uint8_t lod) {
    return std::min<size_t>(lod, FeatureStyleRule::kMaximumLod);
}

/** Derive the default seven density boundaries around the LOD-3 threshold. */
std::array<uint32_t, 7> defaultLodThresholds(uint32_t lod3Threshold)
{
    auto const threshold = std::clamp(
        lod3Threshold,
        16U,
        std::numeric_limits<uint32_t>::max() / 4U);
    return {
        threshold * 4U,
        threshold * 2U,
        threshold,
        threshold / 2U,
        threshold / 4U,
        threshold / 8U,
        threshold / 16U,
    };
}

/** Shared empty vector returned when no rule candidates apply. */
const std::vector<uint32_t> kEmptyRuleIndices{};

std::optional<size_t> interactionEffectIndex(
    FeatureStyleRule::HighlightMode mode)
{
    if (mode == FeatureStyleRule::HoverHighlight) {
        return 0U;
    }
    if (mode == FeatureStyleRule::SelectionHighlight) {
        return 1U;
    }
    return std::nullopt;
}

std::optional<InteractionEffectColor> parseInteractionColor(
    YAML::Node const& node)
{
    if (!node.IsDefined()) {
        return std::nullopt;
    }
    if (node.IsScalar()) {
        Color color(node.as<std::string>());
        if (!color.isValid()) {
            return std::nullopt;
        }
        return InteractionEffectColor{color.toFVec4(), std::nullopt};
    }
    if (node.IsMap() && node["option"].IsScalar()) {
        auto const option = node["option"].as<std::string>();
        if (!option.empty()) {
            return InteractionEffectColor{std::nullopt, option};
        }
    }
    return std::nullopt;
}

JsValue interactionColorToJs(
    InteractionEffectColor const& color,
    std::string const& literalField,
    std::string const& optionField,
    JsValue const& options)
{
    auto result = JsValue::Dict();
    auto resolved = color.literal;
    if (!resolved && color.optionId && options.has(*color.optionId)) {
        auto const option = options[*color.optionId];
        if (option.type() == JsValue::Type::String) {
            Color parsed(option.toString());
            if (parsed.isValid()) {
                resolved = parsed.toFVec4();
            }
        }
    }
    if (resolved) {
        auto const& value = *resolved;
        auto byte = [](float component) {
            return static_cast<uint8_t>(std::round(
                std::clamp(component, 0.0f, 1.0f) * 255.0f));
        };
        result.set(literalField, JsValue::List({
            JsValue(byte(value.r)),
            JsValue(byte(value.g)),
            JsValue(byte(value.b)),
            JsValue(byte(value.a)),
        }));
    }
    if (color.optionId) {
        result.set(optionField, JsValue(*color.optionId));
    }
    return result;
}
}

NativeJsValue InteractionEffect::toJsValue(NativeJsValue const& options_) const
{
    JsValue const options(options_);
    auto result = JsValue::Dict({
        {"tintMix", JsValue(tintMix)},
        {"opacity", JsValue(opacity)},
        {"edgeWidth", JsValue(edgeWidth)},
        {"haloRadius", JsValue(haloRadius)},
        {"haloOpacity", JsValue(haloOpacity)},
        {"stripeSpacing", JsValue(stripeSpacing)},
        {"stripeWidth", JsValue(stripeWidth)},
        {"stripeOpacity", JsValue(stripeOpacity)},
        {"stripeAngle", JsValue(stripeAngle)},
        {"stripeOffset", JsValue(stripeOffset)},
        {"stripeSoftness", JsValue(stripeSoftness)},
    });
    if (tint) {
        auto color = interactionColorToJs(
            *tint,
            "tint",
            "tintOption",
            options);
        if (color.has("tint")) result.set("tint", color["tint"]);
        if (color.has("tintOption")) result.set("tintOption", color["tintOption"]);
    }
    if (haloColor) {
        auto color = interactionColorToJs(
            *haloColor,
            "haloColor",
            "haloColorOption",
            options);
        if (color.has("haloColor")) {
            result.set("haloColor", color["haloColor"]);
        }
        if (color.has("haloColorOption")) {
            result.set("haloColorOption", color["haloColorOption"]);
        }
    }
    if (stripeColor) {
        auto color = interactionColorToJs(
            *stripeColor,
            "stripeColor",
            "stripeColorOption",
            options);
        if (color.has("stripeColor")) {
            result.set("stripeColor", color["stripeColor"]);
        }
        if (color.has("stripeColorOption")) {
            result.set("stripeColorOption", color["stripeColorOption"]);
        }
    }
    return *result;
}

FeatureLayerStyle::FeatureLayerStyle(SharedUint8Array const& yamlArray)
{
    auto styleSpec = yamlArray.toString();

    YAML::Node styleYaml;
    try {
        // Convert char vector to YAML node.
        styleYaml = YAML::Load(styleSpec);
    } catch (YAML::Exception const& e) {
        auto location = locationFromMark(e.mark);
        validationReport_.addIssue(
            "error",
            "yaml",
            "stylesheet-failed",
            "Could not parse style YAML: " + e.msg,
            location);
        validationReport_.markStylesheetFailed();
        return;
    }

    if (!validateTopLevelStyleYaml(styleYaml, validationReport_)) {
        return;
    }

    if (auto const thresholds = styleYaml["lod-thresholds"];
        thresholds.IsDefined())
    {
        std::array<uint32_t, kLodCount - 1U> parsed{};
        for (size_t index = 0; index < parsed.size(); ++index) {
            parsed[index] = thresholds[index].as<uint32_t>();
        }
        lodThresholds_ = parsed;
    }

    if (auto name = styleYaml["name"]) {
        if (name.IsScalar())
            name_ = name.Scalar();
    }

    if (auto category = styleYaml["category"]; category && category.Scalar() == "search") {
        category_ = StyleCategory::Search;
    }

    if (auto enabled = styleYaml["default"]) {
        if (!enabled.IsScalar()) {
            validationReport_.addIssue(
                "error",
                "schema",
                "stylesheet-failed",
                "Style sheet default must be a scalar boolean.",
                locationForNode(enabled));
            validationReport_.markStylesheetFailed();
            return;
        }
        try {
            enabled_ = enabled.as<bool>();
        } catch (YAML::Exception const& e) {
            validationReport_.addIssue(
                "error",
                "schema",
                "stylesheet-failed",
                "Could not parse style sheet default: " + e.msg,
                locationFromMark(e.mark));
            validationReport_.markStylesheetFailed();
            return;
        }
    }

    if (auto layer = styleYaml["layer"]) {
        if (!layer.IsScalar()) {
            validationReport_.addIssue(
                "error",
                "schema",
                "stylesheet-failed",
                "Style sheet layer affinity must be a scalar regular expression.",
                locationForNode(layer));
            validationReport_.markStylesheetFailed();
            return;
        }
        try {
            layerAffinity_ = layer.as<std::string>();
        } catch (std::regex_error const& e) {
            validationReport_.addIssue(
                "error",
                "schema",
                "stylesheet-failed",
                std::string("Invalid layer affinity regular expression: ") + e.what(),
                locationForNode(layer));
            validationReport_.markStylesheetFailed();
            return;
        }
    }

    if (auto options = styleYaml["options"]) {
        if (!options.IsSequence()) {
            validationReport_.addIssue(
                "warning",
                "schema",
                "option-skipped",
                "Style sheet options must be a YAML sequence. Ignoring options.",
                locationForNode(options));
        } else {
            uint32_t optionIndex = 0;
            std::set<std::string> seenOptionIds;
            for (auto const& option : options) {
                if (!validateStyleOptionYaml(option, optionIndex++, styleSpec, validationReport_)) {
                    continue;
                }
                auto const optionId = option["id"].Scalar();
                if (!seenOptionIds.insert(optionId).second) {
                    auto& issue = validationReport_.addIssue(
                        "warning",
                        "schema",
                        "option-skipped",
                        "Duplicate style option id '" + optionId + "' was ignored.",
                        locationForNode(option["id"]));
                    issue.rulePath = "options[" + std::to_string(optionIndex - 1) + "]";
                    issue.property = "id";
                    continue;
                }
                try {
                    // Create FeatureStyleOption object.
                    options_.emplace_back(option);
                } catch (YAML::Exception const& e) {
                    auto& issue = validationReport_.addIssue(
                        "warning",
                        "schema",
                        "option-skipped",
                        "Could not parse style option: " + e.msg,
                        locationFromMark(e.mark));
                    issue.rulePath = "options[" + std::to_string(optionIndex - 1) + "]";
                }
            }
        }
    }

    if (auto effects = styleYaml["interaction-effects"]) {
        if (!effects.IsMap()) {
            validationReport_.addIssue(
                "warning",
                "schema",
                "interaction-effect-skipped",
                "interaction-effects must be a map keyed by hover and selection.",
                locationForNode(effects));
        }
        else {
            for (auto const& [modeName, modeIndex] : {
                     std::pair<std::string_view, size_t>{"hover", 0U},
                     std::pair<std::string_view, size_t>{"selection", 1U}})
            {
                auto effectYaml = effects[std::string(modeName)];
                if (!effectYaml.IsDefined()) {
                    continue;
                }
                auto fail = [&](std::string message, YAML::Node const& node) {
                    auto& issue = validationReport_.addIssue(
                        "warning",
                        "schema",
                        "interaction-effect-skipped",
                        std::move(message),
                        locationForNode(node));
                    issue.rulePath =
                        "interaction-effects." + std::string(modeName);
                    issue.property = "interaction-effects";
                };
                if (!effectYaml.IsMap()) {
                    fail("Interaction effect must be a YAML map.", effectYaml);
                    continue;
                }
                try {
                    InteractionEffect effect;
                    if (effectYaml["tint"].IsDefined()) {
                        effect.tint = parseInteractionColor(effectYaml["tint"]);
                        if (!effect.tint) {
                            fail(
                                "Interaction tint must be a literal color or {option: id}.",
                                effectYaml["tint"]);
                            continue;
                        }
                    }
                    if (effectYaml["tint-mix"].IsDefined()) {
                        effect.tintMix = effectYaml["tint-mix"].as<float>();
                    }
                    if (effectYaml["opacity"].IsDefined()) {
                        effect.opacity = effectYaml["opacity"].as<float>();
                    }
                    if (effectYaml["edge-width"].IsDefined()) {
                        effect.edgeWidth = effectYaml["edge-width"].as<float>();
                    }
                    if (auto halo = effectYaml["halo"]) {
                        if (!halo.IsMap() || !halo["color"].IsDefined()) {
                            fail(
                                "Interaction halo must be a map with a color.",
                                halo);
                            continue;
                        }
                        effect.haloColor =
                            parseInteractionColor(halo["color"]);
                        if (!effect.haloColor) {
                            fail(
                                "Interaction halo color must be a literal color or {option: id}.",
                                halo["color"]);
                            continue;
                        }
                        if (halo["radius"].IsDefined()) {
                            effect.haloRadius = halo["radius"].as<float>();
                        }
                        if (halo["opacity"].IsDefined()) {
                            effect.haloOpacity = halo["opacity"].as<float>();
                        }
                    }
                    if (auto stripe = effectYaml["stripe"]) {
                        if (!stripe.IsMap()) {
                            fail("Interaction stripe must be a YAML map.", stripe);
                            continue;
                        }
                        if (stripe["color"].IsDefined()) {
                            effect.stripeColor =
                                parseInteractionColor(stripe["color"]);
                            if (!effect.stripeColor) {
                                fail(
                                    "Interaction stripe color must be a literal color or {option: id}.",
                                    stripe["color"]);
                                continue;
                            }
                        }
                        if (stripe["spacing"].IsDefined()) {
                            effect.stripeSpacing = stripe["spacing"].as<float>();
                        }
                        if (stripe["width"].IsDefined()) {
                            effect.stripeWidth = stripe["width"].as<float>();
                        }
                        if (stripe["opacity"].IsDefined()) {
                            effect.stripeOpacity = stripe["opacity"].as<float>();
                        }
                        if (stripe["angle"].IsDefined()) {
                            effect.stripeAngle = stripe["angle"].as<float>();
                        }
                        if (stripe["offset"].IsDefined()) {
                            effect.stripeOffset = stripe["offset"].as<float>();
                        }
                        if (stripe["softness"].IsDefined()) {
                            effect.stripeSoftness = stripe["softness"].as<float>();
                        }
                    }
                    if (!std::isfinite(effect.tintMix) ||
                        effect.tintMix < 0.0f || effect.tintMix > 1.0f ||
                        !std::isfinite(effect.opacity) ||
                        effect.opacity < 0.0f || effect.opacity > 1.0f ||
                        !std::isfinite(effect.edgeWidth) ||
                        effect.edgeWidth < 0.0f ||
                        !std::isfinite(effect.haloRadius) ||
                        effect.haloRadius < 0.0f ||
                        !std::isfinite(effect.haloOpacity) ||
                        effect.haloOpacity < 0.0f || effect.haloOpacity > 1.0f ||
                        !std::isfinite(effect.stripeSpacing) ||
                        effect.stripeSpacing < 0.0f ||
                        !std::isfinite(effect.stripeWidth) ||
                        effect.stripeWidth < 0.0f ||
                        !std::isfinite(effect.stripeOpacity) ||
                        effect.stripeOpacity < 0.0f || effect.stripeOpacity > 1.0f ||
                        !std::isfinite(effect.stripeAngle) ||
                        !std::isfinite(effect.stripeOffset) ||
                        !std::isfinite(effect.stripeSoftness) ||
                        effect.stripeSoftness < 0.0f)
                    {
                        fail(
                            "Interaction effect numeric values are outside their supported ranges.",
                            effectYaml);
                        continue;
                    }
                    interactionEffects_[modeIndex] = std::move(effect);
                }
                catch (YAML::Exception const& exception) {
                    fail(
                        "Could not parse interaction effect: " + exception.msg,
                        effectYaml);
                }
            }
        }
    }

    if (auto presets = styleYaml["presets"]) {
        if (!presets.IsSequence()) {
            validationReport_.addIssue(
                "warning",
                "schema",
                "preset-skipped",
                "Style sheet presets must be a YAML sequence. Ignoring presets.",
                locationForNode(presets));
        } else if (presets.size() > 200) {
            validationReport_.addIssue(
                "warning",
                "schema",
                "preset-skipped",
                "Style sheet presets exceed the limit of 200 entries. Ignoring presets.",
                locationForNode(presets));
        } else {
            std::set<std::string> knownOptionIds;
            std::set<std::string> editableBooleanOptionIds;
            for (auto const& option : options_) {
                knownOptionIds.insert(option.id_);
                if (option.type_ == FeatureStyleOptionType::Bool && !option.internal_) {
                    editableBooleanOptionIds.insert(option.id_);
                }
            }

            std::set<std::string> seenPresetIds;
            std::set<std::string> seenPresetNames;
            uint32_t presetIndex = 0;
            for (auto const& preset : presets) {
                auto const sourcePresetIndex = presetIndex++;
                auto const presetPath = "presets[" + std::to_string(sourcePresetIndex) + "]";
                if (!validateStylePresetYaml(
                        preset,
                        sourcePresetIndex,
                        knownOptionIds,
                        editableBooleanOptionIds,
                        validationReport_)) {
                    continue;
                }

                auto const presetId = preset["id"].Scalar();
                auto const presetName = preset["name"].Scalar();
                if (seenPresetIds.contains(presetId)) {
                    auto& issue = validationReport_.addIssue(
                        "warning",
                        "schema",
                        "preset-skipped",
                        "Duplicate style preset id '" + presetId + "' was ignored.",
                        locationForNode(preset["id"]));
                    issue.rulePath = presetPath;
                    issue.property = "id";
                    continue;
                }
                if (seenPresetNames.contains(presetName)) {
                    auto& issue = validationReport_.addIssue(
                        "warning",
                        "schema",
                        "preset-skipped",
                        "Duplicate style preset name '" + presetName + "' was ignored.",
                        locationForNode(preset["name"]));
                    issue.rulePath = presetPath;
                    issue.property = "name";
                    continue;
                }
                try {
                    presets_.emplace_back(preset);
                    seenPresetIds.insert(presetId);
                    seenPresetNames.insert(presetName);
                } catch (YAML::Exception const& e) {
                    auto& issue = validationReport_.addIssue(
                        "warning",
                        "schema",
                        "preset-skipped",
                        "Could not parse style preset: " + e.msg,
                        locationFromMark(e.mark));
                    issue.rulePath = presetPath;
                }
            }
        }
    }

    uint32_t ruleIndex = 0;
    uint32_t renderRuleIndex = 0;
    for (auto const& rule : styleYaml["rules"]) {
        auto const sourceRuleIndex = ruleIndex++;
        auto const rulePath = "rules[" + std::to_string(sourceRuleIndex) + "]";
        if (!validateStyleRuleYaml(rule, sourceRuleIndex, rulePath, styleSpec, validationReport_)) {
            ++validationReport_.skippedRuleCount;
            continue;
        }
        try {
            // Preserve the source rule index for diagnostics and rule-scoped runtime state.
            rules_.emplace_back(rule, sourceRuleIndex);
            rules_.back().assignRenderRuleIndices(renderRuleIndex);
        } catch (std::exception const& e) {
            ++validationReport_.skippedRuleCount;
            auto& issue = validationReport_.addIssue(
                "error",
                "schema",
                "rule-skipped",
                std::string("Could not parse style rule: ") + e.what(),
                locationForNode(rule));
            issue.ruleIndex = sourceRuleIndex;
            issue.rulePath = rulePath;
        }
    }

    if (rules_.empty()) {
        validationReport_.addIssue(
            "error",
            "schema",
            "stylesheet-failed",
            "Style sheet did not contain any usable rules.",
            locationForNode(styleYaml["rules"]));
        validationReport_.markStylesheetFailed();
        return;
    }

    for (uint32_t runtimeRuleIndex = 0; runtimeRuleIndex < rules_.size(); ++runtimeRuleIndex) {
        auto const& rule = rules_[runtimeRuleIndex];
        for (size_t modeIndex = 0; modeIndex < kHighlightModeCount; ++modeIndex) {
            auto const mode = static_cast<FeatureStyleRule::HighlightMode>(modeIndex);
            if (!rule.supportsMode(mode)) {
                continue;
            }
            for (uint8_t lod = FeatureStyleRule::kMinimumLod;
                 lod <= FeatureStyleRule::kMaximumLod;
                 ++lod)
            {
                if (rule.supportsLod(lod)) {
                    ruleIndicesByModeAndLod_[modeIndex][lod].push_back(
                        runtimeRuleIndex);
                }
            }
            highlightModeMask_ |= (1u << modeIndex);
        }
    }

    validationReport_.loadedRuleCount = static_cast<uint32_t>(rules_.size());
    validationReport_.loadable = true;
    validationReport_.failedWholeStyleSheet = false;
    valid_ = true;
}

bool FeatureLayerStyle::isValid() const
{
    return valid_;
}

NativeJsValue FeatureLayerStyle::validationReport() const
{
    return validationReport_.toJsValue();
}

const std::vector<FeatureStyleRule>& FeatureLayerStyle::rules() const
{
    return rules_;
}

const std::vector<FeatureStyleOption>& FeatureLayerStyle::options() const
{
    return options_;
}

const std::vector<FeatureStylePreset>& FeatureLayerStyle::presets() const
{
    return presets_;
}

bool FeatureLayerStyle::hasLayerAffinity(std::string const& layerName) const {
    if (!layerAffinity_) {
        return true;
    }
    return std::regex_match(layerName.begin(), layerName.end(), *layerAffinity_);
}

bool FeatureLayerStyle::defaultEnabled() const
{
    return enabled_;
}

std::string const& FeatureLayerStyle::name() const {
    return name_;
}

StyleCategory FeatureLayerStyle::category() const {
    return category_;
}

uint32_t FeatureLayerStyle::supportedHighlightModesMask() const
{
    return highlightModeMask_;
}

bool FeatureLayerStyle::supportsHighlightMode(FeatureStyleRule::HighlightMode mode) const
{
    return (highlightModeMask_ & (1u << highlightModeIndex(mode))) != 0;
}

bool FeatureLayerStyle::supportsInteractionEffect(
    FeatureStyleRule::HighlightMode mode) const
{
    auto const index = interactionEffectIndex(mode);
    return index && interactionEffects_[*index].has_value();
}

NativeJsValue FeatureLayerStyle::interactionEffect(
    FeatureStyleRule::HighlightMode mode,
    NativeJsValue const& options) const
{
    auto const index = interactionEffectIndex(mode);
    if (!index || !interactionEffects_[*index]) {
        return *JsValue::Undefined();
    }
    return interactionEffects_[*index]->toJsValue(options);
}

uint8_t FeatureLayerStyle::lodForVisibleTileCount(
    uint32_t visibleTileCount,
    uint32_t defaultLod3TileThreshold) const
{
    auto const thresholds = lodThresholds_.value_or(
        defaultLodThresholds(defaultLod3TileThreshold));
    for (uint8_t lod = FeatureStyleRule::kMinimumLod;
         lod < FeatureStyleRule::kMaximumLod;
         ++lod)
    {
        if (visibleTileCount >= thresholds[lod]) {
            return lod;
        }
    }
    return FeatureStyleRule::kMaximumLod;
}

bool FeatureLayerStyle::hasRelationRules(FeatureStyleRule::HighlightMode mode) const
{
    return std::ranges::any_of(rules_, [mode](auto const& rule) {
        return rule.supportsMode(mode) && rule.scope() == FeatureStyleRule::Relation;
    });
}

std::vector<uint32_t> const& FeatureLayerStyle::candidateRuleIndices(
    FeatureStyleRule::HighlightMode mode,
    uint8_t lod,
    std::string_view featureTypeId) const
{
    auto modeIndex = highlightModeIndex(mode);
    auto const activeLodIndex = lodIndex(lod);
    if (!supportsHighlightMode(mode)) {
        return kEmptyRuleIndices;
    }
    if (featureTypeId.empty()) {
        return ruleIndicesByModeAndLod_[modeIndex][activeLodIndex];
    }

    auto cacheIt = ruleIndicesByTypeCache_.find(featureTypeId);
    if (cacheIt == ruleIndicesByTypeCache_.end()) {
        RuleIndexCacheEntry entry{};
        for (size_t cacheModeIndex = 0; cacheModeIndex < kHighlightModeCount; ++cacheModeIndex) {
            for (size_t cacheLodIndex = 0; cacheLodIndex < kLodCount; ++cacheLodIndex) {
                auto const& ruleIndices = ruleIndicesByModeAndLod_[cacheModeIndex][cacheLodIndex];
                auto& filtered = entry.byModeAndLod[cacheModeIndex][cacheLodIndex];
                filtered.reserve(ruleIndices.size());
                for (auto ruleIndex : ruleIndices) {
                    if (rules_[ruleIndex].maybeMatchesType(featureTypeId)) {
                        filtered.push_back(ruleIndex);
                    }
                }
            }
        }
        auto [insertIt, _] = ruleIndicesByTypeCache_.emplace(std::string(featureTypeId), std::move(entry));
        cacheIt = insertIt;
    }

    return cacheIt->second.byModeAndLod[modeIndex][activeLodIndex];
}

FeatureStyleOption::FeatureStyleOption(const YAML::Node& yaml)
{
    if (auto node = yaml["label"]) {
        label_ = node.as<std::string>();
    }
    if (auto node = yaml["id"]) {
        id_ = node.as<std::string>();
    }
    else {
        std::cout << "Option has a missing id field!" << std::endl;
    }
    if (auto node = yaml["type"]) {
        auto type = node.as<std::string>();
        if (type == "bool") {
            type_ = FeatureStyleOptionType::Bool;
        }
        else if (type == "color") {
            type_ = FeatureStyleOptionType::Color;
        }
        else if (type == "string") {
            type_ = FeatureStyleOptionType::String;
        }
        else {
            // TODO: Eventually we need to throw an exception here.
            std::cout << "Unrecognized option type " << type << std::endl;
        }
    }
    if (auto node = yaml["default"]) {
        if (node.IsScalar())
            convertValue(node.Scalar(), [this](auto&& v){
                defaultValue_ = *JsValue(v);
            });
        else
            std::cout << "Default option value must be a scalar." << std::endl;
    }
    if (auto node = yaml["description"]) {
        description_ = node.as<std::string>();
    }
    if (auto node = yaml["internal"]) {
        internal_ = node.as<bool>();
    }
}

FeatureStylePresetValue::FeatureStylePresetValue(YAML::Node const& yaml)
    : optionId_(yaml["optionId"].as<std::string>()),
      value_(yaml["value"].as<bool>())
{
}

FeatureStylePreset::FeatureStylePreset(YAML::Node const& yaml)
    : id_(yaml["id"].as<std::string>()),
      name_(yaml["name"].as<std::string>())
{
    values_.reserve(yaml["values"].size());
    for (auto const& value : yaml["values"]) {
        values_.emplace_back(value);
    }
}

}
