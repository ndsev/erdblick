#include "visualization-deck.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <optional>
#include <string_view>
#include <utility>
#include <variant>
#include <glm/trigonometric.hpp>
#include <glm/exponential.hpp>
#include <glm/common.hpp>
#include <fmt/format.h>
#include <nlohmann/json.hpp>

#include "color.h"

using namespace mapget;

namespace erdblick
{

namespace {
constexpr uint32_t kUnselectableFeatureIndex = std::numeric_limits<uint32_t>::max();
constexpr double kPi = 3.14159265358979323846;
constexpr double kDegToRad = kPi / 180.0;
constexpr double kMercatorTileSize = 512.0;
constexpr double kFallbackEarthRadiusMeters = 6378137.0;
// Keep this in sync with math.gl web-mercator (addMetersToLngLat/getDistanceScales).
constexpr double kEarthCircumferenceMeters = 40.03e6;
constexpr double kArrowHeadLengthMinMeters = 2.0;
constexpr double kArrowHeadLengthMaxMeters = 24.0;
constexpr double kArrowHeadLengthFraction = 0.35;
constexpr double kArrowHeadWidthFraction = 0.55;
constexpr double kArrowSegmentEpsilonMeters = 1e-6;
using SearchStyleValue = DeckTileSearchResultLayerVisualization::SearchStyleValue;
using SearchStyleFilter = DeckTileSearchResultLayerVisualization::SearchStyleFilter;
using SearchColorStop = DeckTileSearchResultLayerVisualization::SearchColorStop;
using SearchStyleRule = DeckTileSearchResultLayerVisualization::SearchStyleRule;
using SearchResolvedStyle = DeckTileSearchResultLayerVisualization::SearchResolvedStyle;
using SearchGeometryKind = DeckTileSearchResultLayerVisualization::SearchGeometryKind;
using SearchColorMode = DeckTileSearchResultLayerVisualization::SearchColorMode;
using SearchOperator = DeckTileSearchResultLayerVisualization::SearchOperator;

std::uint8_t opacityByte(float opacity, std::uint8_t fallback)
{
    if (!std::isfinite(opacity)) {
        return fallback;
    }
    auto const scaled = std::round(std::clamp(opacity, 0.0f, 1.0f) * 255.0f);
    return static_cast<std::uint8_t>(scaled);
}

std::array<std::uint8_t, 4> colorBytesFromString(
    std::string const& color,
    std::array<std::uint8_t, 4> fallback,
    std::uint8_t alpha)
{
    auto parsedColor = Color(color);
    if (!parsedColor.isValid()) {
        return fallback;
    }
    return {parsedColor.r, parsedColor.g, parsedColor.b, alpha};
}

std::array<std::uint8_t, 4> withAlpha(std::array<std::uint8_t, 4> color, std::uint8_t alpha)
{
    color[3] = alpha;
    return color;
}

std::string jsonString(nlohmann::json const& j, std::string_view key, std::string const& fallback = {})
{
    if (!j.is_object()) {
        return fallback;
    }
    auto const it = j.find(std::string(key));
    return it != j.end() && it->is_string() ? it->get<std::string>() : fallback;
}

std::optional<double> jsonNumber(nlohmann::json const& j, std::string_view key)
{
    if (!j.is_object()) {
        return std::nullopt;
    }
    auto const it = j.find(std::string(key));
    if (it == j.end() || !it->is_number()) {
        return std::nullopt;
    }
    return it->get<double>();
}

SearchStyleValue styleValueFromJson(nlohmann::json const& j)
{
    SearchStyleValue value;
    if (j.is_boolean()) {
        value.kind = SearchStyleValue::Kind::Bool;
        value.boolValue = j.get<bool>();
    }
    else if (j.is_number()) {
        value.kind = SearchStyleValue::Kind::Number;
        value.numberValue = j.get<double>();
    }
    else if (j.is_string()) {
        value.kind = SearchStyleValue::Kind::String;
        value.stringValue = j.get<std::string>();
    }
    return value;
}

SearchStyleValue styleValueFromModelNode(simfil::ModelNode const& node)
{
    SearchStyleValue result;
    switch (node.type()) {
    case simfil::ValueType::Bool:
        result.kind = SearchStyleValue::Kind::Bool;
        result.boolValue = std::get<bool>(node.value());
        break;
    case simfil::ValueType::Int:
        result.kind = SearchStyleValue::Kind::Number;
        result.numberValue = static_cast<double>(std::get<int64_t>(node.value()));
        break;
    case simfil::ValueType::Float:
        result.kind = SearchStyleValue::Kind::Number;
        result.numberValue = std::get<double>(node.value());
        break;
    case simfil::ValueType::String: {
        auto const scalar = node.value();
        result.kind = SearchStyleValue::Kind::String;
        if (auto const* str = std::get_if<std::string>(&scalar)) {
            result.stringValue = *str;
        }
        else if (auto const* strView = std::get_if<std::string_view>(&scalar)) {
            result.stringValue = std::string(*strView);
        }
        break;
    }
    default:
        break;
    }
    return result;
}

std::optional<double> styleValueAsNumber(SearchStyleValue const& value)
{
    if (value.kind == SearchStyleValue::Kind::Number) {
        return value.numberValue;
    }
    if (value.kind != SearchStyleValue::Kind::String) {
        return std::nullopt;
    }
    char* end = nullptr;
    auto const parsed = std::strtod(value.stringValue.c_str(), &end);
    if (end == value.stringValue.c_str() || (end && *end != '\0')) {
        return std::nullopt;
    }
    return parsed;
}

std::string styleValueAsString(SearchStyleValue const& value)
{
    switch (value.kind) {
    case SearchStyleValue::Kind::Bool:
        return value.boolValue ? "true" : "false";
    case SearchStyleValue::Kind::Number:
        return fmt::format("{}", value.numberValue);
    case SearchStyleValue::Kind::String:
        return value.stringValue;
    case SearchStyleValue::Kind::Null:
    default:
        return {};
    }
}

bool styleValuesEqual(SearchStyleValue const& lhs, SearchStyleValue const& rhs)
{
    auto const lhsNumber = styleValueAsNumber(lhs);
    auto const rhsNumber = styleValueAsNumber(rhs);
    if (lhsNumber && rhsNumber) {
        return *lhsNumber == *rhsNumber;
    }
    if (lhs.kind == SearchStyleValue::Kind::Bool && rhs.kind == SearchStyleValue::Kind::Bool) {
        return lhs.boolValue == rhs.boolValue;
    }
    if (lhs.kind == SearchStyleValue::Kind::Null || rhs.kind == SearchStyleValue::Kind::Null) {
        return lhs.kind == rhs.kind;
    }
    return styleValueAsString(lhs) == styleValueAsString(rhs);
}

SearchOperator searchOperatorFromString(std::string const& op)
{
    if (op == "!=") {
        return SearchOperator::Ne;
    }
    if (op == "<") {
        return SearchOperator::Lt;
    }
    if (op == "<=") {
        return SearchOperator::Le;
    }
    if (op == ">") {
        return SearchOperator::Gt;
    }
    if (op == ">=") {
        return SearchOperator::Ge;
    }
    if (op == "contains") {
        return SearchOperator::Contains;
    }
    return SearchOperator::Eq;
}

SearchGeometryKind searchGeometryFromString(std::string const& geometry)
{
    if (geometry == "point") {
        return SearchGeometryKind::Point;
    }
    if (geometry == "line") {
        return SearchGeometryKind::Line;
    }
    if (geometry == "polygon") {
        return SearchGeometryKind::Polygon;
    }
    if (geometry == "mesh") {
        return SearchGeometryKind::Mesh;
    }
    return SearchGeometryKind::Any;
}

SearchColorMode searchColorModeFromString(std::string const& mode)
{
    if (mode == "gradient") {
        return SearchColorMode::Gradient;
    }
    if (mode == "categories") {
        return SearchColorMode::Categories;
    }
    return SearchColorMode::Solid;
}

bool geometryMatches(SearchGeometryKind ruleGeometry, mapget::GeomType geomType)
{
    switch (ruleGeometry) {
    case SearchGeometryKind::Any:
        return true;
    case SearchGeometryKind::Point:
        return geomType == mapget::GeomType::Points;
    case SearchGeometryKind::Line:
        return geomType == mapget::GeomType::Line;
    case SearchGeometryKind::Polygon:
        return geomType == mapget::GeomType::Polygon || geomType == mapget::GeomType::AABB;
    case SearchGeometryKind::Mesh:
        return geomType == mapget::GeomType::Mesh || geomType == mapget::GeomType::GltfNodeIndex;
    }
    return true;
}

bool evaluateSearchFilter(
    SearchStyleValue const& actual,
    SearchOperator op,
    SearchStyleValue const& expected)
{
    switch (op) {
    case SearchOperator::Eq:
        return styleValuesEqual(actual, expected);
    case SearchOperator::Ne:
        return !styleValuesEqual(actual, expected);
    case SearchOperator::Contains:
        return styleValueAsString(actual).find(styleValueAsString(expected)) != std::string::npos;
    case SearchOperator::Lt:
    case SearchOperator::Le:
    case SearchOperator::Gt:
    case SearchOperator::Ge: {
        auto const actualNumber = styleValueAsNumber(actual);
        auto const expectedNumber = styleValueAsNumber(expected);
        if (!actualNumber || !expectedNumber) {
            return false;
        }
        if (op == SearchOperator::Lt) {
            return *actualNumber < *expectedNumber;
        }
        if (op == SearchOperator::Le) {
            return *actualNumber <= *expectedNumber;
        }
        if (op == SearchOperator::Gt) {
            return *actualNumber > *expectedNumber;
        }
        return *actualNumber >= *expectedNumber;
    }
    }
    return false;
}

std::vector<SearchColorStop> parseColorStops(
    nlohmann::json const& stopsJson,
    std::array<std::uint8_t, 4> fallbackColor)
{
    std::vector<SearchColorStop> result;
    if (!stopsJson.is_array()) {
        return result;
    }
    for (auto const& stopJson : stopsJson) {
        if (!stopJson.is_object()) {
            continue;
        }
        SearchColorStop stop;
        stop.value = styleValueFromJson(stopJson.value("value", nlohmann::json()));
        stop.numericValue = styleValueAsNumber(stop.value);
        stop.color = colorBytesFromString(
            jsonString(stopJson, "color"),
            fallbackColor,
            fallbackColor[3]);
        result.push_back(stop);
    }
    return result;
}

SearchStyleRule parseSearchStyleRule(
    nlohmann::json const& ruleJson,
    SearchResolvedStyle const& fallbackStyle)
{
    SearchStyleRule rule;
    auto const opacity = jsonNumber(ruleJson, "opacity");
    if (opacity) {
        rule.opacity = std::clamp(static_cast<float>(*opacity), 0.0f, 1.0f);
    }
    auto const geometryAlpha = rule.opacity
        ? opacityByte(*rule.opacity, fallbackStyle.geometryColor[3])
        : fallbackStyle.geometryColor[3];
    auto const surfaceAlpha = rule.opacity
        ? opacityByte(*rule.opacity, fallbackStyle.surfaceColor[3])
        : fallbackStyle.surfaceColor[3];

    rule.geometry = searchGeometryFromString(jsonString(ruleJson, "geometry", jsonString(ruleJson, "type", "any")));
    if (auto const width = jsonNumber(ruleJson, "width")) {
        rule.width = static_cast<float>(std::max(0.0, *width));
    }
    if (auto const pointRadius = jsonNumber(ruleJson, "pointRadius")) {
        rule.pointRadius = static_cast<float>(std::max(0.0, *pointRadius));
    }

    rule.fallbackGeometryColor = withAlpha(fallbackStyle.geometryColor, geometryAlpha);
    rule.fallbackSurfaceColor = withAlpha(fallbackStyle.surfaceColor, surfaceAlpha);
    rule.solidColor = rule.fallbackGeometryColor;

    if (auto const filters = ruleJson.find("filter"); filters != ruleJson.end() && filters->is_array()) {
        for (auto const& filterJson : *filters) {
            if (!filterJson.is_object()) {
                continue;
            }
            auto const field = jsonString(filterJson, "field");
            if (field.empty()) {
                continue;
            }
            rule.filters.push_back({
                field,
                searchOperatorFromString(jsonString(filterJson, "op", "=")),
                styleValueFromJson(filterJson.value("value", nlohmann::json()))
            });
        }
    }

    auto const colorJsonIt = ruleJson.find("color");
    auto const& colorJson = (colorJsonIt != ruleJson.end() && colorJsonIt->is_object())
        ? *colorJsonIt
        : ruleJson;
    rule.colorMode = searchColorModeFromString(jsonString(colorJson, "mode", ruleJson.contains("solidColor") ? "solid" : "gradient"));
    rule.colorField = jsonString(colorJson, "field", jsonString(ruleJson, "dataExpression"));
    auto const fallbackColorString = jsonString(colorJson, "fallbackColor", jsonString(ruleJson, "solidColor"));
    if (!fallbackColorString.empty()) {
        rule.fallbackGeometryColor = colorBytesFromString(fallbackColorString, rule.fallbackGeometryColor, geometryAlpha);
        rule.fallbackSurfaceColor = withAlpha(rule.fallbackGeometryColor, surfaceAlpha);
    }
    if (rule.colorMode == SearchColorMode::Solid) {
        rule.solidColor = colorBytesFromString(
            jsonString(colorJson, "color", jsonString(ruleJson, "solidColor")),
            rule.fallbackGeometryColor,
            geometryAlpha);
    }
    else {
        auto const stopsJsonIt = colorJson.find("stops");
        if (stopsJsonIt != colorJson.end()) {
            rule.stops = parseColorStops(*stopsJsonIt, rule.fallbackGeometryColor);
        }
        else if (rule.colorMode == SearchColorMode::Gradient) {
            rule.stops = parseColorStops(ruleJson.value("gradient", nlohmann::json::array()), rule.fallbackGeometryColor);
        }
        else {
            rule.stops = parseColorStops(ruleJson.value("colorMap", nlohmann::json::array()), rule.fallbackGeometryColor);
        }
        std::sort(rule.stops.begin(), rule.stops.end(), [](auto const& lhs, auto const& rhs) {
            return lhs.numericValue.value_or(0.0) < rhs.numericValue.value_or(0.0);
        });
    }

    return rule;
}

std::pair<SearchResolvedStyle, std::vector<SearchStyleRule>> parseSearchStyleSpec(
    std::string const& styleSpecJson)
{
    SearchResolvedStyle fallbackStyle;
    auto spec = nlohmann::json::parse(styleSpecJson, nullptr, false);
    if (spec.is_discarded() || !spec.is_object()) {
        return {fallbackStyle, {}};
    }

    fallbackStyle.geometryColor = colorBytesFromString(
        jsonString(spec, "fallbackColor", "#ea4336"),
        fallbackStyle.geometryColor,
        fallbackStyle.geometryColor[3]);
    fallbackStyle.surfaceColor = withAlpha(fallbackStyle.geometryColor, 85);
    if (auto const width = jsonNumber(spec, "fallbackWidth")) {
        fallbackStyle.lineWidth = static_cast<float>(std::max(0.0, *width));
    }
    if (auto const pointRadius = jsonNumber(spec, "fallbackPointRadius")) {
        fallbackStyle.pointRadius = static_cast<float>(std::max(0.0, *pointRadius));
    }

    std::vector<SearchStyleRule> rules;
    auto const rulesIt = spec.find("rules");
    if (rulesIt != spec.end() && rulesIt->is_array()) {
        for (auto const& ruleJson : *rulesIt) {
            if (ruleJson.is_object()) {
                rules.push_back(parseSearchStyleRule(ruleJson, fallbackStyle));
            }
        }
    }
    return {fallbackStyle, rules};
}

/** Convert the JS `{x,y,z}` point payload emitted by the base class back into `mapget::Point`. */
mapget::Point pointFromJsValue(JsValue const& xyzPos)
{
    return {
        xyzPos["x"].as<double>(),
        xyzPos["y"].as<double>(),
        xyzPos["z"].as<double>(),
    };
}

/** Convert normalized float RGBA colors into the byte array shape used by deck labels/icons. */
JsValue rgbaBytesFromColor(glm::fvec4 const& color)
{
    auto toByte = [](float value) {
        const auto scaled = std::round(std::clamp(value, 0.0f, 1.0f) * 255.0f);
        return static_cast<std::uint8_t>(scaled);
    };
    return JsValue::List({
        JsValue(toByte(color.r)),
        JsValue(toByte(color.g)),
        JsValue(toByte(color.b)),
        JsValue(toByte(color.a)),
    });
}

/** Resolve the GLTF tint color without forcing untinted base rendering to black. */
glm::fvec4 resolvedGltfTintColor(
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun)
{
    if (rule.hasExplicitColor()) {
        return rule.color(evalFun);
    }
    if (rule.hasExplicitOpacity()) {
        auto const alpha = std::clamp(rule.color(evalFun).a, 0.0f, 1.0f);
        return {1.0f, 1.0f, 1.0f, alpha};
    }
    return {1.0f, 1.0f, 1.0f, 1.0f};
}

/** Convert longitude to deck/math.gl world X units at the canonical 512-tile scale. */
double mercatorWorldX(double longitudeDeg)
{
    return (kMercatorTileSize * ((longitudeDeg * kDegToRad) + kPi)) / (2.0 * kPi);
}

/** Convert latitude to deck/math.gl world Y units at the canonical 512-tile scale. */
double mercatorWorldY(double latitudeDeg)
{
    auto const latitudeRad = latitudeDeg * kDegToRad;
    auto const mercatorTerm = glm::log(glm::tan((kPi * 0.25) + (latitudeRad * 0.5)));
    return (kMercatorTileSize * (kPi + mercatorTerm)) / (2.0 * kPi);
}

/**
 * Reproduce math.gl distance scales for the coordinate origin used by path buffers.
 *
 * Deck's `PathLayer` needs both the first-order units-per-meter scale and the
 * second-order correction term so large world-coordinate paths stay stable.
 */
bool distanceScalesAt(
    double latitudeDeg,
    double& unitsPerMeter,
    double& unitsPerMeter2)
{
    auto const latitudeRad = latitudeDeg * kDegToRad;
    auto const latitudeCos = glm::cos(latitudeRad);
    if (!std::isfinite(latitudeCos) || std::abs(latitudeCos) < 1e-12) {
        unitsPerMeter = 0.0;
        unitsPerMeter2 = 0.0;
        return false;
    }

    auto const unitsPerDegreeX = kMercatorTileSize / 360.0;
    auto const unitsPerDegreeY = unitsPerDegreeX / latitudeCos;
    unitsPerMeter = kMercatorTileSize / kEarthCircumferenceMeters / latitudeCos;

    // math.gl high-precision scale correction term (unitsPerMeter2[0]).
    auto const latitudeCosine2 = (kDegToRad * glm::tan(latitudeRad)) / latitudeCos;
    auto const unitsPerDegree2 = (kMercatorTileSize / kEarthCircumferenceMeters) * latitudeCosine2;
    unitsPerMeter2 = (unitsPerDegree2 / unitsPerDegreeY) * unitsPerMeter;
    return std::isfinite(unitsPerMeter) && std::isfinite(unitsPerMeter2);
}

/** Return all stored geometry points in model order. */
std::vector<mapget::Point> geometryPoints(mapget::model_ptr<mapget::Geometry> const& geometry)
{
    std::vector<mapget::Point> points;
    if (!geometry) {
        return points;
    }
    points.reserve(std::max<size_t>(1, geometry->numPoints()));
    geometry->forEachPoint([&points](auto const& point) {
        points.push_back(point);
        return true;
    });
    return points;
}

}

DeckFeatureLayerVisualization::DeckFeatureLayerVisualization(
    int viewIndex,
    std::string const& mapTileKey,
    const FeatureLayerStyle& style,
    NativeJsValue const& rawOptionValues,
    NativeJsValue const& rawFeatureMergeService,
    FeatureStyleRule::HighlightMode const& highlightMode,
    FeatureStyleRule::Fidelity fidelity,
    int highFidelityStage,
    int maxLowFiLod,
    int geometryOutputMode,
    NativeJsValue const& rawFeatureIdSubset)
    : FeatureLayerVisualizationBase(
          viewIndex,
          mapTileKey,
          style,
          rawOptionValues,
          highlightMode,
          fidelity,
          highFidelityStage,
          maxLowFiLod,
          geometryOutputMode == static_cast<int>(GeometryOutputMode::PointsOnly)
              ? GeometryOutputMode::PointsOnly
              : (geometryOutputMode == static_cast<int>(GeometryOutputMode::NonPointsOnly)
                  ? GeometryOutputMode::NonPointsOnly
                  : GeometryOutputMode::All),
          rawFeatureIdSubset,
          rawFeatureMergeService)
{
    aggregateBuffers_.surfaces.surfaceStartIndices.push_back(0);
    aggregateBuffers_.pathWorld.startIndices.push_back(0);
    aggregateBuffers_.pathBillboard.startIndices.push_back(0);
    aggregateBuffers_.arrowWorld.startIndices.push_back(0);
    aggregateBuffers_.arrowBillboard.startIndices.push_back(0);
    aggregateBuffers_.gltfPickProxies.startIndices.push_back(0);
    for (auto& lowFiLodBuffer : lowFiLodBuffers_) {
        lowFiLodBuffer.surfaces.surfaceStartIndices.push_back(0);
        lowFiLodBuffer.pathWorld.startIndices.push_back(0);
        lowFiLodBuffer.pathBillboard.startIndices.push_back(0);
        lowFiLodBuffer.arrowWorld.startIndices.push_back(0);
        lowFiLodBuffer.arrowBillboard.startIndices.push_back(0);
        lowFiLodBuffer.gltfPickProxies.startIndices.push_back(0);
    }
}

DeckFeatureLayerVisualization::~DeckFeatureLayerVisualization() = default;

uint32_t DeckFeatureLayerVisualization::abiVersion() const
{
    return 1u;
}

void DeckFeatureLayerVisualization::setGeometryOutputMode(int mode)
{
    switch (mode) {
    case static_cast<int>(GeometryOutputMode::PointsOnly):
        geometryOutputMode_ = GeometryOutputMode::PointsOnly;
        break;
    case static_cast<int>(GeometryOutputMode::NonPointsOnly):
        geometryOutputMode_ = GeometryOutputMode::NonPointsOnly;
        break;
    case static_cast<int>(GeometryOutputMode::All):
    default:
        geometryOutputMode_ = GeometryOutputMode::All;
        break;
    }
}

int DeckFeatureLayerVisualization::geometryOutputMode() const
{
    return static_cast<int>(geometryOutputMode_);
}

JsValue DeckFeatureLayerVisualization::pointBuffersToJs(PointBuffers const& buffers)
{
    return JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.positions)},
        {"colors", JsValue::Uint8Array(buffers.colors)},
        {"radii", JsValue::Float32Array(buffers.radii)},
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
    });
}

