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

    for (YAML::detail::iterator_value rule : styleYaml["rules"]) {
        // Parse the geometry specifiers into a vector of simfil geometry types.
        if (!rule["geometry"] || !(rule["geometry"].IsSequence())) {
            std::cout << "YAML stylesheet error: Every rule must specify a 'geometry' sequence!"
                      << std::endl;
            return;
        }
        // TODO use GeometryTypeBitmask instead!
        auto geometryTypes = std::vector<simfil::Geometry::GeomType>{};
        std::string typePattern;
        std::string filter;
        std::string color = "255,255,255";
        float opacity = 1.0;

        for (YAML::detail::iterator_value geometryStr : rule["geometry"]) {
            auto g = geometryStr.as<std::string>();
            if (g == "point") {
                geometryTypes.push_back(simfil::Geometry::GeomType::Points);
            }
            else if (g == "mesh") {
                geometryTypes.push_back(simfil::Geometry::GeomType::Mesh);
            }
            else if (g == "line") {
                geometryTypes.push_back(simfil::Geometry::GeomType::Line);
            }
            else {
                std::cout << "Unsupported geometry type: " << g << std::endl;
                return;
            }
        }

        // Parse optional fields.
        if (rule["type"]) {
            typePattern = rule["type"].as<std::string>();
        }
        if (rule["filter"]) {
            filter = rule["filter"].as<std::string>();
        }
        if (rule["color"]) {
            // TODO AfwColor-style class + color parsing from string/sequence.
        }
        if (rule["opacity"]) {
            opacity = rule["opacity"].as<float>();
        }

        // Create FeatureStyleRule object.
        // TODO store rules by the feature they apply to for faster processing.
        rules_.emplace_back(geometryTypes, typePattern, filter, opacity);
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
