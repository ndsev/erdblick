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
/** Map highlight modes onto dense array indices for the precomputed rule caches. */
constexpr size_t highlightModeIndex(FeatureStyleRule::HighlightMode mode) {
    return static_cast<size_t>(mode);
}

/** Collapse fidelity into the two cache buckets used by `FeatureLayerStyle`. */
constexpr size_t fidelityIndex(FeatureStyleRule::Fidelity fidelity) {
    return fidelity == FeatureStyleRule::LowFidelity ? 1U : 0U;
}

/** Shared empty vector returned when no rule candidates apply. */
const std::vector<uint32_t> kEmptyRuleIndices{};
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

    if (auto name = styleYaml["name"]) {
        if (name.IsScalar())
            name_ = name.Scalar();
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

    if (auto stage = styleYaml["stage"]) {
        if (!stage.IsScalar()) {
            validationReport_.addIssue(
                "error",
                "schema",
                "stylesheet-failed",
                "Style sheet stage must be a scalar integer.",
                locationForNode(stage));
            validationReport_.markStylesheetFailed();
            return;
        }
        try {
            auto parsedStage = stage.as<int>();
            if (parsedStage < 0) {
                validationReport_.addIssue(
                    "error",
                    "schema",
                    "stylesheet-failed",
                    "Style sheet stage must be non-negative.",
                    locationForNode(stage));
                validationReport_.markStylesheetFailed();
                return;
            }
            stage_ = static_cast<uint32_t>(parsedStage);
        } catch (YAML::Exception const& e) {
            validationReport_.addIssue(
                "error",
                "schema",
                "stylesheet-failed",
                "Could not parse style sheet stage: " + e.msg,
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
            for (auto const& option : options) {
                if (!validateStyleOptionYaml(option, optionIndex++, styleSpec, validationReport_)) {
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
        auto modeIndex = highlightModeIndex(rule.mode());
        auto const highFidelityIndex = fidelityIndex(FeatureStyleRule::HighFidelity);
        auto const lowFidelityIndex = fidelityIndex(FeatureStyleRule::LowFidelity);
        if (rule.fidelity() == FeatureStyleRule::AnyFidelity ||
            rule.fidelity() == FeatureStyleRule::HighFidelity) {
            ruleIndicesByModeAndFidelity_[modeIndex][highFidelityIndex].push_back(runtimeRuleIndex);
        }
        if (rule.fidelity() == FeatureStyleRule::AnyFidelity ||
            rule.fidelity() == FeatureStyleRule::LowFidelity) {
            ruleIndicesByModeAndFidelity_[modeIndex][lowFidelityIndex].push_back(runtimeRuleIndex);
        }
        if (rule.fidelity() == FeatureStyleRule::LowFidelity) {
            hasExplicitLowFidelityRules_ = true;
        }
        highlightModeMask_ |= (1u << modeIndex);
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

bool FeatureLayerStyle::hasExplicitLowFidelityRules() const
{
    return hasExplicitLowFidelityRules_;
}

bool FeatureLayerStyle::hasRelationRules(FeatureStyleRule::HighlightMode mode) const
{
    return std::ranges::any_of(rules_, [mode](auto const& rule) {
        return rule.mode() == mode && rule.aspect() == FeatureStyleRule::Relation;
    });
}

std::vector<uint32_t> const& FeatureLayerStyle::candidateRuleIndices(
    FeatureStyleRule::HighlightMode mode,
    FeatureStyleRule::Fidelity fidelity,
    std::string_view featureTypeId) const
{
    auto modeIndex = highlightModeIndex(mode);
    auto fidelityIdx = fidelityIndex(fidelity);
    if (!supportsHighlightMode(mode)) {
        return kEmptyRuleIndices;
    }
    if (featureTypeId.empty()) {
        return ruleIndicesByModeAndFidelity_[modeIndex][fidelityIdx];
    }

    auto cacheIt = ruleIndicesByTypeCache_.find(featureTypeId);
    if (cacheIt == ruleIndicesByTypeCache_.end()) {
        RuleIndexCacheEntry entry{};
        for (size_t cacheModeIndex = 0; cacheModeIndex < kHighlightModeCount; ++cacheModeIndex) {
            for (size_t cacheFidelityIndex = 0; cacheFidelityIndex < kFidelityCount; ++cacheFidelityIndex) {
                auto const& ruleIndices = ruleIndicesByModeAndFidelity_[cacheModeIndex][cacheFidelityIndex];
                auto& filtered = entry.byModeAndFidelity[cacheModeIndex][cacheFidelityIndex];
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

    return cacheIt->second.byModeAndFidelity[modeIndex][fidelityIdx];
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
