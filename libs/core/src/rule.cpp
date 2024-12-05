#include "rule.h"
#include <iostream>
#include "simfil/value.h"
#include "search.h"

namespace erdblick
{

namespace
{
std::optional<FeatureStyleRule::Arrow> parseArrowMode(std::string const& arrowStr) {
    if (arrowStr == "none") {
        return FeatureStyleRule::NoArrow;
    }
    if (arrowStr == "forward") {
        return FeatureStyleRule::ForwardArrow;
    }
    if (arrowStr == "backward") {
        return FeatureStyleRule::BackwardArrow;
    }
    if (arrowStr == "double") {
        return FeatureStyleRule::DoubleArrow;
    }

    std::cout << "Unsupported arrow mode: " << arrowStr << std::endl;
    return {};
}

std::optional<mapget::GeomType> parseGeometryEnum(std::string const& enumStr) {
    if (enumStr == "point") {
        return mapget::GeomType::Points;
    }
    if (enumStr == "mesh") {
        return mapget::GeomType::Mesh;
    }
    if (enumStr == "line") {
        return mapget::GeomType::Line;
    }
    if (enumStr == "polygon") {
        return mapget::GeomType::Polygon;
    }

    std::cout << "Unsupported geometry type: " << enumStr << std::endl;
    return {};
}
}

FeatureStyleRule::FeatureStyleRule(YAML::Node const& yaml, uint32_t index) : index_(index)
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
    /////////////////////////////////////
    /// Generic Rule Fields
    /////////////////////////////////////