JsValue DeckFeatureLayerVisualization::surfaceBuffersToJs(SurfaceBuffers const& buffers)
{
    return JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.surfacePositions)},
        {"startIndices", JsValue::Uint32Array(buffers.surfaceStartIndices)},
        {"colors", JsValue::Uint8Array(buffers.surfaceColors)},
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.surfaceFeatureAddresses)},
    });
}

JsValue DeckFeatureLayerVisualization::pathBuffersToJs(PathBuffers const& buffers, bool withDashArrays)
{
    auto result = JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.positions)},
        {"startIndices", JsValue::Uint32Array(buffers.startIndices)},
        {"colors", JsValue::Uint8Array(buffers.colors)},
        {"widths", JsValue::Float32Array(buffers.widths)},
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
    });
    if (withDashArrays) {
        result.set("dashArrays", JsValue::Float32Array(buffers.dashArray));
    }
    return result;
}

JsValue DeckFeatureLayerVisualization::gltfBuffersToJs(GltfBuffers const& buffers)
{
    return JsValue::Dict({
        {"nodeIndices", JsValue::Uint32Array(buffers.nodeIndices)},
        {"colors", JsValue::Uint8Array(buffers.colors)},
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
    });
}

JsValue DeckFeatureLayerVisualization::gltfPickProxyBuffersToJs(GltfPickProxyBuffers const& buffers)
{
    return JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.positions)},
        {"startIndices", JsValue::Uint32Array(buffers.startIndices)},
        {"nodeIndices", JsValue::Uint32Array(buffers.nodeIndices)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
    });
}

