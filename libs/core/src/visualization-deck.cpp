#include "visualization-deck.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <fmt/format.h>

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

mapget::Point pointFromJsValue(JsValue const& xyzPos)
{
    return {
        xyzPos["x"].as<double>(),
        xyzPos["y"].as<double>(),
        xyzPos["z"].as<double>(),
    };
}

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

double mercatorWorldX(double longitudeDeg)
{
    return (kMercatorTileSize * ((longitudeDeg * kDegToRad) + kPi)) / (2.0 * kPi);
}

double mercatorWorldY(double latitudeDeg)
{
    auto const latitudeRad = latitudeDeg * kDegToRad;
    auto const mercatorTerm = std::log(std::tan((kPi * 0.25) + (latitudeRad * 0.5)));
    return (kMercatorTileSize * (kPi + mercatorTerm)) / (2.0 * kPi);
}

bool distanceScalesAt(
    double latitudeDeg,
    double& unitsPerMeter,
    double& unitsPerMeter2)
{
    auto const latitudeRad = latitudeDeg * kDegToRad;
    auto const latitudeCos = std::cos(latitudeRad);
    if (!std::isfinite(latitudeCos) || std::abs(latitudeCos) < 1e-12) {
        unitsPerMeter = 0.0;
        unitsPerMeter2 = 0.0;
        return false;
    }

    auto const unitsPerDegreeX = kMercatorTileSize / 360.0;
    auto const unitsPerDegreeY = unitsPerDegreeX / latitudeCos;
    unitsPerMeter = kMercatorTileSize / kEarthCircumferenceMeters / latitudeCos;

    // math.gl high-precision scale correction term (unitsPerMeter2[0]).
    auto const latitudeCosine2 = (kDegToRad * std::tan(latitudeRad)) / latitudeCos;
    auto const unitsPerDegree2 = (kMercatorTileSize / kEarthCircumferenceMeters) * latitudeCosine2;
    unitsPerMeter2 = (unitsPerDegree2 / unitsPerDegreeY) * unitsPerMeter;
    return std::isfinite(unitsPerMeter) && std::isfinite(unitsPerMeter2);
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
    for (auto& lowFiLodBuffer : lowFiLodBuffers_) {
        lowFiLodBuffer.surfaces.surfaceStartIndices.push_back(0);
        lowFiLodBuffer.pathWorld.startIndices.push_back(0);
        lowFiLodBuffer.pathBillboard.startIndices.push_back(0);
        lowFiLodBuffer.arrowWorld.startIndices.push_back(0);
        lowFiLodBuffer.arrowBillboard.startIndices.push_back(0);
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
        {"featureIds", JsValue::Uint32Array(buffers.featureIds)},
    });
}

JsValue DeckFeatureLayerVisualization::surfaceBuffersToJs(SurfaceBuffers const& buffers)
{
    return JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.surfacePositions)},
        {"startIndices", JsValue::Uint32Array(buffers.surfaceStartIndices)},
        {"colors", JsValue::Uint8Array(buffers.surfaceColors)},
        {"featureIds", JsValue::Uint32Array(buffers.surfaceFeatureIds)},
    });
}

JsValue DeckFeatureLayerVisualization::pathBuffersToJs(PathBuffers const& buffers, bool withDashArrays)
{
    auto result = JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.positions)},
        {"startIndices", JsValue::Uint32Array(buffers.startIndices)},
        {"colors", JsValue::Uint8Array(buffers.colors)},
        {"widths", JsValue::Float32Array(buffers.widths)},
        {"featureIds", JsValue::Uint32Array(buffers.featureIds)},
    });
    if (withDashArrays) {
        result.set("dashArrays", JsValue::Float32Array(buffers.dashArray));
    }
    return result;
}

