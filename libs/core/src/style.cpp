#include <iostream>
#include <regex>

#include "yaml-cpp/yaml.h"
#include "simfil/simfil.h"
#include "simfil/model/nodes.h"

#include "style.h"

namespace erdblick
{

FeatureLayerStyle::FeatureLayerStyle(SharedUint8Array const& yamlArray)
{
    auto styleSpec = yamlArray.toString();

    // Convert char vector to YAML node.
    auto styleYaml = YAML::Load(styleSpec);

    if (auto name = styleYaml["name"]) {
        if (name.IsScalar())
            name_ = name.Scalar();
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

std::string const& FeatureLayerStyle::name() const {
    return name_;
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
}

}