JsValue DeckFeatureLayerVisualization::geometryBuffersToJs(GeometryBuffers const& buffers)
{
    auto labelWorld = JsValue::List();
    for (auto const& label : buffers.labelWorld) {
        labelWorld.push(label);
    }
    auto labelBillboard = JsValue::List();
    for (auto const& label : buffers.labelBillboard) {
        labelBillboard.push(label);
    }
    return JsValue::Dict({
        {"pointWorld", pointBuffersToJs(buffers.pointWorld)},
        {"pointBillboard", pointBuffersToJs(buffers.pointBillboard)},
        {"labelWorld", labelWorld},
        {"labelBillboard", labelBillboard},
        {"surface", surfaceBuffersToJs(buffers.surfaces)},
        {"pathWorld", pathBuffersToJs(buffers.pathWorld, true)},
        {"pathBillboard", pathBuffersToJs(buffers.pathBillboard, true)},
        {"arrowWorld", pathBuffersToJs(buffers.arrowWorld, false)},
        {"arrowBillboard", pathBuffersToJs(buffers.arrowBillboard, false)},
        {"gltfNodes", gltfBuffersToJs(buffers.gltfNodes)},
        {"gltfPickProxies", gltfPickProxyBuffersToJs(buffers.gltfPickProxies)},
    });
}

JsValue DeckFeatureLayerVisualization::coordinateOriginToJs() const
{
    const std::array<double, 3> origin = hasPathCoordinateOriginWgs_
        ? std::array<double, 3>{pathCoordinateOriginWgs_.x, pathCoordinateOriginWgs_.y, pathCoordinateOriginWgs_.z}
        : std::array<double, 3>{0.0, 0.0, 0.0};
    return JsValue::Float64Array(origin);
}

