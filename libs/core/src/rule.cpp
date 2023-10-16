#include "rule.h"
#include <iostream>
#include "simfil/value.h"

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
        else if (g == "polygon") {
            geometryTypes_.push_back(simfil::Geometry::GeomType::Polygon);
        }
        else {
            std::cout << "Unsupported geometry type: " << g << std::endl;
            return;
        }
    }

    // Parse optional fields.
    if (yaml["type"].IsDefined()) {
        // Parse a feature type regular expression, e.g. `Lane|Boundary`
        type_ = yaml["type"].as<std::string>();
    }
    if (yaml["filter"].IsDefined()) {
        // Parse a simfil filter expression, e.g. `properties.functionalRoadClass == 4`
        filter_ = yaml["filter"].as<std::string>();
    }
    if (yaml["color"].IsDefined()) {
        // Parse a CSS color
        color_ = Color(yaml["color"].as<std::string>()).toFVec4();
    }
    if (yaml["opacity"].IsDefined()) {
        // Parse an opacity float value in range 0..1
        color_.a = yaml["opacity"].as<float>();
    }
    if (yaml["width"].IsDefined()) {
        // Parse a line width, defaults to pixels
        width_ = yaml["width"].as<float>();
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

glm::fvec4 const& FeatureStyleRule::color() const
{
    return color_;
}

float FeatureStyleRule::width() const
{
    return width_;
}

}