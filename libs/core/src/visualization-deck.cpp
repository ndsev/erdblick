#include "visualization-deck.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <type_traits>

using namespace mapget;

namespace erdblick
{

namespace {
constexpr uint32_t kUnselectableFeatureIndex = std::numeric_limits<uint32_t>::max();
constexpr double kEarthRadiusMeters = 6378137.0;
constexpr double kArrowHeadLengthMinMeters = 2.0;
constexpr double kArrowHeadLengthMaxMeters = 24.0;
constexpr double kArrowHeadLengthFraction = 0.35;
constexpr double kArrowHeadWidthFraction = 0.55;
constexpr double kArrowSegmentEpsilonMeters = 1e-6;

template <typename T>
void writeVectorToSharedBuffer(SharedUint8Array& out, std::vector<T> const& buffer)
{
    static_assert(std::is_trivially_copyable_v<T>);
    if (buffer.empty()) {
        static const char kEmpty = 0;
        out.writeToArray(&kEmpty, &kEmpty);
        return;
    }
    auto const* start = reinterpret_cast<const char*>(buffer.data());
    auto const* end = start + (buffer.size() * sizeof(T));
    out.writeToArray(start, end);
}
}

DeckFeatureLayerVisualization::DeckFeatureLayerVisualization(
    int viewIndex,
    std::string const& mapTileKey,
    const FeatureLayerStyle& style,
    NativeJsValue const& rawOptionValues,
    FeatureStyleRule::HighlightMode const& highlightMode,
    NativeJsValue const& rawFeatureIdSubset)
    : FeatureLayerVisualizationBase(
          viewIndex,
          mapTileKey,
          style,
          rawOptionValues,
          highlightMode,
          rawFeatureIdSubset)
{
    pathStartIndicesBuffer_.push_back(0);
    arrowStartIndicesBuffer_.push_back(0);
}

DeckFeatureLayerVisualization::~DeckFeatureLayerVisualization() = default;

uint32_t DeckFeatureLayerVisualization::abiVersion() const
{
    return 1u;
}

void DeckFeatureLayerVisualization::pathPositionsRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, pathPositionsBuffer_);
}

void DeckFeatureLayerVisualization::pathStartIndicesRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, pathStartIndicesBuffer_);
}

void DeckFeatureLayerVisualization::pathColorsRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, pathColorsBuffer_);
}

void DeckFeatureLayerVisualization::pathWidthsRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, pathWidthsBuffer_);
}

void DeckFeatureLayerVisualization::pathFeatureStartRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, pathFeatureStartBuffer_);
}

void DeckFeatureLayerVisualization::pathFeatureIdsRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, pathFeatureIdsBuffer_);
}

void DeckFeatureLayerVisualization::pathDashArrayRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, pathDashArrayBuffer_);
}

void DeckFeatureLayerVisualization::pathDashOffsetsRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, pathDashOffsetsBuffer_);
}

void DeckFeatureLayerVisualization::pathCoordinateOriginRaw(SharedUint8Array& out) const
{
    std::array<double, 3> origin = {
        pathCoordinateOriginWgs_.x,
        pathCoordinateOriginWgs_.y,
        pathCoordinateOriginWgs_.z,
    };
    if (!hasPathCoordinateOriginWgs_) {
        origin = {0.0, 0.0, 0.0};
    }
    auto const* start = reinterpret_cast<const char*>(origin.data());
    auto const* end = start + sizeof(origin);
    out.writeToArray(start, end);
}

void DeckFeatureLayerVisualization::arrowPositionsRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, arrowPositionsBuffer_);
}

void DeckFeatureLayerVisualization::arrowStartIndicesRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, arrowStartIndicesBuffer_);
}

void DeckFeatureLayerVisualization::arrowColorsRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, arrowColorsBuffer_);
}

void DeckFeatureLayerVisualization::arrowWidthsRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, arrowWidthsBuffer_);
}

void DeckFeatureLayerVisualization::arrowFeatureStartRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, arrowFeatureStartBuffer_);
}