JsValue DeckFeatureLayerVisualization::lowFiBundleResultsToJs() const
{
    auto result = JsValue::List();
    for (size_t lod = 0; lod < lowFiLodBuffers_.size(); ++lod) {
        if (!hasLowFiGeometryForLod(lod)) {
            continue;
        }
        auto bundle = geometryBuffersToJs(lowFiLodBuffers_[lod]);
        bundle.set("lod", JsValue(static_cast<double>(lod)));
        result.push(bundle);
    }
    return result;
}

NativeJsValue DeckFeatureLayerVisualization::renderResult() const
{
    auto result = geometryBuffersToJs(aggregateBuffers_);
    result.set("coordinateOrigin", coordinateOriginToJs());
    result.set("lowFiBundles", lowFiBundleResultsToJs());
    result.set("mergedPointFeatures", JsValue(mergedPointFeatures()));
    return *result;
}

NativeJsValue DeckFeatureLayerVisualization::mergedPointFeatures() const
{
    auto result = JsValue::Dict();
    for (auto const& [mapLayerStyleRuleId, primitives] : mergedPointsPerStyleRuleId_) {
        auto pointList = JsValue::List();
        for (auto const& [_, featureIdsAndPoint] : primitives) {
            if (auto const& pt = featureIdsAndPoint.second) {
                pointList.push(*pt);
            }
        }
        result.set(mapLayerStyleRuleId, pointList);
    }
    return *result;
}

NativeJsValue DeckFeatureLayerVisualization::externalRelationReferences() const
{
    return FeatureLayerVisualizationBase::externalRelationReferences();
}

void DeckFeatureLayerVisualization::processResolvedExternalReferences(
    NativeJsValue const& resolvedReferences)
{
    FeatureLayerVisualizationBase::processResolvedExternalReferences(resolvedReferences);
}

void DeckFeatureLayerVisualization::addTileFeatureLayer(TileFeatureLayer const& tile)
{
    auto const isFirstTile = !tile_;
    FeatureLayerVisualizationBase::addTileFeatureLayer(tile);
    if (!isFirstTile) {
        return;
    }
    if (!includesPointLikeGeometry()) {
        return;
    }
    for (auto&& rule : style_.rules()) {
        if (rule.mode() != highlightMode_) {
            continue;
        }
        rule.forEachConcreteRule([&](FeatureStyleRule const& concreteRule) {
            if (!concreteRule.pointMergeGridCellSize()) {
                return;
            }
            mergedPointsPerStyleRuleId_.emplace(
                makeMapLayerStyleRuleId(concreteRule.renderIndex()),
                std::map<std::string, std::pair<std::unordered_set<uint32_t>, std::optional<JsValue>>>());
        });
    }
}

void DeckFeatureLayerVisualization::onFeatureForRendering(mapget::Feature const& feature)
{
    activeFeatureLod_ = static_cast<uint8_t>(
        std::clamp<int>(static_cast<int>(feature.lod()), 0, 7));
}

bool DeckFeatureLayerVisualization::bypassLowFiMaxLodFilter() const
{
    return lowFiBundleModeEnabled();
}

bool DeckFeatureLayerVisualization::lowFiBundleModeEnabled() const
{
    return fidelity_ == FeatureStyleRule::LowFidelity;
}

bool DeckFeatureLayerVisualization::emitToAggregateForCurrentFeatureLod() const
{
    if (fidelity_ != FeatureStyleRule::LowFidelity) {
        return true;
    }
    if (maxLowFiLod_ < 0) {
        return true;
    }
    return static_cast<int>(activeFeatureLod_) <= maxLowFiLod_;
}

uint8_t DeckFeatureLayerVisualization::activeLodBucket() const
{
    return static_cast<uint8_t>(std::clamp<int>(activeFeatureLod_, 0, 7));
}

bool DeckFeatureLayerVisualization::hasGeometry(PointBuffers const& buffers)
{
    return !buffers.positions.empty();
}

bool DeckFeatureLayerVisualization::hasGeometry(SurfaceBuffers const& buffers)
{
    return buffers.surfaceStartIndices.size() > 1;
}

bool DeckFeatureLayerVisualization::hasGeometry(PathBuffers const& buffers)
{
    return buffers.startIndices.size() > 1;
}

bool DeckFeatureLayerVisualization::hasGeometry(GltfBuffers const& buffers)
{
    return !buffers.nodeIndices.empty();
}

bool DeckFeatureLayerVisualization::hasGeometry(GltfPickProxyBuffers const& buffers)
{
    return buffers.startIndices.size() > 1;
}

bool DeckFeatureLayerVisualization::hasGeometry(GeometryBuffers const& buffers)
{
    return hasGeometry(buffers.pointWorld)
        || hasGeometry(buffers.pointBillboard)
        || !buffers.labelWorld.empty()
        || !buffers.labelBillboard.empty()
        || hasGeometry(buffers.surfaces)
        || hasGeometry(buffers.pathWorld)
        || hasGeometry(buffers.pathBillboard)
        || hasGeometry(buffers.arrowWorld)
        || hasGeometry(buffers.arrowBillboard)
        || hasGeometry(buffers.gltfNodes)
        || hasGeometry(buffers.gltfPickProxies);
}

bool DeckFeatureLayerVisualization::hasLowFiGeometryForLod(size_t lod) const
{
    if (lod >= lowFiLodBuffers_.size()) {
        return false;
    }
    return hasGeometry(lowFiLodBuffers_[lod]);
}

DeckFeatureLayerVisualization::GeometryBuffers& DeckFeatureLayerVisualization::lowFiBuffersForLod(size_t lod)
{
    auto const clampedLod = std::min<size_t>(lod, lowFiLodBuffers_.size() - 1);
    return lowFiLodBuffers_[clampedLod];
}

bool DeckFeatureLayerVisualization::includesPointLikeGeometry() const
{
    return FeatureLayerVisualizationBase::includesPointLikeGeometry();
}

bool DeckFeatureLayerVisualization::includesNonPointGeometry() const
{
    return FeatureLayerVisualizationBase::includesNonPointGeometry();
}

mapget::Point DeckFeatureLayerVisualization::projectWgsPoint(
    mapget::Point const& wgsPoint) const
{
    if (!hasPathCoordinateOriginWgs_) {
        if (tile_) {
            auto const tileCenter = tile_->tileId().center();
            pathCoordinateOriginWgs_ = {tileCenter.x, tileCenter.y, 0.0};
        } else {
            pathCoordinateOriginWgs_ = {wgsPoint.x, wgsPoint.y, 0.0};
        }
        hasPathCoordinateOriginWgs_ = true;
    }

    double unitsPerMeter = 0.0;
    double unitsPerMeter2 = 0.0;
    if (!distanceScalesAt(pathCoordinateOriginWgs_.y, unitsPerMeter, unitsPerMeter2)) {
        auto const lat0Rad = glm::radians(pathCoordinateOriginWgs_.y);
        auto const dLonRad = glm::radians(wgsPoint.x - pathCoordinateOriginWgs_.x);
        auto const dLatRad = glm::radians(wgsPoint.y - pathCoordinateOriginWgs_.y);
        return {
            dLonRad * glm::cos(lat0Rad) * kFallbackEarthRadiusMeters,
            dLatRad * kFallbackEarthRadiusMeters,
            wgsPoint.z - pathCoordinateOriginWgs_.z,
        };
    }

    auto const originWorldX = mercatorWorldX(pathCoordinateOriginWgs_.x);
    auto const originWorldY = mercatorWorldY(pathCoordinateOriginWgs_.y);
    auto const pointWorldX = mercatorWorldX(wgsPoint.x);
    auto const pointWorldY = mercatorWorldY(wgsPoint.y);
    auto const deltaWorldX = pointWorldX - originWorldX;
    auto const deltaWorldY = pointWorldY - originWorldY;

    // Invert math.gl addMetersToLngLat:
    // worldDeltaY = yMeters * unitsPerMeter
    // worldDeltaX = xMeters * (unitsPerMeter + unitsPerMeter2 * yMeters)
    auto const yMeters = deltaWorldY / unitsPerMeter;
    auto const xDenominator = unitsPerMeter + unitsPerMeter2 * yMeters;
    auto const xMeters = std::abs(xDenominator) < 1e-12 ? 0.0 : deltaWorldX / xDenominator;
    return {
        xMeters,
        yMeters,
        wgsPoint.z - pathCoordinateOriginWgs_.z,
    };
}

std::string DeckFeatureLayerVisualization::makeMapLayerStyleRuleId(uint32_t ruleIndex) const
{
    return fmt::format(
        "{}:{}:{}:{}:{}:{}",
        viewIndex_,
        tile_->mapId(),
        tile_->layerInfo()->layerId_,
        style_.name(),
        static_cast<uint32_t>(highlightMode_),
        ruleIndex);
}

