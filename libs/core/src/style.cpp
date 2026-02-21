#include <algorithm>
#include <iostream>
#include <regex>

#include "yaml-cpp/yaml.h"
#include "simfil/simfil.h"
#include "simfil/model/nodes.h"

#include "style.h"

namespace erdblick
{

namespace {
constexpr size_t highlightModeIndex(FeatureStyleRule::HighlightMode mode) {
    return static_cast<size_t>(mode);
}
const std::vector<uint32_t> kEmptyRuleIndices{};
}

FeatureLayerStyle::FeatureLayerStyle(SharedUint8Array const& yamlArray)
{
    auto styleSpec = yamlArray.toString();

    // Convert char vector to YAML node.
    auto styleYaml = YAML::Load(styleSpec);

    if (auto name = styleYaml["name"]) {
        if (name.IsScalar())
            name_ = name.Scalar();
    }

    if (auto enabled = styleYaml["default"]) {
        if (enabled.IsScalar())
            enabled_ = enabled.as<bool>();
    }

    if (auto stage = styleYaml["stage"]) {
        if (stage.IsScalar()) {
            stage_ = static_cast<uint32_t>(std::max(0, stage.as<int>()));
        }
    }

    if (auto layer = styleYaml["layer"]) {
        if (layer.IsScalar())
            layerAffinity_ = layer.as<std::string>();
    }

    if (!styleYaml["rules"] || !(styleYaml["rules"].IsSequence())) {
        std::cout << "YAML stylesheet error: Spec does not contain any rules?" << std::endl;
        return;
    }

    uint32_t ruleIndex = 0;
    for (auto const& rule : styleYaml["rules"]) {
        // Create FeatureStyleRule object.
        rules_.emplace_back(rule, ruleIndex++);
    }

    for (auto const& option : styleYaml["options"]) {
        // Create FeatureStyleOption object.
        options_.emplace_back(option);
    }

    for (auto const& rule : rules_) {
        auto modeIndex = highlightModeIndex(rule.mode());
        ruleIndicesByMode_[modeIndex].push_back(rule.index());
        highlightModeMask_ |= (1u << modeIndex);
    }

    valid_ = true;
}

bool FeatureLayerStyle::isValid() const
{
    return valid_;
}

const std::vector<FeatureStyleRule>& FeatureLayerStyle::rules() const
{
    return rules_;
}

const std::vector<FeatureStyleOption>& FeatureLayerStyle::options() const
{
    return options_;
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

uint32_t FeatureLayerStyle::minimumStage() const
{
    return stage_;
}

std::string const& FeatureLayerStyle::name() const {
    return name_;
}

uint32_t FeatureLayerStyle::supportedHighlightModesMask() const
{
    return highlightModeMask_;
}

bool FeatureLayerStyle::supportsHighlightMode(FeatureStyleRule::HighlightMode mode) const
{
    return (highlightModeMask_ & (1u << highlightModeIndex(mode))) != 0;
}

std::vector<uint32_t> const& FeatureLayerStyle::candidateRuleIndices(
    FeatureStyleRule::HighlightMode mode,
    std::string_view featureTypeId) const
{
    auto modeIndex = highlightModeIndex(mode);
    if (!supportsHighlightMode(mode)) {
        return kEmptyRuleIndices;
    }
    if (featureTypeId.empty()) {
        return ruleIndicesByMode_[modeIndex];
    }

    auto cacheIt = ruleIndicesByTypeCache_.find(featureTypeId);
    if (cacheIt == ruleIndicesByTypeCache_.end()) {
        RuleIndexCacheEntry entry{};
        for (size_t cacheModeIndex = 0; cacheModeIndex < kHighlightModeCount; ++cacheModeIndex) {
            auto const& ruleIndices = ruleIndicesByMode_[cacheModeIndex];
            auto& filtered = entry.byMode[cacheModeIndex];
            filtered.reserve(ruleIndices.size());
            for (auto ruleIndex : ruleIndices) {
                if (rules_[ruleIndex].maybeMatchesType(featureTypeId)) {
                    filtered.push_back(ruleIndex);
                }
            }
        }
        auto [insertIt, _] = ruleIndicesByTypeCache_.emplace(std::string(featureTypeId), std::move(entry));
        cacheIt = insertIt;
    }

    return cacheIt->second.byMode[modeIndex];
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

}
