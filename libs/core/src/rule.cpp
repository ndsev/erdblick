#include "rule.h"
#include <iostream>

namespace erdblick
{

FeatureStyleRule::FeatureStyleRule(YAML::Node const& yaml)
{
    // Parse the geometry specifiers into a vector of simfil geometry types.
    if (!yaml["geometry"] || !(yaml["geometry"].IsSequence())) {
        std::cout << "YAML stylesheet error: Every rule must specify a 'geometry' sequence!"
                  << std::endl;
        return;
    }

    for (auto const& geometryStr : yaml["geometry"]) {
        auto g = geometryStr.as<std::string>();
        if (g == "point") {
            geometryTypes_.push_back(simfil::Geometry::GeomType::Points);
        }
        else if (g == "mesh") {
            geometryTypes_.push_back(simfil::Geometry::GeomType::Mesh);
        }
        else if (g == "line") {
            geometryTypes_.push_back(simfil::Geometry::GeomType::Line);
        }
        else {
            std::cout << "Unsupported geometry type: " << g << std::endl;
            return;
        }
    }

    // Parse optional fields.
    if (yaml["type"]) {
        type_ = yaml["type"].as<std::string>();
    }
    if (yaml["filter"]) {
        filter_ = yaml["filter"].as<std::string>();
    }
    if (yaml["color"]) {
        color_ = Color(yaml["color"].as<std::string>());
    }
    if (yaml["opacity"]) {
        opacity_ = yaml["opacity"].as<float>();
    }
}

bool FeatureStyleRule::match(const mapget::Feature&) const
{
    // TODO check for matching type pattern, filter.
    return true;
}

const std::vector<simfil::Geometry::GeomType>& FeatureStyleRule::geometryTypes() const
{
    return geometryTypes_;
}

const std::string& FeatureStyleRule::typeIdPattern() const
{
    return type_;
}

const std::string& FeatureStyleRule::filter() const
{
    return filter_;
}

float FeatureStyleRule::opacity() const
{
    return opacity_;
}

Color const& FeatureStyleRule::color() const
{
    return color_;
}

}