void DeckFeatureLayerVisualization::emitPoint(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    appendPointGeometry(pointFromJsValue(xyzPos), rule, tileFeatureId, evalFun);
}

void DeckFeatureLayerVisualization::emitPolygon(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    appendSurfaceGeometry(vertsCartesian, rule, tileFeatureId, evalFun);
}

void DeckFeatureLayerVisualization::emitMesh(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    if (vertsCartesian.size() < 3) {
        return;
    }
    for (size_t i = 0; i + 2 < vertsCartesian.size(); i += 3) {
        appendSurfaceGeometry(
            {vertsCartesian[i], vertsCartesian[i + 1], vertsCartesian[i + 2]},
            rule,
            tileFeatureId,
            evalFun);
    }
}

void DeckFeatureLayerVisualization::emitGltfNode(
    uint32_t nodeIndex,
    mapget::Point const& aabbOriginWgs,
    mapget::Point const& aabbSizeWgs,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    auto const color = resolvedGltfTintColor(rule, evalFun);
    auto const selectableFeatureId = rule.selectable() ? tileFeatureId : kUnselectableFeatureIndex;

    auto appendToBuffers = [&](GltfBuffers& buffers)
    {
        buffers.nodeIndices.push_back(nodeIndex);
        buffers.colors.push_back(toColorByte(color.r));
        buffers.colors.push_back(toColorByte(color.g));
        buffers.colors.push_back(toColorByte(color.b));
        buffers.colors.push_back(toColorByte(color.a));
        buffers.depthTests.push_back(rule.depthTest() ? 1 : 0);
        buffers.featureAddresses.push_back(selectableFeatureId);
    };

    if (emitToAggregateForCurrentFeatureLod()) {
        appendToBuffers(aggregateBuffers_.gltfNodes);
    }
    if (lowFiBundleModeEnabled()) {
        auto const featureLod = static_cast<size_t>(activeLodBucket());
        appendToBuffers(lowFiBuffersForLod(featureLod).gltfNodes);
    }
    if (selectableFeatureId != kUnselectableFeatureIndex) {
        auto const p000 = aabbOriginWgs;
        auto const p100 = mapget::Point{aabbOriginWgs.x + aabbSizeWgs.x, aabbOriginWgs.y, aabbOriginWgs.z};
        auto const p010 = mapget::Point{aabbOriginWgs.x, aabbOriginWgs.y + aabbSizeWgs.y, aabbOriginWgs.z};
        auto const p110 = mapget::Point{aabbOriginWgs.x + aabbSizeWgs.x, aabbOriginWgs.y + aabbSizeWgs.y, aabbOriginWgs.z};
        auto const p001 = mapget::Point{aabbOriginWgs.x, aabbOriginWgs.y, aabbOriginWgs.z + aabbSizeWgs.z};
        auto const p101 = mapget::Point{aabbOriginWgs.x + aabbSizeWgs.x, aabbOriginWgs.y, aabbOriginWgs.z + aabbSizeWgs.z};
        auto const p011 = mapget::Point{aabbOriginWgs.x, aabbOriginWgs.y + aabbSizeWgs.y, aabbOriginWgs.z + aabbSizeWgs.z};
        auto const p111 = mapget::Point{aabbOriginWgs.x + aabbSizeWgs.x, aabbOriginWgs.y + aabbSizeWgs.y, aabbOriginWgs.z + aabbSizeWgs.z};

        auto const projected = std::array<mapget::Point, 8>{
            projectWgsPoint(p000),
            projectWgsPoint(p100),
            projectWgsPoint(p010),
            projectWgsPoint(p110),
            projectWgsPoint(p001),
            projectWgsPoint(p101),
            projectWgsPoint(p011),
            projectWgsPoint(p111)
        };

        auto appendPickProxyToBuffers = [&](GltfPickProxyBuffers& buffers)
        {
            auto appendPoint = [&](mapget::Point const& point) {
                buffers.positions.push_back(static_cast<float>(point.x));
                buffers.positions.push_back(static_cast<float>(point.y));
                buffers.positions.push_back(static_cast<float>(point.z));
            };
            auto appendTriangle = [&](size_t a, size_t b, size_t c) {
                appendPoint(projected[a]);
                appendPoint(projected[b]);
                appendPoint(projected[c]);
            };

            auto const startVertex = static_cast<uint32_t>(buffers.positions.size() / 3);
            appendTriangle(0, 1, 3);
            appendTriangle(0, 3, 2);
            appendTriangle(4, 6, 7);
            appendTriangle(4, 7, 5);
            appendTriangle(0, 4, 5);
            appendTriangle(0, 5, 1);
            appendTriangle(2, 3, 7);
            appendTriangle(2, 7, 6);
            appendTriangle(0, 2, 6);
            appendTriangle(0, 6, 4);
            appendTriangle(1, 5, 7);
            appendTriangle(1, 7, 3);
            buffers.startIndices.push_back(startVertex + 36);
            buffers.nodeIndices.push_back(nodeIndex);
            buffers.featureAddresses.push_back(selectableFeatureId);
        };

        if (emitToAggregateForCurrentFeatureLod()) {
            appendPickProxyToBuffers(aggregateBuffers_.gltfPickProxies);
        }
        if (lowFiBundleModeEnabled()) {
            auto const featureLod = static_cast<size_t>(activeLodBucket());
            appendPickProxyToBuffers(lowFiBuffersForLod(featureLod).gltfPickProxies);
        }
    }
    featuresAdded_ = true;
}

void DeckFeatureLayerVisualization::emitIcon(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    appendPointGeometry(pointFromJsValue(xyzPos), rule, tileFeatureId, evalFun);
}

void DeckFeatureLayerVisualization::emitLabel(
    JsValue const& xyzPos,
    std::string const& text,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) evalFun;
    auto const selectableFeatureId = rule.selectable() ? tileFeatureId : kUnselectableFeatureIndex;
    auto params = JsValue::Dict({
        {"featureAddress", JsValue(selectableFeatureId)},
        {"position", xyzPos},
        {"text", JsValue(text)},
        {"fillColor", rgbaBytesFromColor(rule.labelColor())},
        {"outlineColor", rgbaBytesFromColor(rule.labelOutlineColor())},
        {"outlineWidth", JsValue(rule.labelOutlineWidth())},
        {"scale", JsValue(rule.labelScale())},
        {"billboard", JsValue(resolveLabelBillboard(rule))},
        {"depthTest", JsValue(rule.depthTest())}
    });
    if (auto const& pixelOffset = rule.labelPixelOffset()) {
        params.set("pixelOffset", JsValue::List({
            JsValue(pixelOffset->first),
            JsValue(pixelOffset->second),
        }));
    }
    auto const billboard = resolveLabelBillboard(rule);
    auto appendToBuffers = [&](GeometryBuffers& buffers)
    {
        (billboard ? buffers.labelBillboard : buffers.labelWorld).push_back(params);
    };
    if (emitToAggregateForCurrentFeatureLod()) {
        appendToBuffers(aggregateBuffers_);
    }
    if (lowFiBundleModeEnabled()) {
        auto const featureLod = static_cast<size_t>(activeLodBucket());
        appendToBuffers(lowFiBuffersForLod(featureLod));
    }
    featuresAdded_ = true;
}

JsValue DeckFeatureLayerVisualization::makeMergedPointPointParams(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    auto const color = rule.color(evalFun);
    return JsValue::Dict({
        {"id", JsValue(tileFeatureId)},
        {"position", xyzPos},
        {"pixelSize", JsValue(rule.width())},
        {"color", rgbaBytesFromColor(color)},
        {"outlineColor", rgbaBytesFromColor(rule.outlineColor())},
        {"outlineWidth", JsValue(rule.outlineWidth())},
        {"billboard", JsValue(resolvePointBillboard(rule))},
        {"depthTest", JsValue(rule.depthTest())},
    });
}

JsValue DeckFeatureLayerVisualization::makeMergedPointIconParams(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    auto result = makeMergedPointPointParams(xyzPos, rule, tileFeatureId, evalFun);
    result.set("width", JsValue(rule.width()));
    result.set("height", JsValue(rule.width()));
    result.set("billboard", JsValue(resolveIconBillboard(rule)));
    if (rule.hasIconUrl()) {
        result.set("image", JsValue(rule.iconUrl(evalFun)));
    }
    return result;
}

JsValue DeckFeatureLayerVisualization::makeMergedPointLabelParams(
    JsValue const& xyzPos,
    std::string const& text,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) evalFun;
    auto result = JsValue::Dict({
        {"id", JsValue(tileFeatureId)},
        {"position", xyzPos},
        {"text", JsValue(text)},
        {"font", JsValue(rule.labelFont())},
        {"fillColor", rgbaBytesFromColor(rule.labelColor())},
        {"outlineColor", rgbaBytesFromColor(rule.labelOutlineColor())},
        {"outlineWidth", JsValue(rule.labelOutlineWidth())},
        {"scale", JsValue(rule.labelScale())},
        {"billboard", JsValue(resolveLabelBillboard(rule))},
        {"depthTest", JsValue(rule.depthTest())},
    });
    if (auto const& pixelOffset = rule.labelPixelOffset()) {
        result.set("pixelOffset", JsValue::List({
            JsValue(pixelOffset->first),
            JsValue(pixelOffset->second),
        }));
    }
    return result;
}