void DeckFeatureLayerVisualization::arrowFeatureIdsRaw(SharedUint8Array& out) const {
    writeVectorToSharedBuffer(out, arrowFeatureIdsBuffer_);
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

    auto const lat0Rad = glm::radians(pathCoordinateOriginWgs_.y);
    auto const dLonRad = glm::radians(adjustedWgs.x - pathCoordinateOriginWgs_.x);
    auto const dLatRad = glm::radians(adjustedWgs.y - pathCoordinateOriginWgs_.y);

    return {
        dLonRad * std::cos(lat0Rad) * kEarthRadiusMeters,
        dLatRad * kEarthRadiusMeters,
        adjustedWgs.z - pathCoordinateOriginWgs_.z,
    };
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

    if (pathStartIndicesBuffer_.empty()) {
        pathStartIndicesBuffer_.push_back(0);
    }
    if (arrowStartIndicesBuffer_.empty()) {
        arrowStartIndicesBuffer_.push_back(0);
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
    for (auto const& point : vertsCartesian) {
        pathPositionsBuffer_.push_back(static_cast<float>(point.x));
        pathPositionsBuffer_.push_back(static_cast<float>(point.y));
        pathPositionsBuffer_.push_back(static_cast<float>(point.z));
    }
    pathStartIndicesBuffer_.push_back(static_cast<uint32_t>(pathPositionsBuffer_.size() / 3));

    const auto color = rule.color(evalFun);
    pathColorsBuffer_.push_back(toColorByte(color.r));
    pathColorsBuffer_.push_back(toColorByte(color.g));
    pathColorsBuffer_.push_back(toColorByte(color.b));
    pathColorsBuffer_.push_back(toColorByte(color.a));

    pathWidthsBuffer_.push_back(width);

    const auto pathIndex = static_cast<uint32_t>(pathFeatureStartBuffer_.size());
    pathFeatureStartBuffer_.push_back(pathIndex);
    pathFeatureIdsBuffer_.push_back(
        rule.selectable() ? tileFeatureId : kUnselectableFeatureIndex);

    if (enableDash && rule.isDashed()) {
        const auto dashLength = static_cast<float>(std::max(1, rule.dashLength()));
        pathDashArrayBuffer_.push_back(dashLength);
        pathDashArrayBuffer_.push_back(dashLength);
    }
    else {
        pathDashArrayBuffer_.push_back(1.0f);
        pathDashArrayBuffer_.push_back(0.0f);
    }
    pathDashOffsetsBuffer_.push_back(0.0f);

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

    for (auto const& point : vertsCartesian) {
        arrowPositionsBuffer_.push_back(static_cast<float>(point.x));
        arrowPositionsBuffer_.push_back(static_cast<float>(point.y));
        arrowPositionsBuffer_.push_back(static_cast<float>(point.z));
    }
    arrowStartIndicesBuffer_.push_back(static_cast<uint32_t>(arrowPositionsBuffer_.size() / 3));

    auto const color = rule.color(evalFun);
    arrowColorsBuffer_.push_back(toColorByte(color.r));
    arrowColorsBuffer_.push_back(toColorByte(color.g));
    arrowColorsBuffer_.push_back(toColorByte(color.b));
    arrowColorsBuffer_.push_back(toColorByte(color.a));

    arrowWidthsBuffer_.push_back(std::max(1.0f, width));

    const auto arrowIndex = static_cast<uint32_t>(arrowFeatureStartBuffer_.size());
    arrowFeatureStartBuffer_.push_back(arrowIndex);
    arrowFeatureIdsBuffer_.push_back(
        rule.selectable() ? tileFeatureId : kUnselectableFeatureIndex);

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

std::uint8_t DeckFeatureLayerVisualization::toColorByte(float value)
{
    const auto scaled = std::round(std::clamp(value, 0.0f, 1.0f) * 255.0f);
    return static_cast<std::uint8_t>(scaled);
}

}  // namespace erdblick