    if (yaml["geometry"].IsDefined()) {
        // Parse target geometry types.
        geometryTypes_ = 0;  // Reset inherited geometry types.
        if (yaml["geometry"].IsSequence()) {
            for (auto const& geometryStr : yaml["geometry"]) {
                if (auto geomType = parseGeometryEnum(geometryStr.as<std::string>())) {
                    geometryTypes_ |= geomTypeBit(*geomType);
                }
            }
        }
        else if (auto geomType = parseGeometryEnum(yaml["geometry"].as<std::string>())) {
            geometryTypes_ |= geomTypeBit(*geomType);
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
        if (modeStr == "none") {
            mode_ = NoHighlight;
        }
        else if (modeStr == "hover") {
            mode_ = HoverHighlight;
        }
        else if (modeStr == "selection") {
            mode_ = SelectionHighlight;
        }
        else {
            std::cout << "Unsupported mode: " << modeStr << std::endl;
        }
    }
    if (yaml["type"].IsDefined()) {
        // Parse a feature type regular expression, e.g. `Lane|Boundary`
        type_ = yaml["type"].as<std::string>();
    }
    if (yaml["filter"].IsDefined()) {
        // Parse a simfil filter expression, e.g. `properties.functionalRoadClass == 4`
        filter_ = anyWrap(yaml["filter"].as<std::string>());
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
    if (yaml["color-expression"].IsDefined()) {
        // Set a simfil expression which returns an RGBA integer, or a parsable color.
        colorExpression_ = yaml["color-expression"].as<std::string>();
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
    if (yaml["vertical-offset"].IsDefined()) {
        // Parse option for the width of the feature outline color.
        offset_.y = yaml["vertical-offset"].as<double>();
    }
    if (yaml["offset"].IsDefined() && yaml["offset"].size() >= 1) {
        offset_.x = yaml["offset"][0].as<double>();
        offset_.y = yaml["offset"][1].as<double>();
        offset_.z = yaml["offset"][2].as<double>();
    }
    if (yaml["point-merge-grid-cell"].IsDefined() && yaml["point-merge-grid-cell"].size() >= 3) {
        pointMergeGridCellSize_ = glm::dvec3();
        pointMergeGridCellSize_->x = yaml["point-merge-grid-cell"][0].as<double>();
        pointMergeGridCellSize_->y = yaml["point-merge-grid-cell"][1].as<double>();
        pointMergeGridCellSize_->z = yaml["point-merge-grid-cell"][2].as<double>();
    }
    if (yaml["icon-url"].IsDefined()) {
        iconUrl_ = yaml["icon-url"].as<std::string>();
    }
    if (yaml["icon-url-expression"].IsDefined()) {
        iconUrlExpression_ = yaml["icon-url-expression"].as<std::string>();
    }

    /////////////////////////////////////
    /// Line Style Fields
    /////////////////////////////////////

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
    if (yaml["arrow-expression"].IsDefined()) {
        // Set a simfil expression which returns 'forward', 'backward' or 'double'.
        arrowExpression_ = yaml["arrow-expression"].as<std::string>();
    }

    /////////////////////////////////////
    /// Relation Rule Fields
    /////////////////////////////////////

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
        relationSourceStyle_ = std::make_shared<FeatureStyleRule>(*this, true);
        relationSourceStyle_->parse(yaml["relation-source-style"]);
    }
    if (yaml["relation-target-style"].IsDefined()) {
        // Parse style for the relation target geometry.
        relationTargetStyle_ = std::make_shared<FeatureStyleRule>(*this, true);
        relationTargetStyle_->parse(yaml["relation-target-style"]);
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

    /////////////////////////////////////
    /// Attribute Rule Fields
    /////////////////////////////////////

    if (yaml["attribute-type"].IsDefined()) {
        // Parse an attribute type regular expression, e.g. `SPEED_LIMIT_.*`
        attributeType_ = yaml["attribute-type"].as<std::string>();
    }
    if (yaml["attribute-mask"].IsDefined()) {
        // Parse an attribute based on it's field value, e.g. `speedLimitKmh > 100`
        attributeMask_ = yaml["attribute-mask"].as<std::string>();
    }
    if (yaml["attribute-layer-type"].IsDefined()) {
        // Parse an attribute type regular expression, e.g. `Road.*Layer`
        attributeLayerType_ = yaml["attribute-layer-type"].as<std::string>();
    }
    if (yaml["attribute-validity-geom"].IsDefined()) {
        // Parse an attribute validity requirement: any, required, or none
        auto reqValidityStr = yaml["attribute-validity-geom"].as<std::string>();
        if (reqValidityStr == "any")
            attributeValidityGeometry_.reset();
        else if (reqValidityStr == "required")
            attributeValidityGeometry_ = true;
        else if (reqValidityStr == "none")
            attributeValidityGeometry_ = false;
        else
            std::cout << "Unsupported validity requirement: " << reqValidityStr << std::endl;
    }

    /////////////////////////////////////
    /// Label Rule Fields
    /////////////////////////////////////

    // Parse labels' rules
    if (yaml["label-font"].IsDefined()) {
        // Parse label font
        labelFont_ = yaml["label-font"].as<std::string>();
    }
    if (yaml["label-color"].IsDefined()) {
        // Parse option to have a label background color.
        labelColor_ = Color(yaml["label-color"].as<std::string>()).toFVec4();
    }
    if (yaml["label-outline-color"].IsDefined()) {
        // Parse option to have a label background color.
        labelOutlineColor_ = Color(yaml["label-outline-color"].as<std::string>()).toFVec4();
    }
    if (yaml["label-outline-width"].IsDefined()) {
        // Parse option for the width of the label outline color.
        outlineWidth_ = yaml["label-outline-width"].as<float>();
    }
    if (yaml["label-background-color"].IsDefined()) {
        // Parse option to have a label background color.
        showBackground_ = true;
        labelBackgroundColor_ = Color(yaml["label-background-color"].as<std::string>()).toFVec4();
    }
    if (yaml["label-background-padding"].IsDefined()) {
        // Parse option to have a label padding.
        labelBackgroundPadding_ = yaml["label-background-padding"].as<std::pair<int, int>>();
    }
    if (yaml["label-horizontal-origin"].IsDefined()) {
        // Parse label horizontal origin
        labelHorizontalOrigin_ = yaml["label-horizontal-origin"].as<std::string>();
    }
    if (yaml["label-vertical-origin"].IsDefined()) {
        // Parse label vertical origin
        labelVerticalOrigin_ = yaml["label-vertical-origin"].as<std::string>();
    }
    if (yaml["label-text-expression"].IsDefined()) {
        // Parse label SIMFIL expression
        labelTextExpression_ = yaml["label-text-expression"].as<std::string>();
    }
    if (yaml["label-text"].IsDefined()) {
        // Parse label placeholder text
        labelText_ = yaml["label-text"].as<std::string>();
    }
    if (yaml["label-style"].IsDefined()) {
        // Parse label style string
        labelStyle_ = yaml["label-style"].as<std::string>();
    }
    if (yaml["label-scale"].IsDefined()) {
        // Parse label scale string
        labelScale_ = yaml["label-scale"].as<float>();
    }
    if (yaml["label-pixel-offset"].IsDefined()) {
        // Parse option to have a label padding.
        labelPixelOffset_ = yaml["label-pixel-offset"].as<std::pair<float, float>>();
    }
    if (yaml["label-eye-offset"].IsDefined()) {
        // Parse option to have a label padding.
        auto coordinates = yaml["label-eye-offset"].as<std::vector<float>>();
        if (coordinates.size() == 3) {
            labelEyeOffset_ = std::tuple<float, float, float>{coordinates.at(0), coordinates.at(1), coordinates.at(2)};
        }
    }
    if (yaml["translucency-by-distance"].IsDefined()) {
        // Parse option for near and far translucency properties of a Label based on the Label's distance from the camera.
        auto components = yaml["translucency-by-distance"].as<std::vector<float>>();
        if (components.size() >= 4) {
            translucencyByDistance_ = {.0};
            std::copy(components.begin(), components.begin()+4, translucencyByDistance_->begin());
        }
    }
    if (yaml["scale-by-distance"].IsDefined()) {
        // Parse option for near and far scale properties of a Label based on the Label's distance from the camera.
        auto components = yaml["scale-by-distance"].as<std::vector<float>>();
        if (components.size() >= 4) {
            scaleByDistance_ = {.0};
            std::copy(components.begin(), components.begin()+4, scaleByDistance_->begin());
        }
    }
    if (yaml["offset-scale-by-distance"].IsDefined()) {
        // Parse option for near and far offset scale properties of a Label based on the Label's distance from the camera.
        auto components = yaml["offset-scale-by-distance"].as<std::vector<float>>();
        if (components.size() >= 4) {
            offsetScaleByDistance_ = {.0};
            std::copy(components.begin(), components.begin()+4, offsetScaleByDistance_->begin());
        }
    }

    /////////////////////////////////////
    /// Sub-Rule Fields
    /////////////////////////////////////

    if (yaml["first-of"].IsDefined()) {
        for (auto yamlSubRule : yaml["first-of"]) {
            // The sub-rule adopts all attributes except type and filter
            auto& subRule = firstOfRules_.emplace_back(*this, true);
            subRule.parse(yamlSubRule);
        }
    }
}

FeatureStyleRule const* FeatureStyleRule::match(mapget::Feature& feature, BoundEvalFun const& evalFun) const
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
        if (!evalFun.eval_(filter_).as<simfil::ValueType::Bool>()) {
            return nullptr;
        }
    }

    // Return matching sub-rule or this.
    if (!firstOfRules_.empty()) {
        for (auto const& rule : firstOfRules_) {
            if (auto matchingRule = rule.match(feature, evalFun)) {
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
        auto colorVal = evalFun.eval_(colorExpression_);
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
        auto arrowVal = evalFun.eval_(arrowExpression_);
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

FeatureStyleRule::HighlightMode FeatureStyleRule::mode() const
{
    return mode_;
}

std::optional<std::regex> const& FeatureStyleRule::relationType() const
{
    return relationType_;
}

bool FeatureStyleRule::hasLabel() const
{
    return !labelTextExpression_.empty() || !labelText_.empty();
}

std::string const& FeatureStyleRule::labelFont() const
{
    return labelFont_;
}

glm::fvec4 const& FeatureStyleRule::labelColor() const
{
    return labelColor_;
}

glm::fvec4 const& FeatureStyleRule::labelOutlineColor() const
{
    return labelOutlineColor_;
}

float FeatureStyleRule::labelOutlineWidth() const
{
    return labelOutlineWidth_;
}

bool FeatureStyleRule::showBackground() const
{
    return showBackground_;
}

glm::fvec4 const& FeatureStyleRule::labelBackgroundColor() const
{
    return labelBackgroundColor_;
}

std::pair<int, int> const& FeatureStyleRule::labelBackgroundPadding() const
{
    return labelBackgroundPadding_;
}

std::string const& FeatureStyleRule::labelHorizontalOrigin() const
{
    return labelHorizontalOrigin_;
}

std::string const& FeatureStyleRule::labelVerticalOrigin() const
{
    return labelVerticalOrigin_;
}

std::string const& FeatureStyleRule::labelHeightReference() const
{
    return labelHeightReference_;
}

std::string const& FeatureStyleRule::labelTextExpression() const
{
    return labelTextExpression_;
}

std::string FeatureStyleRule::labelText(BoundEvalFun const& evalFun) const
{
    if (!labelTextExpression_.empty()) {
        auto resultVal = evalFun.eval_(labelTextExpression_);
        auto resultText = resultVal.toString();
        if (!resultText.empty()) {
            return resultText;
        }
        return labelText_;
    }
    return labelText_;
}

std::string const& FeatureStyleRule::labelStyle() const
{
    return labelStyle_;
}

float FeatureStyleRule::labelScale() const {
    return labelScale_;
}

std::optional<std::pair<float, float>> const& FeatureStyleRule::labelPixelOffset() const
{
    return labelPixelOffset_;
}

std::optional<std::tuple<float, float, float>> const& FeatureStyleRule::labelEyeOffset() const
{
    return labelEyeOffset_;
}

std::optional<std::array<float, 4>> const& FeatureStyleRule::translucencyByDistance() const
{
    return translucencyByDistance_;
}

std::optional<std::array<float, 4>> const& FeatureStyleRule::scaleByDistance() const
{
    return scaleByDistance_;
}

std::optional<std::array<float, 4>> const& FeatureStyleRule::offsetScaleByDistance() const
{
    return offsetScaleByDistance_;
}

glm::dvec3 const& FeatureStyleRule::offset() const
{
    return offset_;
}

std::optional<glm::dvec3> const& FeatureStyleRule::pointMergeGridCellSize() const
{
    return pointMergeGridCellSize_;
}

bool FeatureStyleRule::hasIconUrl() const
{
    return !iconUrl_.empty() || !iconUrlExpression_.empty();
}

std::string FeatureStyleRule::iconUrl(BoundEvalFun const& evalFun) const
{
    if (!iconUrlExpression_.empty()) {
        auto iconUrlVal = evalFun.eval_(iconUrlExpression_);
        if (iconUrlVal.isa(simfil::ValueType::String)) {
            return iconUrlVal.as<simfil::ValueType::String>();
        }
        std::cout << "Invalid result for iconUrl expression: " << iconUrlExpression_
                  << ": " << iconUrlVal.toString() << std::endl;
    }
    return iconUrl_;
}

std::optional<std::regex> const& FeatureStyleRule::attributeType() const
{
    return attributeType_;
}

std::optional<std::string> const& FeatureStyleRule::attributeMask() const
{
    return attributeMask_;
}

std::optional<std::regex> const& FeatureStyleRule::attributeLayerType() const
{
    return attributeLayerType_;
}

std::optional<bool> const& FeatureStyleRule::attributeValidityGeometry() const
{
    return attributeValidityGeometry_;
}

uint32_t const& FeatureStyleRule::index() const
{
    return index_;
}

}