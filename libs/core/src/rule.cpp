#include "rule.h"
#include <iostream>
#include "simfil/value.h"

namespace erdblick
{

FeatureStyleRule::FeatureStyleRule(YAML::Node const& yaml)
{
    parse(yaml);
}

void FeatureStyleRule::parse(const YAML::Node& yaml)
{
    if (yaml["geometry"].IsDefined())
        geometryTypes_ = 0; // Reset inherited geometry types.

    for (auto const& geometryStr : yaml["geometry"]) {
        auto g = geometryStr.as<std::string>();
        if (g == "point") {
            geometryTypes_ |= geomTypeBit(mapget::Geometry::GeomType::Points);
        }
        else if (g == "mesh") {
            geometryTypes_ |= geomTypeBit(mapget::Geometry::GeomType::Mesh);
        }
        else if (g == "line") {
            geometryTypes_ |= geomTypeBit(mapget::Geometry::GeomType::Line);
        }
        else if (g == "polygon") {
            geometryTypes_ |= geomTypeBit(mapget::Geometry::GeomType::Polygon);
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
    if (yaml["flat"].IsDefined()) {
        // Parse option to clamp feature to ground (ignoring height), defaults to false
        flat_ = yaml["flat"].as<bool>();
    }
    if (yaml["outline-color"].IsDefined()) {
        // Parse option to have a feature outline color.
        outlineColor_ = Color(yaml["outline-color"].as<std::string>()).toFVec4();
    }
    if (yaml["outline-width"].IsDefined()) {
        // Parse option for the width of the feature outline color.
        outlineWidth_ = yaml["outline-width"].as<float>();
    }
    if (yaml["near-far-scale"].IsDefined()) {
        // Parse option for the scale of the feature depending on camera distance.
        auto components = yaml["near-far-scale"].as<std::vector<float>>();
        if (components.size() >= 4) {
            nearFarScale_ = {.0};
            std::copy(components.begin(), components.begin()+4, nearFarScale_->begin());
        }
    }
    if (yaml["material-color"].IsDefined()) {
        materialColor_ = yaml["material-color"].as<std::string>();
    }
    if (yaml["dashed"].IsDefined()) {
        // Parse line dashes
        dashed_ = yaml["dashed"].as<bool>();
        if (yaml["dash-length"].IsDefined()) {
            dashLength_ = yaml["dash-length"].as<int>();
        }
        if (yaml["gap-color"].IsDefined()) {
            gapColor_ = yaml["gap-color"].as<std::string>();
        }
        if (yaml["dash-pattern"].IsDefined()) {
            dashPattern_ = yaml["dash-pattern"].as<int>();
        }
    }
    if (yaml["arrow"].IsDefined()) {
        // Parse line arrowheads
        auto arrow_ = yaml["arrow"].as<std::string>();
        hasDoubleArrow_ = arrow_ == "double";
        hasArrow_ = true;
    }

    // Parse sub-rules
    if (yaml["first-of"].IsDefined()) {
        for (auto yamlSubRule : yaml["first-of"]) {
            // The sub-rule adopts all attributes except type and filter
            auto& subRule = firstOfRules_.emplace_back(*this);
            subRule.type_.reset();
            subRule.filter_.clear();
            subRule.firstOfRules_.clear();
            subRule.parse(yamlSubRule);
        }
    }
}

FeatureStyleRule const* FeatureStyleRule::match(mapget::Feature& feature) const
{
    // Filter by feature type regular expression.
    if (type_) {
        auto typeId = feature.typeId();
        if (!std::regex_match(typeId.begin(), typeId.end(), *type_)) {
            return nullptr;
        }
    }

    // Filter by simfil expression.
    if (!filter_.empty()) {
        if (!feature.evaluate(filter_).as<simfil::ValueType::Bool>()) {
            return nullptr;
        }
    }

    // Return matching sub-rule or this.
    if (!firstOfRules_.empty()) {
        for (auto const& rule : firstOfRules_) {
            if (auto matchingRule = rule.match(feature)) {
                return matchingRule;
            }
        }
        return nullptr;
    }

    return this;
}

bool FeatureStyleRule::supports(const mapget::GeomType& g) const
{
    return geometryTypes_ & geomTypeBit(g);
}

glm::fvec4 const& FeatureStyleRule::color() const
{
    return color_;
}

float FeatureStyleRule::width() const
{
    return width_;
}

bool FeatureStyleRule::flat() const
{
    return flat_;
}

std::string FeatureStyleRule::materialColor() const
{
    return materialColor_;
}

bool FeatureStyleRule::isDashed() const
{
    return dashed_;
}

int FeatureStyleRule::dashLength() const
{
    return dashLength_;
}

std::string FeatureStyleRule::gapColor() const
{
    return gapColor_;
}

int FeatureStyleRule::dashPattern() const
{
    return dashPattern_;
}

bool FeatureStyleRule::hasArrow() const
{
    return hasArrow_;
}

bool FeatureStyleRule::hasDoubleArrow() const
{
    return hasDoubleArrow_;
}

glm::fvec4 const& FeatureStyleRule::outlineColor() const
{
    return outlineColor_;
}

float FeatureStyleRule::outlineWidth() const
{
    return outlineWidth_;
}

std::optional<std::array<float, 4>> const& FeatureStyleRule::nearFarScale() const
{
    return nearFarScale_;
}


}