void DeckFeatureLayerVisualization::appendPointGeometry(
    mapget::Point const& pointCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    auto const color = rule.color(evalFun);
    auto const radius = std::max(0.0f, rule.width() * 0.5f);
    auto const billboard = resolvePointBillboard(rule);
    auto const selectableFeatureId = rule.selectable() ? tileFeatureId : kUnselectableFeatureIndex;
    auto appendToBuffers = [&](PointBuffers& buffers)
    {
        buffers.positions.push_back(static_cast<float>(pointCartesian.x));
        buffers.positions.push_back(static_cast<float>(pointCartesian.y));
        buffers.positions.push_back(static_cast<float>(pointCartesian.z));

        buffers.colors.push_back(toColorByte(color.r));
        buffers.colors.push_back(toColorByte(color.g));
        buffers.colors.push_back(toColorByte(color.b));
        buffers.colors.push_back(toColorByte(color.a));

        buffers.radii.push_back(radius);
        buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
        buffers.featureAddresses.push_back(selectableFeatureId);
    };

    if (emitToAggregateForCurrentFeatureLod()) {
        appendToBuffers(billboard ? aggregateBuffers_.pointBillboard : aggregateBuffers_.pointWorld);
    }
    if (lowFiBundleModeEnabled()) {
        auto const featureLod = static_cast<size_t>(activeLodBucket());
        auto& lowFiBuffers = lowFiBuffersForLod(featureLod);
        appendToBuffers(billboard ? lowFiBuffers.pointBillboard : lowFiBuffers.pointWorld);
    }

    featuresAdded_ = true;
}

void DeckFeatureLayerVisualization::appendSurfaceGeometry(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    if (vertsCartesian.size() < 3) {
        return;
    }

    auto const color = rule.color(evalFun);
    auto const selectableFeatureId = rule.selectable() ? tileFeatureId : kUnselectableFeatureIndex;
    auto appendToBuffers = [&](SurfaceBuffers& buffers)
    {
        for (auto const& point : vertsCartesian) {
            buffers.surfacePositions.push_back(static_cast<float>(point.x));
            buffers.surfacePositions.push_back(static_cast<float>(point.y));
            buffers.surfacePositions.push_back(static_cast<float>(point.z));
            buffers.surfaceColors.push_back(toColorByte(color.r));
            buffers.surfaceColors.push_back(toColorByte(color.g));
            buffers.surfaceColors.push_back(toColorByte(color.b));
            buffers.surfaceColors.push_back(toColorByte(color.a));
        }
        buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
        buffers.surfaceStartIndices.push_back(static_cast<uint32_t>(buffers.surfacePositions.size() / 3));
        buffers.surfaceFeatureAddresses.push_back(selectableFeatureId);
    };

    if (emitToAggregateForCurrentFeatureLod()) {
        appendToBuffers(aggregateBuffers_.surfaces);
    }
    if (lowFiBundleModeEnabled()) {
        auto const featureLod = static_cast<size_t>(activeLodBucket());
        appendToBuffers(lowFiBuffersForLod(featureLod).surfaces);
    }

    featuresAdded_ = true;
}

void DeckFeatureLayerVisualization::addPolyLine(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    if (vertsCartesian.size() < 2) {
        return;
    }

    const auto width = std::max(0.0f, rule.width());
    if (width <= 0) {
        return;
    }

    auto const arrowType = rule.arrow(evalFun);
    if (arrowType == FeatureStyleRule::NoArrow) {
        appendPathGeometry(vertsCartesian, rule, tileFeatureId, width, evalFun, true);
        return;
    }

    // Keep the original path visible and overlay directional arrow-head markers.
    appendPathGeometry(vertsCartesian, rule, tileFeatureId, width, evalFun, false);

    if (arrowType == FeatureStyleRule::ForwardArrow ||
        arrowType == FeatureStyleRule::DoubleArrow) {
        appendArrowHeadForSegment(
            vertsCartesian.back(),
            vertsCartesian[vertsCartesian.size() - 2],
            rule,
            tileFeatureId,
            width,
            evalFun);
    }

    if (arrowType == FeatureStyleRule::BackwardArrow ||
        arrowType == FeatureStyleRule::DoubleArrow) {
        appendArrowHeadForSegment(
            vertsCartesian.front(),
            vertsCartesian[1],
            rule,
            tileFeatureId,
            width,
            evalFun);
    }
}

void DeckFeatureLayerVisualization::appendPathGeometry(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    float width,
    BoundEvalFun& evalFun,
    bool enableDash)
{
    const auto color = rule.color(evalFun);
    auto const billboard = resolvePathBillboard(rule);
    auto const selectableFeatureId = rule.selectable() ? tileFeatureId : kUnselectableFeatureIndex;
    auto const dashed = enableDash && rule.isDashed();
    auto const dashLength = static_cast<float>(std::max(1, rule.dashLength()));
    auto appendToBuffers = [&](PathBuffers& buffers)
    {
        for (auto const& point : vertsCartesian) {
            buffers.positions.push_back(static_cast<float>(point.x));
            buffers.positions.push_back(static_cast<float>(point.y));
            buffers.positions.push_back(static_cast<float>(point.z));
            buffers.colors.push_back(toColorByte(color.r));
            buffers.colors.push_back(toColorByte(color.g));
            buffers.colors.push_back(toColorByte(color.b));
            buffers.colors.push_back(toColorByte(color.a));
            buffers.widths.push_back(width);
            if (dashed) {
                buffers.dashArray.push_back(dashLength);
                buffers.dashArray.push_back(dashLength);
            }
            else {
                buffers.dashArray.push_back(1.0f);
                buffers.dashArray.push_back(0.0f);
            }
        }
        buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
        buffers.featureAddresses.push_back(selectableFeatureId);
        buffers.startIndices.push_back(static_cast<uint32_t>(buffers.positions.size() / 3));
    };

    if (emitToAggregateForCurrentFeatureLod()) {
        appendToBuffers(billboard ? aggregateBuffers_.pathBillboard : aggregateBuffers_.pathWorld);
    }
    if (lowFiBundleModeEnabled()) {
        auto const featureLod = static_cast<size_t>(activeLodBucket());
        auto& lowFiBuffers = lowFiBuffersForLod(featureLod);
        appendToBuffers(billboard ? lowFiBuffers.pathBillboard : lowFiBuffers.pathWorld);
    }

    featuresAdded_ = true;
}

void DeckFeatureLayerVisualization::appendArrowGeometry(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    float width,
    BoundEvalFun& evalFun)
{
    if (vertsCartesian.size() < 2) {
        return;
    }

    auto const color = rule.color(evalFun);
    auto const billboard = resolvePathBillboard(rule);
    auto const selectableFeatureId = rule.selectable() ? tileFeatureId : kUnselectableFeatureIndex;
    auto const normalizedWidth = std::max(1.0f, width);
    auto appendToBuffers = [&](PathBuffers& buffers)
    {
        for (auto const& point : vertsCartesian) {
            buffers.positions.push_back(static_cast<float>(point.x));
            buffers.positions.push_back(static_cast<float>(point.y));
            buffers.positions.push_back(static_cast<float>(point.z));
            buffers.colors.push_back(toColorByte(color.r));
            buffers.colors.push_back(toColorByte(color.g));
            buffers.colors.push_back(toColorByte(color.b));
            buffers.colors.push_back(toColorByte(color.a));
            buffers.widths.push_back(normalizedWidth);
        }
        buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
        buffers.featureAddresses.push_back(selectableFeatureId);
        buffers.startIndices.push_back(static_cast<uint32_t>(buffers.positions.size() / 3));
    };

    if (emitToAggregateForCurrentFeatureLod()) {
        appendToBuffers(billboard ? aggregateBuffers_.arrowBillboard : aggregateBuffers_.arrowWorld);
    }
    if (lowFiBundleModeEnabled()) {
        auto const featureLod = static_cast<size_t>(activeLodBucket());
        auto& lowFiBuffers = lowFiBuffersForLod(featureLod);
        appendToBuffers(billboard ? lowFiBuffers.arrowBillboard : lowFiBuffers.arrowWorld);
    }

    featuresAdded_ = true;
}

