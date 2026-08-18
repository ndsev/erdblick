#include "rule.h"
#include "mapget/model/hash.h"
#include <algorithm>
#include <charconv>
#include <cctype>
#include <cmath>
#include <iostream>
#include "simfil/value.h"
#include "search.h"

namespace erdblick
{

simfil::Value BoundEvalFun::evaluate(std::string const& expression) const
{
    if (evalRef_) {
        return evalRef_(context_, expression);
    }
    return eval_ ? eval_(expression) : simfil::Value::undef();
}

void BoundEvalFun::reportIssue(
    std::string const& property,
    std::string const& expression,
    std::string const& message,
    uint32_t ruleIndex) const
{
    if (reportIssueRef_) {
        reportIssueRef_(
            context_,
            property,
            expression,
            message,
            ruleIndex);
    }
    else if (reportIssue_) {
        reportIssue_(property, expression, message, ruleIndex);
    }
}

bool BoundEvalFun::hasIssueReporter() const
{
    return reportIssueRef_ || static_cast<bool>(reportIssue_);
}

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

/** Parse the shared style length-unit aliases used by offsets and dashes. */
FeatureStyleRule::LengthUnit parseLengthUnit(std::string unit)
{
    std::ranges::transform(unit, unit.begin(), [](unsigned char value) {
        return static_cast<char>(std::tolower(value));
    });
    return unit == "pixel" || unit == "pixels" || unit == "px"
        ? FeatureStyleRule::LengthUnit::Pixel
        : FeatureStyleRule::LengthUnit::Meter;
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

/** Detect patterns whose regex semantics are exactly a literal string comparison. */
bool isLiteralRegex(std::string_view pattern)
{
    constexpr std::string_view metaCharacters = R"(.^$|()[]{}*+?\)";
    return pattern.find_first_of(metaCharacters) == std::string_view::npos;
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

/** Build an allocation-bounded direct lookup when every category is integral. */
template<typename Stop, typename Result, typename Project>
std::optional<FeatureStyleRule::DenseIntegerScale<Result>>
denseIntegerScale(std::vector<Stop> const& stops, Project project)
{
    constexpr uint64_t kMaximumDenseSpan = 1024U;
    auto integerKey = [](FeatureStyleRule::ColorScaleStop::Key const& key)
        -> std::optional<int64_t> {
        if (auto const integer = std::get_if<int64_t>(&key)) {
            return *integer;
        }
        auto const number = std::get_if<double>(&key);
        constexpr double kInt64UpperExclusive = 9223372036854775808.0;
        if (!number || !std::isfinite(*number) ||
            std::trunc(*number) != *number ||
            *number < static_cast<double>(
                std::numeric_limits<int64_t>::min()) ||
            *number >= kInt64UpperExclusive)
        {
            return std::nullopt;
        }
        return static_cast<int64_t>(*number);
    };
    if (stops.empty()) {
        return std::nullopt;
    }
    int64_t minimum = std::numeric_limits<int64_t>::max();
    int64_t maximum = std::numeric_limits<int64_t>::min();
    for (auto const& stop : stops) {
        auto const key = integerKey(stop.key);
        if (!key) {
            return std::nullopt;
        }
        minimum = std::min(minimum, *key);
        maximum = std::max(maximum, *key);
    }
    auto const span = static_cast<uint64_t>(maximum) -
        static_cast<uint64_t>(minimum) + 1U;
    if (span > kMaximumDenseSpan) {
        return std::nullopt;
    }
    FeatureStyleRule::DenseIntegerScale<Result> result{
        .minimum = minimum,
        .values = std::vector<std::optional<Result>>(
            static_cast<size_t>(span)),
    };
    for (auto const& stop : stops) {
        auto const key = *integerKey(stop.key);
        auto const index = static_cast<size_t>(
            key - minimum);
        if (!result.values[index]) {
            result.values[index] = project(stop);
        }
    }
    return result;
}

/** Return an integral SIMFIL number without constructing a scale-key variant. */
std::optional<int64_t> integerScaleKey(simfil::Value const& value)
{
    if (value.isa(simfil::ValueType::Int)) {
        return value.as<simfil::ValueType::Int>();
    }
    if (!value.isa(simfil::ValueType::Float)) {
        return std::nullopt;
    }
    auto const number = value.as<simfil::ValueType::Float>();
    constexpr double kInt64UpperExclusive = 9223372036854775808.0;
    if (!std::isfinite(number) || std::trunc(number) != number ||
        number < static_cast<double>(std::numeric_limits<int64_t>::min()) ||
        number >= kInt64UpperExclusive)
    {
        return std::nullopt;
    }
    return static_cast<int64_t>(number);
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
        exactType_.reset();
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
        auto pattern = yaml["type"].as<std::string>();
        exactType_.reset();
        type_.reset();
        if (isLiteralRegex(pattern)) {
            exactType_ = std::move(pattern);
        }
        else {
            type_ = pattern;
        }
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
            auto key = parseColorScaleKey(stopYaml[0]);
            scale.stops.push_back(ColorScaleStop{
                key,
                Color(stopYaml[1].as<std::string>()).toFVec4(),
                numericColorScaleKey(key),
            });
        }
        if (scale.mode == ColorScale::Mode::Categorical) {
            scale.denseIntegerStops = denseIntegerScale<
                ColorScaleStop,
                glm::fvec4>(
                    scale.stops,
                    [](ColorScaleStop const& stop) {
                        return stop.color;
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
            auto key = parseColorScaleKey(stopYaml[0]);
            scale.stops.push_back(WidthScaleStop{
                key,
                stopYaml[1].as<float>(),
                numericColorScaleKey(key),
            });
        }
        if (scale.mode == ColorScale::Mode::Categorical) {
            scale.denseIntegerStops = denseIntegerScale<
                WidthScaleStop,
                float>(
                    scale.stops,
                    [](WidthScaleStop const& stop) {
                        return stop.width;
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
    if (yaml["z-index"].IsDefined()) {
        zIndex_ = yaml["z-index"].as<double>();
    }
    if (yaml["z-index-expression"].IsDefined()) {
        zIndexExpression_ = yaml["z-index-expression"].as<std::string>();
    }
    if (yaml["z-index-group-expression"].IsDefined()) {
        zIndexGroupExpression_ =
            yaml["z-index-group-expression"].as<std::string>();
    }
    if (yaml["z-index-role"].IsDefined()) {
        auto const role = yaml["z-index-role"].as<std::string>();
        if (role == "support") {
            zIndexRole_ = ZIndexRole::Support;
        }
        else if (role == "overlay") {
            zIndexRole_ = ZIndexRole::Overlay;
        }
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
        lateralOffsetUnit_ = parseLengthUnit(
            yaml["lateral-offset-unit"].as<std::string>());
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
        dashed_ = yaml["dashed"].as<bool>();
    }
    if (yaml["dash-length"].IsDefined()) {
        dashLength_ = yaml["dash-length"].as<float>();
        // Preserve the legacy one-value cadence unless a gap is authored.
        if (!yaml["dash-gap"].IsDefined()) {
            dashGap_ = dashLength_;
        }
    }
    if (yaml["dash-gap"].IsDefined()) {
        dashGap_ = yaml["dash-gap"].as<float>();
    }
    if (yaml["dash-unit"].IsDefined()) {
        dashUnit_ = parseLengthUnit(yaml["dash-unit"].as<std::string>());
    }
    if (yaml["gap-color"].IsDefined()) {
        auto colorStr = yaml["gap-color"].as<std::string>();
        gapColor_ = Color(colorStr).toFVec4();
    }
    if (yaml["dash-pattern"].IsDefined()) {
        dashPattern_ = yaml["dash-pattern"].as<int>();
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
    if (yaml["relation-line-geometry"].IsDefined()) {
        auto const value = yaml["relation-line-geometry"].as<std::string>();
        if (value == "connection-stubs") {
            relationLineGeometry_ = RelationLineGeometry::ConnectionStubs;
        }
        else {
            relationLineGeometry_ = RelationLineGeometry::Centers;
        }
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
    if (yaml["label-opacity"].IsDefined()) {
        labelOpacity_ = yaml["label-opacity"].as<float>();
    }
    if (yaml["label-collision"].IsDefined()) {
        labelCollision_ = yaml["label-collision"].as<bool>();
    }
    if (yaml["label-collision-priority"].IsDefined()) {
        labelCollisionPriority_ =
            yaml["label-collision-priority"].as<int32_t>();
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
    if (exactType_) {
        if (context.featureType != *exactType_) {
            return false;
        }
    }
    else if (type_) {
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
        auto value = evalFun.evaluate(expression);
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
    if (exactType_) {
        if (typeId != *exactType_) {
            return false;
        }
    }
    else if (type_) {
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
    append("z-index-expression", zIndexExpression_);
    append("z-index-group-expression", zIndexGroupExpression_);
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
        auto const evaluated = evalFun.evaluate(colorScale_->expression);
        if (colorScale_->mode == ColorScale::Mode::Categorical &&
            colorScale_->denseIntegerStops)
        {
            auto const key = integerScaleKey(evaluated);
            if (!key || *key < colorScale_->denseIntegerStops->minimum) {
                return fallback();
            }
            auto const index = static_cast<uint64_t>(*key) -
                static_cast<uint64_t>(
                    colorScale_->denseIntegerStops->minimum);
            if (index >= colorScale_->denseIntegerStops->values.size() ||
                !colorScale_->denseIntegerStops->values[
                    static_cast<size_t>(index)])
            {
                return fallback();
            }
            auto color = *colorScale_->denseIntegerStops->values[
                static_cast<size_t>(index)];
            color.a *= color_.a;
            return color;
        }
        auto const value = colorScaleKey(evaluated);
        if (!value) {
            return fallback();
        }
        if (colorScale_->mode == ColorScale::Mode::Categorical) {
            auto const valueNumber = numericColorScaleKey(*value);
            for (auto const& stop : colorScale_->stops) {
                auto const equal = valueNumber
                    ? stop.numericKey && *valueNumber == *stop.numericKey
                    : !stop.numericKey && *value == stop.key;
                if (equal) {
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
        auto const first = colorScale_->stops.front().numericKey;
        auto const last = colorScale_->stops.back().numericKey;
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
            auto const lower = colorScale_->stops[index - 1].numericKey;
            auto const upper = colorScale_->stops[index].numericKey;
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
        auto colorVal = evalFun.evaluate(colorExpression_);
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
            if (evalFun.hasIssueReporter()) {
                evalFun.reportIssue(
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
    auto const evaluated = evalFun.evaluate(widthScale_->expression);
    if (widthScale_->mode == ColorScale::Mode::Categorical &&
        widthScale_->denseIntegerStops)
    {
        auto const key = integerScaleKey(evaluated);
        if (!key || *key < widthScale_->denseIntegerStops->minimum) {
            return fallback;
        }
        auto const index = static_cast<uint64_t>(*key) -
            static_cast<uint64_t>(
                widthScale_->denseIntegerStops->minimum);
        if (index >= widthScale_->denseIntegerStops->values.size() ||
            !widthScale_->denseIntegerStops->values[
                static_cast<size_t>(index)])
        {
            return fallback;
        }
        return *widthScale_->denseIntegerStops->values[
            static_cast<size_t>(index)];
    }
    auto const value = colorScaleKey(evaluated);
    if (!value) {
        return fallback;
    }

    if (widthScale_->mode ==
        ColorScale::Mode::Categorical)
    {
        auto const valueNumber = numericColorScaleKey(*value);
        for (auto const& stop : widthScale_->stops) {
            auto const equal = valueNumber
                ? stop.numericKey && *valueNumber == *stop.numericKey
                : !stop.numericKey && *value == stop.key;
            if (equal) {
                return stop.width;
            }
        }
        return fallback;
    }

    auto input = numericColorScaleKey(*value);
    if (!input || widthScale_->stops.empty()) {
        return fallback;
    }
    auto const first = widthScale_->stops.front().numericKey;
    auto const last = widthScale_->stops.back().numericKey;
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
        auto const lower = widthScale_->stops[index - 1].numericKey;
        auto const upper = widthScale_->stops[index].numericKey;
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

std::optional<double> FeatureStyleRule::zIndex(
    BoundEvalFun const& evalFun) const
{
    if (zIndexExpression_.empty()) {
        return zIndex_;
    }

    auto const value = evalFun.evaluate(zIndexExpression_);
    if (value.isa(simfil::ValueType::Undef) ||
        value.isa(simfil::ValueType::Null))
    {
        return zIndex_;
    }
    std::optional<double> number;
    if (value.isa(simfil::ValueType::Int)) {
        number = static_cast<double>(
            value.as<simfil::ValueType::Int>());
    }
    else if (value.isa(simfil::ValueType::Float)) {
        number = value.as<simfil::ValueType::Float>();
    }
    if (number && std::isfinite(*number)) {
        return *number;
    }

    if (evalFun.hasIssueReporter()) {
        evalFun.reportIssue(
            "z-index-expression",
            zIndexExpression_,
            "Expression must evaluate to a finite number; using the literal z-index fallback if configured.",
            index_);
    }
    return zIndex_;
}

std::optional<uint64_t> FeatureStyleRule::zIndexGroup(
    BoundEvalFun const& evalFun) const
{
    if (zIndexGroupExpression_.empty()) {
        return std::nullopt;
    }

    auto const value = evalFun.evaluate(zIndexGroupExpression_);
    auto hash = mapget::Hash{};
    if (value.isa(simfil::ValueType::Bool)) {
        return hash
            .mix(uint32_t{1U})
            .mix(value.as<simfil::ValueType::Bool>())
            .value();
    }
    if (value.isa(simfil::ValueType::Int)) {
        return hash
            .mix(uint32_t{2U})
            .mix(value.as<simfil::ValueType::Int>())
            .value();
    }
    if (value.isa(simfil::ValueType::Float)) {
        auto number = value.as<simfil::ValueType::Float>();
        if (std::isfinite(number)) {
            number = number == 0.0 ? 0.0 : number;
            return hash.mix(uint32_t{3U}).mix(number).value();
        }
    }
    if (value.isa(simfil::ValueType::String)) {
        return hash
            .mix(uint32_t{4U})
            .mix(value.as<simfil::ValueType::String>())
            .value();
    }

    if (evalFun.hasIssueReporter()) {
        evalFun.reportIssue(
            "z-index-group-expression",
            zIndexGroupExpression_,
            "Expression must evaluate to a boolean, integer, finite number, or string; grouped rendering was skipped.",
            index_);
    }
    return std::nullopt;
}

std::string const& FeatureStyleRule::zIndexGroupExpression() const
{
    return zIndexGroupExpression_;
}

FeatureStyleRule::ZIndexRole FeatureStyleRule::zIndexRole() const
{
    return zIndexRole_;
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

float FeatureStyleRule::dashLength() const
{
    return dashLength_;
}

float FeatureStyleRule::dashGap() const
{
    return dashGap_;
}

FeatureStyleRule::LengthUnit FeatureStyleRule::dashUnit() const
{
    return dashUnit_;
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
        auto arrowVal = evalFun.evaluate(arrowExpression_);
        if (arrowVal.isa(simfil::ValueType::String)) {
            auto arrowStr = arrowVal.as<simfil::ValueType::String>();
            if (auto arrowMode = parseArrowMode(arrowStr))
                return *arrowMode;
        }

        if (evalFun.hasIssueReporter()) {
            evalFun.reportIssue(
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

std::optional<FeatureStyleRule::Arrow> FeatureStyleRule::constantArrow() const
{
    return arrowExpression_.empty()
        ? std::optional<Arrow>{arrow_}
        : std::nullopt;
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

FeatureStyleRule::RelationLineGeometry
FeatureStyleRule::relationLineGeometry() const
{
    return relationLineGeometry_;
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

float FeatureStyleRule::labelOpacity() const
{
    return labelOpacity_;
}

bool FeatureStyleRule::labelCollision() const
{
    return labelCollision_;
}

int32_t FeatureStyleRule::labelCollisionPriority() const
{
    return labelCollisionPriority_;
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
        auto resultVal = evalFun.evaluate(labelTextExpression_);
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
        auto iconUrlVal = evalFun.evaluate(iconUrlExpression_);
        if (iconUrlVal.isa(simfil::ValueType::String)) {
            return iconUrlVal.as<simfil::ValueType::String>();
        }
        if (evalFun.hasIssueReporter()) {
            evalFun.reportIssue(
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
