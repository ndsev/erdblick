#include "rule.h"
#include <iostream>
#include "simfil/value.h"

namespace erdblick
{

namespace
{
std::optional<FeatureStyleRule::Arrow> parseArrowMode(std::string const& arrowStr) {
    if (arrowStr == "none") {
        return FeatureStyleRule::NoArrow;
    }
    else if (arrowStr == "forward") {
        return FeatureStyleRule::ForwardArrow;
    }
    else if (arrowStr == "backward") {
        return FeatureStyleRule::BackwardArrow;
    }
    else if (arrowStr == "double") {
        return FeatureStyleRule::DoubleArrow;
    }

    std::cout << "Unsupported arrow mode: " << arrowStr << std::endl;
    return {};
}
}

FeatureStyleRule::FeatureStyleRule(YAML::Node const& yaml)
{
    parse(yaml);
}

FeatureStyleRule::FeatureStyleRule(const FeatureStyleRule& other, bool resetNonInheritableAttrs)
{
    *this = other;
    if (resetNonInheritableAttrs) {
        type_.reset();
        filter_.clear();
        firstOfRules_.clear();
    }
}

void FeatureStyleRule::parse(const YAML::Node& yaml)
{
    if (yaml["geometry"].IsDefined()) {
        // Parse target geometry types.
        geometryTypes_ = 0;  // Reset inherited geometry types.
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
            }
        }
    }
    if (yaml["aspect"].IsDefined()) {
        // Parse the feature aspect that is covered by this rule.
        auto aspectStr = yaml["aspect"].as<std::string>();
        if (aspectStr == "feature") {
            aspect_ = Feature;
        }
        else if (aspectStr == "relation") {
            aspect_ = Relation;
        }
        else if (aspectStr == "attribute") {
            aspect_ = Attribute;
        }
        else {
            std::cout << "Unsupported aspect: " << aspectStr << std::endl;
            return;
        }
    }
    if (yaml["mode"].IsDefined()) {
        // Parse the feature aspect that is covered by this rule.
        auto modeStr = yaml["mode"].as<std::string>();
        if (modeStr == "normal") {
            mode_ = Normal;
        }
        else if (modeStr == "highlight") {
            mode_ = Highlight;
        }
        else {
            std::cout << "Unsupported mode: " << modeStr << std::endl;
            return;
        }
    }
    if (yaml["type"].IsDefined()) {
        // Parse a feature type regular expression, e.g. `Lane|Boundary`
        type_ = yaml["type"].as<std::string>();
    }
    if (yaml["filter"].IsDefined()) {
        // Parse a simfil filter expression, e.g. `properties.functionalRoadClass == 4`
        filter_ = yaml["filter"].as<std::string>();
    }
    if (yaml["selectable"].IsDefined()) {
        // Parse the selectable flag.
        selectable_ = yaml["selectable"].as<bool>();
    }
    if (yaml["color"].IsDefined()) {
        // Parse a CSS color
        auto colorStr = yaml["color"].as<std::string>();
        color_ = Color(colorStr).toFVec4();
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
    if (yaml["relation-type"].IsDefined()) {
        // Parse a relation type regular expression, e.g. `connectedFrom|connectedTo`
        relationType_ = yaml["relation-type"].as<std::string>();
    }
    if (yaml["relation-line-height-offset"].IsDefined()) {
        // Parse vertical offset for relation line in meters.
        relationLineHeightOffset_ = yaml["relation-line-height-offset"].as<float>();
    }
    if (yaml["relation-line-end-markers"].IsDefined()) {
        // Parse style for the relation line end-markers.
        relationLineEndMarkerStyle_ = std::make_shared<FeatureStyleRule>(*this, true);
        relationLineEndMarkerStyle_->parse(yaml["relation-line-end-markers"]);
    }
    if (yaml["relation-source-style"].IsDefined()) {
        // Parse style for the relation source geometry.
        relationLineEndMarkerStyle_ = std::make_shared<FeatureStyleRule>(*this, true);
        relationLineEndMarkerStyle_->parse(yaml["relation-source-style"]);
    }
    if (yaml["relation-target-style"].IsDefined()) {
        // Parse style for the relation target geometry.
        relationLineEndMarkerStyle_ = std::make_shared<FeatureStyleRule>(*this, true);
        relationLineEndMarkerStyle_->parse(yaml["relation-target-style"]);
    }
    if (yaml["relation-recursive"].IsDefined()) {
        // Parse whether relations should be resolved recursively.
        // This is only done if mode==Highlight, and only works for
        // relations within the same layer.
        relationRecursive_ = yaml["relation-recursive"].as<bool>();
    }
    if (yaml["relation-merge-twoway"].IsDefined()) {
        // Parse whether bidirectional relations should be followed and merged.
        relationMergeTwoWay_ = yaml["relation-merge-twoway"].as<bool>();
    }
    if (yaml["dashed"].IsDefined()) {
        // Parse line dashes
        dashed_ = yaml["dashed"].as<bool>();
        if (yaml["dash-length"].IsDefined()) {
            dashLength_ = yaml["dash-length"].as<int>();
        }
        if (yaml["gap-color"].IsDefined()) {
            auto colorStr = yaml["gap-color"].as<std::string>();
            gapColor_ = Color(colorStr).toFVec4();
        }
        if (yaml["dash-pattern"].IsDefined()) {
            dashPattern_ = yaml["dash-pattern"].as<int>();
        }
    }
    if (yaml["arrow"].IsDefined()) {
        // Parse line arrowheads
        auto arrowStr = yaml["arrow"].as<std::string>();
        if (auto arrowMode = parseArrowMode(arrowStr))
            arrow_ = *arrowMode;
    }

    // Parse sub-rules
    if (yaml["first-of"].IsDefined()) {
        for (auto yamlSubRule : yaml["first-of"]) {
            // The sub-rule adopts all attributes except type and filter
            auto& subRule = firstOfRules_.emplace_back(*this, true);
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

glm::fvec4 FeatureStyleRule::color(BoundEvalFun const& evalFun) const
{
    if (!colorExpression_.empty()) {
        auto colorVal = evalFun(colorExpression_);
        if (colorVal.isa(simfil::ValueType::Int)) {
            auto colorInt = colorVal.as<simfil::ValueType::Int>();
            auto a = static_cast<float>(colorInt & 0xff) / 255.;
            colorInt >>= 8;
            auto b = static_cast<float>(colorInt & 0xff) / 255.;
            colorInt >>= 8;
            auto g = static_cast<float>(colorInt & 0xff) / 255.;
            colorInt >>= 8;
            auto r = static_cast<float>(colorInt & 0xff) / 255.;
            return {r, g, b, a};
        }
        else if (colorVal.isa(simfil::ValueType::String)) {
            auto colorStr = colorVal.as<simfil::ValueType::String>();
            return Color(colorStr.c_str()).toFVec4(color_.a);
        }
        else
            std::cout << "Invalid result for color expression: " << colorExpression_
                      << ": " << colorVal.toString() << std::endl;
    }
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

bool FeatureStyleRule::isDashed() const
{
    return dashed_;
}

int FeatureStyleRule::dashLength() const
{
    return dashLength_;
}

glm::fvec4 const& FeatureStyleRule::gapColor() const
{
    return gapColor_;
}

int FeatureStyleRule::dashPattern() const
{
    return dashPattern_;
}

FeatureStyleRule::Arrow FeatureStyleRule::arrow(BoundEvalFun const& evalFun) const
{
    if (!arrowExpression_.empty()) {
        auto arrowVal = evalFun(arrowExpression_);
        if (arrowVal.isa(simfil::ValueType::String)) {
            auto arrowStr = arrowVal.as<simfil::ValueType::String>();
            if (auto arrowMode = parseArrowMode(arrowStr))
                return *arrowMode;
        }

        std::cout << "Invalid result for arrow expression: " << arrowExpression_
                  << ": " << arrowVal.toString() << std::endl;
    }
    return arrow_;
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

float FeatureStyleRule::relationLineHeightOffset() const
{
    return relationLineHeightOffset_;
}

FeatureStyleRule::Aspect FeatureStyleRule::aspect() const
{
    return aspect_;
}

std::shared_ptr<FeatureStyleRule> FeatureStyleRule::relationLineEndMarkerStyle() const
{
    return relationLineEndMarkerStyle_;
}

std::shared_ptr<FeatureStyleRule> FeatureStyleRule::relationSourceStyle() const
{
    return relationSourceStyle_;
}

std::shared_ptr<FeatureStyleRule> FeatureStyleRule::relationTargetStyle() const
{
    return relationTargetStyle_;
}

bool FeatureStyleRule::relationRecursive() const
{
    return relationRecursive_;
}

bool FeatureStyleRule::relationMergeTwoWay() const
{
    return relationMergeTwoWay_;
}

bool FeatureStyleRule::selectable() const
{
    return selectable_;
}

FeatureStyleRule::Mode FeatureStyleRule::mode() const
{
    return mode_;
}

std::optional<std::regex> const& FeatureStyleRule::relationType() const
{
    return relationType_;
}

}