void DeckFeatureLayerVisualization::appendArrowHeadForSegment(
    mapget::Point const& tip,
    mapget::Point const& previous,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    float width,
    BoundEvalFun& evalFun)
{
    auto const dx = tip.x - previous.x;
    auto const dy = tip.y - previous.y;
    auto const dz = tip.z - previous.z;
    auto const segmentLength = std::sqrt(dx * dx + dy * dy + dz * dz);
    if (segmentLength <= kArrowSegmentEpsilonMeters) {
        return;
    }

    auto const dirX = dx / segmentLength;
    auto const dirY = dy / segmentLength;
    auto const dirZ = dz / segmentLength;

    auto perpX = -dirY;
    auto perpY = dirX;
    auto perpZ = 0.0;

    auto perpLength = std::sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
    if (perpLength <= kArrowSegmentEpsilonMeters) {
        perpX = 1.0;
        perpY = 0.0;
        perpZ = 0.0;
        perpLength = 1.0;
    }
    perpX /= perpLength;
    perpY /= perpLength;
    perpZ /= perpLength;

    auto const headLength = std::clamp(
        segmentLength * kArrowHeadLengthFraction,
        kArrowHeadLengthMinMeters,
        kArrowHeadLengthMaxMeters);
    auto const halfHeadWidth = headLength * kArrowHeadWidthFraction;

    mapget::Point const headBase{
        tip.x - dirX * headLength,
        tip.y - dirY * headLength,
        tip.z - dirZ * headLength,
    };
    mapget::Point const left{
        headBase.x + perpX * halfHeadWidth,
        headBase.y + perpY * halfHeadWidth,
        headBase.z + perpZ * halfHeadWidth,
    };
    mapget::Point const right{
        headBase.x - perpX * halfHeadWidth,
        headBase.y - perpY * halfHeadWidth,
        headBase.z - perpZ * halfHeadWidth,
    };

    appendArrowGeometry({left, tip, right}, rule, tileFeatureId, width, evalFun);
}

bool DeckFeatureLayerVisualization::resolvePointBillboard(FeatureStyleRule const& rule)
{
    return rule.billboard().value_or(false);
}

bool DeckFeatureLayerVisualization::resolvePathBillboard(FeatureStyleRule const& rule)
{
    return rule.billboard().value_or(false);
}

bool DeckFeatureLayerVisualization::resolveIconBillboard(FeatureStyleRule const& rule)
{
    return rule.billboard().value_or(true);
}

bool DeckFeatureLayerVisualization::resolveLabelBillboard(FeatureStyleRule const& rule)
{
    return rule.billboard().value_or(true);
}

std::uint8_t DeckFeatureLayerVisualization::toColorByte(float value)
{
    const auto scaled = std::round(std::clamp(value, 0.0f, 1.0f) * 255.0f);
    return static_cast<std::uint8_t>(scaled);
}

DeckTileSearchResultLayerVisualization::DeckTileSearchResultLayerVisualization(
    int /*viewIndex*/,
    std::string const& /*mapTileKey*/,
    std::string const& styleSpecJson)
{
    auto parsedStyle = parseSearchStyleSpec(styleSpecJson);
    fallbackStyle_ = parsedStyle.first;
    styleRules_ = std::move(parsedStyle.second);
    buffers_.surfaces.surfaceStartIndices.push_back(0);
    buffers_.pathWorld.startIndices.push_back(0);
    buffers_.pathBillboard.startIndices.push_back(0);
    buffers_.arrowWorld.startIndices.push_back(0);
    buffers_.arrowBillboard.startIndices.push_back(0);
    buffers_.gltfPickProxies.startIndices.push_back(0);
}

DeckTileSearchResultLayerVisualization::~DeckTileSearchResultLayerVisualization() = default;

uint32_t DeckTileSearchResultLayerVisualization::abiVersion() const
{
    return 1u;
}

void DeckTileSearchResultLayerVisualization::addTileSearchResultLayer(TileSearchResultLayer const& tile)
{
    searchResultLayer_ = tile.model_;
    resultFieldIndexByName_.clear();
    if (!hasCoordinateOriginWgs_ && searchResultLayer_) {
        auto origin = searchResultLayer_->geometryAnchor();
        origin.z = 0.0;
        coordinateOriginWgs_ = origin;
        hasCoordinateOriginWgs_ = true;
    }
    if (searchResultLayer_) {
        auto const& resultFields = searchResultLayer_->resultFields();
        for (size_t i = 0; i < resultFields.size(); ++i) {
            resultFieldIndexByName_.try_emplace(resultFields[i], i);
        }
    }
}

void DeckTileSearchResultLayerVisualization::run()
{
    if (!searchResultLayer_) {
        return;
    }

    resultFeatureIds_.clear();
    resultFeatureIds_.resize(searchResultLayer_->size());
    for (size_t resultIndex = 0; resultIndex < searchResultLayer_->size(); ++resultIndex) {
        auto result = searchResultLayer_->at(resultIndex);
        if (!result) {
            continue;
        }
        resultFeatureIds_[resultIndex] = result->featureId()
            ? result->featureId()->toString()
            : std::string{};
        auto geometryCollection = result->geometry();
        if (!geometryCollection) {
            continue;
        }
        geometryCollection->forEachGeometry([&](auto&& geometry) {
            appendResultGeometry(geometry, result, static_cast<uint32_t>(resultIndex));
            return true;
        });
    }
}

NativeJsValue DeckTileSearchResultLayerVisualization::renderResult() const
{
    auto result = DeckFeatureLayerVisualization::geometryBuffersToJs(buffers_);
    result.set("coordinateOrigin", coordinateOriginToJs());
    result.set("lowFiBundles", JsValue::List());
    result.set("mergedPointFeatures", JsValue::Dict());
    result.set("resultFeatureIds", resultFeatureIdsToJs());
    return *result;
}

uint32_t DeckTileSearchResultLayerVisualization::vertexCount() const
{
    return vertexCount_;
}

void DeckTileSearchResultLayerVisualization::appendResultGeometry(
    mapget::model_ptr<mapget::Geometry> const& geometry,
    mapget::model_ptr<mapget::SearchResult> const& result,
    uint32_t resultIndex)
{
    if (!geometry) {
        return;
    }

    auto const style = styleForResultGeometry(result, geometry->geomType());
    switch (geometry->geomType()) {
    case mapget::GeomType::Points: {
        geometry->forEachPoint([&](auto const& point) {
            appendPoint(point, resultIndex, style);
            return true;
        });
        break;
    }
    case mapget::GeomType::Line:
        appendPath(geometryPoints(geometry), resultIndex, style);
        break;
    case mapget::GeomType::Polygon:
    case mapget::GeomType::Mesh:
        appendSurface(geometryPoints(geometry), resultIndex, style);
        break;
    case mapget::GeomType::AABB:
        appendAabbFootprint(geometry->aabbOrigin(), geometry->aabbSize(), resultIndex, style);
        break;
    case mapget::GeomType::GltfNodeIndex:
        // Search-result rendering intentionally stays self-contained. GLTF hits
        // therefore render as their copied bounds instead of depending on a
        // source tile GLB asset being resident in the client.
        appendAabbFootprint(geometry->gltfNodeAabbOrigin(), geometry->gltfNodeAabbSize(), resultIndex, style);
        break;
    }
}

void DeckTileSearchResultLayerVisualization::appendPoint(
    mapget::Point const& pointWgs,
    uint32_t resultIndex,
    SearchResolvedStyle const& style)
{
    if (style.pointRadius <= 0.0f) {
        return;
    }
    auto const point = projectWgsPoint(pointWgs);
    auto& buffers = buffers_.pointWorld;
    buffers.positions.push_back(static_cast<float>(point.x));
    buffers.positions.push_back(static_cast<float>(point.y));
    buffers.positions.push_back(static_cast<float>(point.z));
    buffers.colors.insert(buffers.colors.end(), style.geometryColor.begin(), style.geometryColor.end());
    buffers.radii.push_back(style.pointRadius);
    buffers.depthTests.push_back(0U);
    buffers.featureAddresses.push_back(resultIndex);
    vertexCount_ += 1;
}

void DeckTileSearchResultLayerVisualization::appendPath(
    std::vector<mapget::Point> const& pointsWgs,
    uint32_t resultIndex,
    SearchResolvedStyle const& style)
{
    if (pointsWgs.size() < 2 || style.lineWidth <= 0.0f) {
        return;
    }
    auto& buffers = buffers_.pathWorld;
    for (auto const& pointWgs : pointsWgs) {
        auto const point = projectWgsPoint(pointWgs);
        buffers.positions.push_back(static_cast<float>(point.x));
        buffers.positions.push_back(static_cast<float>(point.y));
        buffers.positions.push_back(static_cast<float>(point.z));
        buffers.colors.insert(buffers.colors.end(), style.geometryColor.begin(), style.geometryColor.end());
        buffers.widths.push_back(style.lineWidth);
        buffers.dashArray.push_back(1.0f);
        buffers.dashArray.push_back(0.0f);
    }
    buffers.depthTests.push_back(0U);
    buffers.featureAddresses.push_back(resultIndex);
    buffers.startIndices.push_back(static_cast<uint32_t>(buffers.positions.size() / 3));
    vertexCount_ += static_cast<uint32_t>(pointsWgs.size());
}

