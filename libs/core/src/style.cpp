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

    if (!styleYaml["rules"] || !(styleYaml["rules"].IsSequence())) {
        std::cout << "YAML stylesheet error: Spec does not contain any rules?" << std::endl;
        return;
    }

    for (auto const& rule : styleYaml["rules"]) {
        // Create FeatureStyleRule object.
        // TODO store rules by the feature they apply to for faster processing.
        rules_.emplace_back(rule);
    }

    valid_ = true;

    std::cout << "Parsed a style YAML!" << std::endl;
}

bool FeatureLayerStyle::isValid() const
{
    return valid_;
}

const std::vector<FeatureStyleRule>& FeatureLayerStyle::rules() const
{
    return rules_;
}

}
