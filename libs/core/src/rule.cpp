#include "rule.h"
#include <algorithm>
#include <charconv>
#include <cctype>
#include <cmath>
#include <iostream>
#include "simfil/value.h"
#include "search.h"

namespace erdblick
{

namespace
{
/** Parse the YAML arrow keyword into the enum used by rendering code. */
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

/** Parse one geometry keyword from YAML into the corresponding mapget geometry enum. */
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
    if (enumStr == "aabb") {
        return mapget::GeomType::AABB;
    }
    if (enumStr == "gltf") {
        return mapget::GeomType::GltfNodeIndex;
    }

    std::cout << "Unsupported geometry type: " << enumStr << std::endl;
    return {};
}

/** Parse a typed YAML scalar without stringifying numeric/category keys. */
FeatureStyleRule::ColorScaleStop::Key parseColorScaleKey(YAML::Node const& node)
{
    auto const scalar = node.Scalar();
    auto const tag = node.Tag();
    if (tag == "!" || tag.ends_with(":str")) {
        return scalar;
    }
    if (scalar == "true") {
        return true;
    }
    if (scalar == "false") {
        return false;
    }
    int64_t integer = 0;
    auto const integerResult = std::from_chars(
        scalar.data(),
        scalar.data() + scalar.size(),
        integer);
    if (integerResult.ec == std::errc{} &&
        integerResult.ptr == scalar.data() + scalar.size())
    {
        return integer;
    }
    char* end = nullptr;
    auto const number = std::strtod(scalar.c_str(), &end);
    if (end == scalar.c_str() + scalar.size() && std::isfinite(number)) {
        return number;
    }
    return scalar;
}

/** Convert a SIMFIL scalar into one typed color-scale key. */
std::optional<FeatureStyleRule::ColorScaleStop::Key> colorScaleKey(simfil::Value const& value)
{
    if (value.isa(simfil::ValueType::Bool)) {
        return value.as<simfil::ValueType::Bool>();
    }
    if (value.isa(simfil::ValueType::Int)) {
        return value.as<simfil::ValueType::Int>();
    }
    if (value.isa(simfil::ValueType::Float)) {
        auto number = value.as<simfil::ValueType::Float>();
        return std::isfinite(number)
            ? std::optional<FeatureStyleRule::ColorScaleStop::Key>{number}
            : std::nullopt;
    }
    if (value.isa(simfil::ValueType::String)) {
        return value.as<simfil::ValueType::String>();
    }
    return std::nullopt;
}

std::optional<double> numericColorScaleKey(
    FeatureStyleRule::ColorScaleStop::Key const& key)
{
    if (auto integer = std::get_if<int64_t>(&key)) {
        return static_cast<double>(*integer);
    }
    if (auto number = std::get_if<double>(&key)) {
        return *number;
    }
    return std::nullopt;
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
        branchMode_ = BranchMode::None;
        subRules_.clear();
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
    if (yaml["scope"].IsDefined()) {
        auto scopeStr = yaml["scope"].as<std::string>();
        if (scopeStr == "feature") {
            scope_ = Feature;
        }
        else if (scopeStr == "relation") {
            scope_ = Relation;
        }
        else if (scopeStr == "attribute") {
            scope_ = Attribute;
        }
        else {
            std::cout << "Unsupported scope: " << scopeStr << std::endl;
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
    if (yaml["fidelity"].IsDefined()) {
        auto fidelityStr = yaml["fidelity"].as<std::string>();
        if (fidelityStr == "any") {
            fidelity_ = AnyFidelity;
        }
        else if (fidelityStr == "high") {
            fidelity_ = HighFidelity;
        }
        else if (fidelityStr == "low") {
            fidelity_ = LowFidelity;
        }
        else {
            std::cout << "Unsupported fidelity: " << fidelityStr << std::endl;
        }
    }
    if (yaml["geometry-name"].IsDefined()) {
        auto name = yaml["geometry-name"].as<std::string>();
        geometryName_ = name == "*" ? std::nullopt : std::optional<std::string>{std::move(name)};
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
        hasExplicitColor_ = true;
    }
    if (yaml["color-expression"].IsDefined()) {
        // Set a simfil expression which returns an RGBA integer, or a parsable color.
        colorExpression_ = yaml["color-expression"].as<std::string>();
        hasExplicitColor_ = true;
    }
    if (yaml["color-scale"].IsDefined()) {
        auto const scaleYaml = yaml["color-scale"];
        ColorScale scale;
        scale.mode = scaleYaml["mode"].as<std::string>() == "categorical"
            ? ColorScale::Mode::Categorical
            : ColorScale::Mode::Linear;
        scale.expression = scaleYaml["expression"].as<std::string>();
        for (auto const& stopYaml : scaleYaml["stops"]) {
            scale.stops.push_back(ColorScaleStop{
                parseColorScaleKey(stopYaml[0]),
                Color(stopYaml[1].as<std::string>()).toFVec4(),
            });
        }
        if (scaleYaml["fallback"].IsDefined()) {
            scale.fallback = Color(scaleYaml["fallback"].as<std::string>()).toFVec4();
        }
        colorScale_ = std::move(scale);
        hasExplicitColor_ = true;
    }
    if (yaml["opacity"].IsDefined()) {
        // Parse an opacity float value in range 0..1
        color_.a = yaml["opacity"].as<float>();
        hasExplicitOpacity_ = true;
    }
    if (yaml["width"].IsDefined()) {
        // Parse a line width, defaults to pixels
        width_ = yaml["width"].as<float>();
    }
    if (yaml["width-scale"].IsDefined()) {
        auto const scaleYaml = yaml["width-scale"];
        WidthScale scale;
        scale.mode =
            scaleYaml["mode"].as<std::string>() == "categorical"
                ? ColorScale::Mode::Categorical
                : ColorScale::Mode::Linear;
        scale.expression =
            scaleYaml["expression"].as<std::string>();
        for (auto const& stopYaml : scaleYaml["stops"]) {
            scale.stops.push_back(WidthScaleStop{
                parseColorScaleKey(stopYaml[0]),
                stopYaml[1].as<float>(),
            });
        }
        if (scaleYaml["fallback"].IsDefined()) {
            scale.fallback =
                scaleYaml["fallback"].as<float>();
        }
        widthScale_ = std::move(scale);
    }
    if (yaml["glow"].IsDefined()) {
        auto const glowYaml = yaml["glow"];
        Glow glow;
        if (glowYaml["color"].IsDefined()) {
            glow.color = Color(
                glowYaml["color"].as<std::string>()).toFVec4();
        }
        if (glowYaml["radius"].IsDefined()) {
            glow.radius = glowYaml["radius"].as<float>();
        }
        if (glowYaml["opacity"].IsDefined()) {
            glow.opacity = glowYaml["opacity"].as<float>();
        }
        glow_ = glow;
    }
    if (yaml["depth-test"].IsDefined()) {
        depthTest_ = yaml["depth-test"].as<bool>();
    }
    if (yaml["billboard"].IsDefined()) {
        // Parse whether the rendered primitive should face the camera.
        billboard_ = yaml["billboard"].as<bool>();
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
    if (yaml["vertical-offset"].IsDefined()) {
        // Convenience alias for the "up" component of the local offset.
        offset_.z = yaml["vertical-offset"].as<double>();
    }
    if (yaml["lateral-offset"].IsDefined()) {
        // Convenience alias for the lateral/local-X component of the offset.
        offset_.x = yaml["lateral-offset"].as<double>();
    }
    if (yaml["offset"].IsDefined() && yaml["offset"].size() >= 1) {
        offset_.x = yaml["offset"][0].as<double>();
        offset_.y = yaml["offset"][1].as<double>();
        offset_.z = yaml["offset"][2].as<double>();
    }
    if (yaml["offset-increment"].IsDefined() && yaml["offset-increment"].size() >= 3) {
        offsetIncrement_.x = yaml["offset-increment"][0].as<double>();
        offsetIncrement_.y = yaml["offset-increment"][1].as<double>();
        offsetIncrement_.z = yaml["offset-increment"][2].as<double>();
    }
    if (yaml["lateral-offset-unit"].IsDefined()) {
        auto unit = yaml["lateral-offset-unit"].as<std::string>();
        std::ranges::transform(unit, unit.begin(), [](unsigned char value) {
            return static_cast<char>(std::tolower(value));
        });
        lateralOffsetUnit_ =
            unit == "pixel" || unit == "pixels" || unit == "px"
            ? LateralOffsetUnit::Pixel
            : LateralOffsetUnit::Meter;
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
        relationTypePattern_ =
            yaml["relation-type"].as<std::string>();
        relationType_ = *relationTypePattern_;
    }
    if (yaml["relation-line-height-offset"].IsDefined()) {
        // Parse vertical offset for relation line in meters.
        relationLineHeightOffset_ = yaml["relation-line-height-offset"].as<float>();
    }
    if (yaml["relation-line-end-markers"].IsDefined()) {
        // Parse style for the relation line end-markers.
        relationLineEndMarkerStyle_ = std::make_shared<FeatureStyleRule>(*this, true);
        relationLineEndMarkerStyle_->scope_ = Feature;
        relationLineEndMarkerStyle_->parse(yaml["relation-line-end-markers"]);
    }
    if (yaml["relation-source-style"].IsDefined()) {
        // Parse style for the relation source geometry.
        relationSourceStyle_ = std::make_shared<FeatureStyleRule>(*this, true);
        relationSourceStyle_->scope_ = Feature;
        relationSourceStyle_->parse(yaml["relation-source-style"]);
    }
    if (yaml["relation-target-style"].IsDefined()) {
        // Parse style for the relation target geometry.
        relationTargetStyle_ = std::make_shared<FeatureStyleRule>(*this, true);
        relationTargetStyle_->scope_ = Feature;
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
    if (yaml["attribute-filter"].IsDefined()) {
        // Parse an attribute based on its field value, e.g. `speedLimitKmh > 100`
        attributeFilter_ = yaml["attribute-filter"].as<std::string>();
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
    /////////////////////////////////////
    /// Sub-Rule Fields
    /////////////////////////////////////

    auto parseBranch = [this, &yaml](char const* key, BranchMode mode)
    {
        if (!yaml[key].IsDefined() || !yaml[key].IsSequence() || branchMode_ != BranchMode::None) {
            return;
        }
        branchMode_ = mode;
        subRules_.clear();
        for (auto yamlSubRule : yaml[key]) {
            // The sub-rule adopts all attributes except gates and branch state.
            auto& subRule = subRules_.emplace_back(*this, true);
            subRule.parse(yamlSubRule);
        }
    };

    parseBranch("first-of", BranchMode::FirstOf);
    parseBranch("all-of", BranchMode::AllOf);
}

bool FeatureStyleRule::forEachMatchingRule(
    MatchContext const& context,
    BoundEvalFun const& entryEvalFun,
    std::function<void(FeatureStyleRule const&)> const& callback,
    BoundEvalFun const* featureEvalFun) const
{
    if (type_) {
        if (!std::regex_match(
                context.featureType.begin(),
                context.featureType.end(),
                *type_))
        {
            return false;
        }
    }

    if (relationType_ && context.relationName) {
        if (!std::regex_match(
                context.relationName->begin(),
                context.relationName->end(),
                *relationType_))
        {
            return false;
        }
    }
    if (attributeType_) {
        if (!context.attributeName ||
            !std::regex_match(
                context.attributeName->begin(),
                context.attributeName->end(),
                *attributeType_))
        {
            return false;
        }
    }
    if (attributeLayerType_) {
        if (!context.attributeLayer ||
            !std::regex_match(
                context.attributeLayer->begin(),
                context.attributeLayer->end(),
                *attributeLayerType_))
        {
            return false;
        }
    }
    if (attributeValidityGeometry_ &&
        (!context.hasValidity ||
         *context.hasValidity != *attributeValidityGeometry_))
    {
        return false;
    }

    auto expressionMatches = [](BoundEvalFun const& evalFun, std::string const& expression) {
        if (expression.empty()) {
            return true;
        }
        auto value = evalFun.eval_(expression);
        if (value.isa(simfil::ValueType::Undef) ||
            value.isa(simfil::ValueType::Null))
        {
            return false;
        }
        if (value.isa(simfil::ValueType::Bool)) {
            return value.as<simfil::ValueType::Bool>();
        }
        return true;
    };
    auto const& hostEvalFun = featureEvalFun ? *featureEvalFun : entryEvalFun;
    if (!expressionMatches(hostEvalFun, filter_) ||
        (context.attributeName &&
         attributeFilter_ &&
         !expressionMatches(entryEvalFun, *attributeFilter_)))
    {
        return false;
    }

    if (branchMode_ == BranchMode::None) {
        callback(*this);
        return true;
    }

    if (branchMode_ == BranchMode::FirstOf) {
        for (auto const& rule : subRules_) {
            if (rule.forEachMatchingRule(
                    context,
                    entryEvalFun,
                    callback,
                    featureEvalFun))
            {
                return true;
            }
        }
        return false;
    }

    bool matched = false;
    for (auto const& rule : subRules_) {
        matched = rule.forEachMatchingRule(
            context,
            entryEvalFun,
            callback,
            featureEvalFun) || matched;
    }
    return matched;
}

void FeatureStyleRule::forEachConcreteRule(std::function<void(FeatureStyleRule const&)> const& callback) const
{
    if (branchMode_ == BranchMode::None) {
        callback(*this);
        return;
    }
    for (auto const& rule : subRules_) {
        rule.forEachConcreteRule(callback);
    }
}

void FeatureStyleRule::assignRenderRuleIndices(uint32_t& nextRenderRuleIndex)
{
    if (branchMode_ == BranchMode::None) {
        renderIndex_ = nextRenderRuleIndex++;
    }
    else {
        for (auto& rule : subRules_) {
            rule.assignRenderRuleIndices(nextRenderRuleIndex);
        }
    }
    for (auto const& nested : {
             relationLineEndMarkerStyle_,
             relationSourceStyle_,
             relationTargetStyle_})
    {
        if (nested) {
            nested->assignRenderRuleIndices(nextRenderRuleIndex);
        }
    }
}

bool FeatureStyleRule::maybeMatchesType(std::string_view typeId) const
{
    if (type_) {
        if (!std::regex_match(typeId.begin(), typeId.end(), *type_)) {
            return false;
        }
    }

    if (branchMode_ != BranchMode::None) {
        for (auto const& rule : subRules_) {
            if (rule.maybeMatchesType(typeId)) {
                return true;
            }
        }
        return false;
    }

    return true;
}

FeatureStyleRule::BranchMode FeatureStyleRule::branchMode() const
{
    return branchMode_;
}

std::vector<FeatureStyleRule> const& FeatureStyleRule::subRules() const
{
    return subRules_;
}

uint32_t FeatureStyleRule::geometryTypesMask() const
{
    return geometryTypes_;
}

uint32_t FeatureStyleRule::effectiveGeometryTypesMask() const
{
    if (branchMode_ == BranchMode::None) {
        return geometryTypes_;
    }
    uint32_t result = 0;
    for (auto const& rule : subRules_) {
        result |= rule.effectiveGeometryTypesMask();
    }
    return result;
}

std::optional<std::string> const& FeatureStyleRule::geometryName() const
{
    return geometryName_;
}

std::optional<std::string> FeatureStyleRule::effectiveGeometryName() const
{
    std::optional<std::string> common;
    bool initialized = false;
    bool wildcard = false;
    forEachConcreteRule([&](FeatureStyleRule const& rule) {
        if (!initialized) {
            common = rule.geometryName_;
            initialized = true;
            wildcard = !common;
            return;
        }
        if (!rule.geometryName_ || wildcard || rule.geometryName_ != common) {
            wildcard = true;
            common.reset();
        }
    });
    return wildcard ? std::nullopt : common;
}

bool FeatureStyleRule::supports(
    mapget::GeomType g,
    std::optional<std::string_view> geometryName) const
{
    if (geometryName_ &&
        (!geometryName || *geometryName != *geometryName_))
    {
        return false;
    }
    return (geometryTypes_ & geomTypeBit(g)) != 0;
}

std::string const& FeatureStyleRule::filter() const
{
    return filter_;
}

std::vector<std::pair<std::string, std::string>>
FeatureStyleRule::expressionUses() const
{
    std::vector<std::pair<std::string, std::string>> result;
    auto append = [&](std::string property, std::string const& expression) {
        if (!expression.empty()) {
            result.emplace_back(std::move(property), expression);
        }
    };
    append("filter", filter_);
    if (attributeFilter_) {
        append("attribute-filter", *attributeFilter_);
    }
    append("color-expression", colorExpression_);
    if (colorScale_) {
        append("color-scale.expression", colorScale_->expression);
    }
    if (widthScale_) {
        append("width-scale.expression", widthScale_->expression);
    }
    append("arrow-expression", arrowExpression_);
    append("icon-url-expression", iconUrlExpression_);
    append("label-text-expression", labelTextExpression_);
    return result;
}

std::optional<glm::fvec4> FeatureStyleRule::color(BoundEvalFun const& evalFun) const
{
    if (colorScale_) {
        auto fallback = [&]() -> std::optional<glm::fvec4> {
            if (!colorScale_->fallback) {
                return std::nullopt;
            }
            auto color = *colorScale_->fallback;
            color.a *= color_.a;
            return color;
        };
        auto const value = colorScaleKey(evalFun.eval_(colorScale_->expression));
        if (!value) {
            return fallback();
        }
        if (colorScale_->mode == ColorScale::Mode::Categorical) {
            auto equal = [](auto const& left, auto const& right) {
                auto leftNumber = numericColorScaleKey(left);
                auto rightNumber = numericColorScaleKey(right);
                if (leftNumber && rightNumber) {
                    return *leftNumber == *rightNumber;
                }
                return left == right;
            };
            for (auto const& stop : colorScale_->stops) {
                if (equal(*value, stop.key)) {
                    auto color = stop.color;
                    color.a *= color_.a;
                    return color;
                }
            }
            return fallback();
        }

        auto input = numericColorScaleKey(*value);
        if (!input || colorScale_->stops.empty()) {
            return fallback();
        }
        auto first = numericColorScaleKey(colorScale_->stops.front().key);
        auto last = numericColorScaleKey(colorScale_->stops.back().key);
        if (!first || !last) {
            return fallback();
        }
        if (*input <= *first || colorScale_->stops.size() == 1) {
            auto color = colorScale_->stops.front().color;
            color.a *= color_.a;
            return color;
        }
        if (*input >= *last) {
            auto color = colorScale_->stops.back().color;
            color.a *= color_.a;
            return color;
        }
        for (size_t index = 1; index < colorScale_->stops.size(); ++index) {
            auto lower = numericColorScaleKey(colorScale_->stops[index - 1].key);
            auto upper = numericColorScaleKey(colorScale_->stops[index].key);
            if (!lower || !upper || *input > *upper) {
                continue;
            }
            auto const t = static_cast<float>((*input - *lower) / (*upper - *lower));
            auto color = glm::mix(
                colorScale_->stops[index - 1].color,
                colorScale_->stops[index].color,
                t);
            color.a *= color_.a;
            return color;
        }
        return fallback();
    }
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
            return glm::fvec4{r, g, b, a};
        }
        else if (colorVal.isa(simfil::ValueType::String)) {
            auto colorStr = colorVal.as<simfil::ValueType::String>();
            return Color(colorStr.c_str()).toFVec4(color_.a);
        }
        else
        {
            if (evalFun.reportIssue_) {
                evalFun.reportIssue_(
                    "color-expression",
                    colorExpression_,
                    "Color expression returned an unsupported value: " + colorVal.toString(),
                    index_);
            }
            std::cout << "Invalid result for color expression: " << colorExpression_
                      << ": " << colorVal.toString() << std::endl;
        }
    }
    return color_;
}

bool FeatureStyleRule::hasExplicitColor() const
{
    return hasExplicitColor_;
}

bool FeatureStyleRule::hasExplicitOpacity() const
{
    return hasExplicitOpacity_;
}

float FeatureStyleRule::width() const
{
    return width_;
}

float FeatureStyleRule::width(BoundEvalFun const& evalFun) const
{
    if (!widthScale_) {
        return width_;
    }
    auto const fallback =
        widthScale_->fallback.value_or(width_);
    auto const value =
        colorScaleKey(
            evalFun.eval_(widthScale_->expression));
    if (!value) {
        return fallback;
    }

    if (widthScale_->mode ==
        ColorScale::Mode::Categorical)
    {
        auto equal = [](auto const& left, auto const& right) {
            auto leftNumber = numericColorScaleKey(left);
            auto rightNumber = numericColorScaleKey(right);
            if (leftNumber && rightNumber) {
                return *leftNumber == *rightNumber;
            }
            return left == right;
        };
        for (auto const& stop : widthScale_->stops) {
            if (equal(*value, stop.key)) {
                return stop.width;
            }
        }
        return fallback;
    }

    auto input = numericColorScaleKey(*value);
    if (!input || widthScale_->stops.empty()) {
        return fallback;
    }
    auto first =
        numericColorScaleKey(
            widthScale_->stops.front().key);
    auto last =
        numericColorScaleKey(
            widthScale_->stops.back().key);
    if (!first || !last) {
        return fallback;
    }
    if (*input <= *first ||
        widthScale_->stops.size() == 1)
    {
        return widthScale_->stops.front().width;
    }
    if (*input >= *last) {
        return widthScale_->stops.back().width;
    }
    for (size_t index = 1;
         index < widthScale_->stops.size();
         ++index)
    {
        auto lower = numericColorScaleKey(
            widthScale_->stops[index - 1].key);
        auto upper = numericColorScaleKey(
            widthScale_->stops[index].key);
        if (!lower || !upper || *input > *upper) {
            continue;
        }
        auto const t = static_cast<float>(
            (*input - *lower) /
            (*upper - *lower));
        return std::lerp(
            widthScale_->stops[index - 1].width,
            widthScale_->stops[index].width,
            t);
    }
    return fallback;
}

bool FeatureStyleRule::depthTest() const
{
    return depthTest_;
}

std::optional<bool> const& FeatureStyleRule::billboard() const
{
    return billboard_;
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

        if (evalFun.reportIssue_) {
            evalFun.reportIssue_(
                "arrow-expression",
                arrowExpression_,
                "Arrow expression returned an unsupported value: " + arrowVal.toString(),
                index_);
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

std::optional<FeatureStyleRule::Glow> const& FeatureStyleRule::glow() const
{
    return glow_;
}

float FeatureStyleRule::relationLineHeightOffset() const
{
    return relationLineHeightOffset_;
}

FeatureStyleRule::Scope FeatureStyleRule::scope() const
{
    return scope_;
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

FeatureStyleRule::Fidelity FeatureStyleRule::fidelity() const
{
    return fidelity_;
}

std::optional<std::regex> const& FeatureStyleRule::relationType() const
{
    return relationType_;
}

std::optional<std::string> const&
FeatureStyleRule::relationTypePattern() const
{
    return relationTypePattern_;
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

glm::dvec3 const& FeatureStyleRule::offset() const
{
    return offset_;
}

glm::dvec3 const& FeatureStyleRule::offsetIncrement() const
{
    return offsetIncrement_;
}

FeatureStyleRule::LateralOffsetUnit FeatureStyleRule::lateralOffsetUnit() const
{
    return lateralOffsetUnit_;
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
        if (evalFun.reportIssue_) {
            evalFun.reportIssue_(
                "icon-url-expression",
                iconUrlExpression_,
                "Icon URL expression returned an unsupported value: " + iconUrlVal.toString(),
                index_);
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

std::optional<std::string> const& FeatureStyleRule::attributeFilter() const
{
    return attributeFilter_;
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

uint32_t FeatureStyleRule::renderIndex() const
{
    return renderIndex_;
}

}