void DeckTileSearchResultLayerVisualization::appendSurface(
    std::vector<mapget::Point> const& pointsWgs,
    uint32_t resultIndex,
    SearchResolvedStyle const& style)
{
    if (pointsWgs.size() < 3) {
        return;
    }
    auto& buffers = buffers_.surfaces;
    for (auto const& pointWgs : pointsWgs) {
        auto const point = projectWgsPoint(pointWgs);
        buffers.surfacePositions.push_back(static_cast<float>(point.x));
        buffers.surfacePositions.push_back(static_cast<float>(point.y));
        buffers.surfacePositions.push_back(static_cast<float>(point.z));
        buffers.surfaceColors.insert(buffers.surfaceColors.end(), style.surfaceColor.begin(), style.surfaceColor.end());
    }
    buffers.depthTests.push_back(0U);
    buffers.surfaceFeatureAddresses.push_back(resultIndex);
    buffers.surfaceStartIndices.push_back(static_cast<uint32_t>(buffers.surfacePositions.size() / 3));
    vertexCount_ += static_cast<uint32_t>(pointsWgs.size());
}

void DeckTileSearchResultLayerVisualization::appendAabbFootprint(
    mapget::Point const& originWgs,
    mapget::Point const& sizeWgs,
    uint32_t resultIndex,
    SearchResolvedStyle const& style)
{
    appendSurface({
        originWgs,
        {originWgs.x + sizeWgs.x, originWgs.y, originWgs.z},
        {originWgs.x + sizeWgs.x, originWgs.y + sizeWgs.y, originWgs.z},
        {originWgs.x, originWgs.y + sizeWgs.y, originWgs.z},
    }, resultIndex, style);
}

DeckTileSearchResultLayerVisualization::SearchResolvedStyle
DeckTileSearchResultLayerVisualization::styleForResultGeometry(
    mapget::model_ptr<mapget::SearchResult> const& result,
    mapget::GeomType geomType) const
{
    for (auto const& rule : styleRules_) {
        if (!ruleMatches(rule, result, geomType)) {
            continue;
        }
        auto resolved = fallbackStyle_;
        resolved.lineWidth = rule.width.value_or(resolved.lineWidth);
        resolved.pointRadius = rule.pointRadius.value_or(resolved.pointRadius);
        resolved.geometryColor = colorForRule(rule, result, rule.fallbackGeometryColor);
        resolved.surfaceColor = withAlpha(
            resolved.geometryColor,
            rule.opacity ? opacityByte(*rule.opacity, rule.fallbackSurfaceColor[3]) : rule.fallbackSurfaceColor[3]);
        return resolved;
    }
    return fallbackStyle_;
}

bool DeckTileSearchResultLayerVisualization::ruleMatches(
    SearchStyleRule const& rule,
    mapget::model_ptr<mapget::SearchResult> const& result,
    mapget::GeomType geomType) const
{
    if (!geometryMatches(rule.geometry, geomType)) {
        return false;
    }
    for (auto const& filter : rule.filters) {
        auto const actual = valueForField(result, filter.field);
        if (!actual || !evaluateSearchFilter(*actual, filter.op, filter.value)) {
            return false;
        }
    }
    return true;
}

std::optional<DeckTileSearchResultLayerVisualization::SearchStyleValue>
DeckTileSearchResultLayerVisualization::valueForField(
    mapget::model_ptr<mapget::SearchResult> const& result,
    std::string const& field) const
{
    if (!result || field.empty()) {
        return std::nullopt;
    }
    auto const fieldIndex = resultFieldIndexByName_.find(field);
    if (fieldIndex == resultFieldIndexByName_.end()) {
        return std::nullopt;
    }
    auto values = result->values();
    if (!values || fieldIndex->second >= values->size()) {
        return std::nullopt;
    }
    auto valueNode = values->at(static_cast<int64_t>(fieldIndex->second));
    if (!valueNode || !valueNode->isResolved()) {
        return std::nullopt;
    }
    return styleValueFromModelNode(*valueNode);
}

std::array<uint8_t, 4> DeckTileSearchResultLayerVisualization::colorForRule(
    SearchStyleRule const& rule,
    mapget::model_ptr<mapget::SearchResult> const& result,
    std::array<uint8_t, 4> fallback) const
{
    if (rule.colorMode == SearchColorMode::Solid) {
        return rule.solidColor;
    }

    auto const actual = valueForField(result, rule.colorField);
    if (!actual) {
        return fallback;
    }

    if (rule.colorMode == SearchColorMode::Categories) {
        for (auto const& stop : rule.stops) {
            if (styleValuesEqual(*actual, stop.value)) {
                return stop.color;
            }
        }
        return fallback;
    }

    auto const actualNumber = styleValueAsNumber(*actual);
    if (!actualNumber) {
        return fallback;
    }
    std::vector<SearchColorStop const*> numericStops;
    for (auto const& stop : rule.stops) {
        if (stop.numericValue) {
            numericStops.push_back(&stop);
        }
    }
    if (numericStops.empty()) {
        return fallback;
    }
    if (*actualNumber <= *numericStops.front()->numericValue) {
        return numericStops.front()->color;
    }
    if (*actualNumber >= *numericStops.back()->numericValue) {
        return numericStops.back()->color;
    }
    for (size_t i = 1; i < numericStops.size(); ++i) {
        auto const* upper = numericStops[i];
        if (*actualNumber > *upper->numericValue) {
            continue;
        }
        auto const* lower = numericStops[i - 1];
        auto const span = *upper->numericValue - *lower->numericValue;
        auto const t = span <= 0.0 ? 0.0 : ((*actualNumber - *lower->numericValue) / span);
        std::array<uint8_t, 4> interpolated{};
        for (size_t channel = 0; channel < interpolated.size(); ++channel) {
            auto const value = static_cast<double>(lower->color[channel]) +
                (static_cast<double>(upper->color[channel]) - static_cast<double>(lower->color[channel])) * t;
            interpolated[channel] = static_cast<uint8_t>(std::round(std::clamp(value, 0.0, 255.0)));
        }
        return interpolated;
    }
    return fallback;
}

mapget::Point DeckTileSearchResultLayerVisualization::projectWgsPoint(
    mapget::Point const& wgsPoint) const
{
    if (!hasCoordinateOriginWgs_) {
        coordinateOriginWgs_ = {wgsPoint.x, wgsPoint.y, 0.0};
        hasCoordinateOriginWgs_ = true;
    }

    double unitsPerMeter = 0.0;
    double unitsPerMeter2 = 0.0;
    if (!distanceScalesAt(coordinateOriginWgs_.y, unitsPerMeter, unitsPerMeter2)) {
        auto const lat0Rad = glm::radians(coordinateOriginWgs_.y);
        auto const dLonRad = glm::radians(wgsPoint.x - coordinateOriginWgs_.x);
        auto const dLatRad = glm::radians(wgsPoint.y - coordinateOriginWgs_.y);
        return {
            dLonRad * glm::cos(lat0Rad) * kFallbackEarthRadiusMeters,
            dLatRad * kFallbackEarthRadiusMeters,
            wgsPoint.z - coordinateOriginWgs_.z,
        };
    }

    auto const originWorldX = mercatorWorldX(coordinateOriginWgs_.x);
    auto const originWorldY = mercatorWorldY(coordinateOriginWgs_.y);
    auto const pointWorldX = mercatorWorldX(wgsPoint.x);
    auto const pointWorldY = mercatorWorldY(wgsPoint.y);
    auto const deltaWorldX = pointWorldX - originWorldX;
    auto const deltaWorldY = pointWorldY - originWorldY;
    auto const yMeters = deltaWorldY / unitsPerMeter;
    auto const xDenominator = unitsPerMeter + unitsPerMeter2 * yMeters;
    auto const xMeters = std::abs(xDenominator) < 1e-12 ? 0.0 : deltaWorldX / xDenominator;
    return {
        xMeters,
        yMeters,
        wgsPoint.z - coordinateOriginWgs_.z,
    };
}

JsValue DeckTileSearchResultLayerVisualization::coordinateOriginToJs() const
{
    const std::array<double, 3> origin = hasCoordinateOriginWgs_
        ? std::array<double, 3>{coordinateOriginWgs_.x, coordinateOriginWgs_.y, coordinateOriginWgs_.z}
        : std::array<double, 3>{0.0, 0.0, 0.0};
    return JsValue::Float64Array(origin);
}

JsValue DeckTileSearchResultLayerVisualization::resultFeatureIdsToJs() const
{
    auto result = JsValue::List();
    for (auto const& featureId : resultFeatureIds_) {
        result.push(JsValue(featureId));
    }
    return result;
}

}  // namespace erdblick