JsValue DeckFeatureLayerVisualization::geometryBuffersToJs(GeometryBuffers const& buffers)
{
    return JsValue::Dict({
        {"pointWorld", pointBuffersToJs(buffers.pointWorld)},
        {"pointBillboard", pointBuffersToJs(buffers.pointBillboard)},
        {"surface", surfaceBuffersToJs(buffers.surfaces)},
        {"pathWorld", pathBuffersToJs(buffers.pathWorld, true)},
        {"pathBillboard", pathBuffersToJs(buffers.pathBillboard, true)},
        {"arrowWorld", pathBuffersToJs(buffers.arrowWorld, false)},
        {"arrowBillboard", pathBuffersToJs(buffers.arrowBillboard, false)},
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
        if (rule.mode() != highlightMode_ || !rule.pointMergeGridCellSize()) {
            continue;
        }
        mergedPointsPerStyleRuleId_.emplace(
            makeMapLayerStyleRuleId(rule.index()),
            std::map<std::string, std::pair<std::unordered_set<uint32_t>, std::optional<JsValue>>>());
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

bool DeckFeatureLayerVisualization::hasGeometry(GeometryBuffers const& buffers)
{
    return hasGeometry(buffers.pointWorld)
        || hasGeometry(buffers.pointBillboard)
        || hasGeometry(buffers.surfaces)
        || hasGeometry(buffers.pathWorld)
        || hasGeometry(buffers.pathBillboard)
        || hasGeometry(buffers.arrowWorld)
        || hasGeometry(buffers.arrowBillboard);
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
    mapget::Point const& wgsPoint,
    glm::dvec3 const& wgsOffset) const
{
    mapget::Point adjustedWgs{
        wgsPoint.x + wgsOffset.x,
        wgsPoint.y + wgsOffset.y,
        wgsPoint.z + wgsOffset.z,
    };

    if (!hasPathCoordinateOriginWgs_) {
        if (tile_) {
            auto const tileCenter = tile_->tileId().center();
            pathCoordinateOriginWgs_ = {tileCenter.x, tileCenter.y, 0.0};
        } else {
            pathCoordinateOriginWgs_ = {adjustedWgs.x, adjustedWgs.y, 0.0};
        }
        hasPathCoordinateOriginWgs_ = true;
    }

    double unitsPerMeter = 0.0;
    double unitsPerMeter2 = 0.0;
    if (!distanceScalesAt(pathCoordinateOriginWgs_.y, unitsPerMeter, unitsPerMeter2)) {
        auto const lat0Rad = glm::radians(pathCoordinateOriginWgs_.y);
        auto const dLonRad = glm::radians(adjustedWgs.x - pathCoordinateOriginWgs_.x);
        auto const dLatRad = glm::radians(adjustedWgs.y - pathCoordinateOriginWgs_.y);
        return {
            dLonRad * std::cos(lat0Rad) * kFallbackEarthRadiusMeters,
            dLatRad * kFallbackEarthRadiusMeters,
            adjustedWgs.z - pathCoordinateOriginWgs_.z,
        };
    }

    auto const originWorldX = mercatorWorldX(pathCoordinateOriginWgs_.x);
    auto const originWorldY = mercatorWorldY(pathCoordinateOriginWgs_.y);
    auto const pointWorldX = mercatorWorldX(adjustedWgs.x);
    auto const pointWorldY = mercatorWorldY(adjustedWgs.y);
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
        adjustedWgs.z - pathCoordinateOriginWgs_.z,
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

void DeckFeatureLayerVisualization::emitIcon(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    appendPointGeometry(pointFromJsValue(xyzPos), rule, tileFeatureId, evalFun);
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
        buffers.featureIds.push_back(selectableFeatureId);
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
        buffers.surfaceStartIndices.push_back(static_cast<uint32_t>(buffers.surfacePositions.size() / 3));
        buffers.surfaceFeatureIds.push_back(selectableFeatureId);
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
            buffers.featureIds.push_back(selectableFeatureId);
            if (dashed) {
                buffers.dashArray.push_back(dashLength);
                buffers.dashArray.push_back(dashLength);
            }
            else {
                buffers.dashArray.push_back(1.0f);
                buffers.dashArray.push_back(0.0f);
            }
        }
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
            buffers.featureIds.push_back(selectableFeatureId);
        }
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

}  // namespace erdblick
