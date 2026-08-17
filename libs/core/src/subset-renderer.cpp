#include "subset-renderer.h"
#include "style-filter-plan.h"

#include "geometry.h"
#include "mapget/model/hash.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <iterator>
#include <limits>
#include <sstream>

#include <glm/common.hpp>
#include <glm/exponential.hpp>
#include <glm/geometric.hpp>
#include <glm/trigonometric.hpp>

namespace erdblick
{
namespace
{

constexpr uint32_t kUnselectable = std::numeric_limits<uint32_t>::max();
constexpr double kPi = 3.14159265358979323846;
constexpr double kDegToRad = kPi / 180.0;
constexpr double kMercatorTileSize = 512.0;
constexpr double kMercatorMaximumLatitudeDegrees = 89.9;
constexpr double kMercatorTaylorMaximumLatitudeDeltaRadians = 0.001;
constexpr double kFallbackEarthRadiusMeters = 6378137.0;
constexpr double kEarthCircumferenceMeters = 40.03e6;
constexpr double kTransitionFilletMeters = 6.0;
constexpr double kTransitionUTurnTrimMeters = 0.9;
constexpr size_t kTransitionFilletSamples = 8;
constexpr double kTransitionMaximumAngularStep = 5.0 * kDegToRad;
// Once adaptive contraction is active, an offset-vector change may consume at
// most half of the corresponding centerline segment's forward motion. This is
// evaluated on the exact sampled path below; unlike a trim-radius estimate it
// remains valid for acute and almost-reversing cross-road turns.
constexpr double kTransitionMaximumReverseMotionFraction = 0.5;

double planarDistance(mapget::Point const& left, mapget::Point const& right)
{
    return std::hypot(left.x - right.x, left.y - right.y);
}

mapget::Point interpolatePoint(
    mapget::Point const& from,
    mapget::Point const& to,
    double amount)
{
    return mapget::Point{
        from.x + (to.x - from.x) * amount,
        from.y + (to.y - from.y) * amount,
        from.z + (to.z - from.z) * amount,
    };
}

double lineLength(std::vector<mapget::Point> const& points)
{
    double result = 0.0;
    for (size_t index = 1; index < points.size(); ++index) {
        result += planarDistance(points[index - 1], points[index]);
    }
    return result;
}

std::vector<mapget::Point> trimLineEnd(
    std::vector<mapget::Point> const& points,
    double trimMeters)
{
    if (points.size() < 2 || trimMeters <= 0.0) {
        return points;
    }
    double remaining = trimMeters;
    for (size_t index = points.size() - 1; index > 0; --index) {
        auto const segmentLength = planarDistance(points[index - 1], points[index]);
        if (segmentLength <= 1.0e-9) {
            continue;
        }
        if (segmentLength >= remaining) {
            auto result = std::vector<mapget::Point>(
                points.begin(),
                points.begin() + static_cast<std::ptrdiff_t>(index));
            result.push_back(interpolatePoint(
                points[index],
                points[index - 1],
                remaining / segmentLength));
            return result;
        }
        remaining -= segmentLength;
    }
    return {points.front()};
}

std::vector<mapget::Point> trimLineStart(
    std::vector<mapget::Point> const& points,
    double trimMeters)
{
    if (points.size() < 2 || trimMeters <= 0.0) {
        return points;
    }
    double remaining = trimMeters;
    for (size_t index = 1; index < points.size(); ++index) {
        auto const segmentLength = planarDistance(points[index - 1], points[index]);
        if (segmentLength <= 1.0e-9) {
            continue;
        }
        if (segmentLength >= remaining) {
            std::vector<mapget::Point> result;
            result.reserve(points.size() - index + 1);
            result.push_back(interpolatePoint(
                points[index - 1],
                points[index],
                remaining / segmentLength));
            result.insert(
                result.end(),
                points.begin() + static_cast<std::ptrdiff_t>(index),
                points.end());
            return result;
        }
        remaining -= segmentLength;
    }
    return {points.back()};
}

std::optional<std::array<double, 2>> terminalDirection(
    std::vector<mapget::Point> const& points,
    bool atEnd)
{
    if (points.size() < 2) {
        return std::nullopt;
    }
    if (atEnd) {
        for (size_t index = points.size() - 1; index > 0; --index) {
            auto const dx = points[index].x - points[index - 1].x;
            auto const dy = points[index].y - points[index - 1].y;
            auto const length = std::hypot(dx, dy);
            if (length > 1.0e-9) {
                return std::array{dx / length, dy / length};
            }
        }
    }
    else {
        for (size_t index = 1; index < points.size(); ++index) {
            auto const dx = points[index].x - points[index - 1].x;
            auto const dy = points[index].y - points[index - 1].y;
            auto const length = std::hypot(dx, dy);
            if (length > 1.0e-9) {
                return std::array{dx / length, dy / length};
            }
        }
    }
    return std::nullopt;
}

mapget::Point cubicPoint(
    mapget::Point const& p0,
    mapget::Point const& p1,
    mapget::Point const& p2,
    mapget::Point const& p3,
    double t)
{
    auto const u = 1.0 - t;
    auto const a = u * u * u;
    auto const b = 3.0 * u * u * t;
    auto const c = 3.0 * u * t * t;
    auto const d = t * t * t;
    return mapget::Point{
        a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        a * p0.y + b * p1.y + c * p2.y + d * p3.y,
        a * p0.z + b * p1.z + c * p2.z + d * p3.z,
    };
}

double transitionOffsetScaleThreshold(
    std::span<mapget::Point const> points,
    std::span<glm::fvec2 const> offsetVectorsPx)
{
    if (points.size() < 2 || offsetVectorsPx.size() < points.size()) {
        return 0.0;
    }
    auto threshold = std::numeric_limits<double>::infinity();
    for (size_t index = 1; index < points.size(); ++index) {
        auto const baseX = points[index].x - points[index - 1].x;
        auto const baseY = points[index].y - points[index - 1].y;
        auto const baseLengthSquared = baseX * baseX + baseY * baseY;
        if (baseLengthSquared <= 1.0e-12) {
            continue;
        }
        auto const offsetX = static_cast<double>(
            offsetVectorsPx[index].x - offsetVectorsPx[index - 1].x);
        auto const offsetY = static_cast<double>(
            offsetVectorsPx[index].y - offsetVectorsPx[index - 1].y);
        auto const reverseMotion = -(baseX * offsetX + baseY * offsetY);
        if (reverseMotion <= 1.0e-12) {
            continue;
        }
        threshold = std::min(
            threshold,
            kTransitionMaximumReverseMotionFraction *
                baseLengthSquared / reverseMotion);
    }
    return std::isfinite(threshold) ? threshold : 0.0;
}

bool hasLocalOffset(glm::dvec3 const& offset)
{
    return offset.x != 0.0 || offset.y != 0.0 || offset.z != 0.0;
}

std::vector<uint32_t> channelRuleIndices(std::string_view channelId)
{
    auto const separator = channelId.rfind(':');
    if (separator == std::string_view::npos ||
        separator + 1 >= channelId.size())
    {
        return {};
    }
    std::vector<uint32_t> result;
    auto suffix = channelId.substr(separator + 1);
    while (!suffix.empty()) {
        auto const comma = suffix.find(',');
        auto const token = suffix.substr(0, comma);
        uint32_t value = 0;
        auto parsed = std::from_chars(
            token.data(),
            token.data() + token.size(),
            value);
        if (parsed.ec != std::errc{} ||
            parsed.ptr != token.data() + token.size())
        {
            return {};
        }
        result.push_back(value);
        if (comma == std::string_view::npos) {
            break;
        }
        suffix.remove_prefix(comma + 1U);
    }
    return result;
}

bool fidelityMatches(
    FeatureStyleRule::Fidelity requested,
    FeatureStyleRule::Fidelity rule)
{
    return requested == FeatureStyleRule::AnyFidelity ||
        rule == FeatureStyleRule::AnyFidelity ||
        requested == rule;
}

std::optional<std::string_view> geometryName(
    mapget::model_ptr<mapget::Geometry> const& geometry)
{
    if (!geometry) {
        return std::nullopt;
    }
    auto const& name = geometry->name();
    return name
        ? std::optional<std::string_view>{*name}
        : std::nullopt;
}

std::optional<mapget::Point> collectionCenter(
    mapget::model_ptr<mapget::GeometryCollection> const& collection)
{
    std::optional<mapget::Point> result;
    if (!collection) {
        return result;
    }
    collection->forEachGeometry(
        [&](mapget::model_ptr<mapget::Geometry> const& geometry) {
            if (!geometry) {
                return true;
            }
            auto selfContained = geometry->toSelfContained();
            if (selfContained.points_.empty()) {
                return true;
            }
            result = geometryCenter(selfContained);
            return false;
        });
    return result;
}

mapget::SelfContainedGeometry applyPresentationTransform(
    mapget::SelfContainedGeometry geometry,
    FeatureStyleRule const& rule,
    glm::dvec3 const& offset)
{
    if (rule.flat()) {
        for (auto& point : geometry.points_) {
            point.z = 0.0;
        }
    }
    return hasLocalOffset(offset)
        ? offsetGeometryLocally(geometry, offset)
        : geometry;
}

mapget::Point offsetAabbOrigin(
    mapget::Point origin,
    FeatureStyleRule const& rule,
    glm::dvec3 const& offset)
{
    if (rule.flat()) {
        origin.z = 0.0;
    }
    if (!hasLocalOffset(offset)) {
        return origin;
    }
    auto shifted = offsetGeometryLocally(
        mapget::SelfContainedGeometry{
            {origin},
            {},
            mapget::GeomType::Points,
        },
        offset);
    return shifted.points_.empty() ? origin : shifted.points_.front();
}

int32_t labelOriginCode(std::string_view origin)
{
    if (origin == "LEFT" || origin == "TOP" || origin == "BELOW") {
        return -1;
    }
    if (origin == "RIGHT" || origin == "BOTTOM" || origin == "ABOVE") {
        return 1;
    }
    if (origin == "BASELINE") {
        return 2;
    }
    return 0;
}

/** Parsed layer-wide TextLayer font properties from the compact CSS shorthand. */
struct ParsedLabelFont {
    float size = 14.0F;
    std::string family;
    uint32_t weight = 400U;
};

/** Extract the pixel size, family, and nearest numeric/bold weight token. */
ParsedLabelFont parseLabelFont(std::string const& font)
{
    ParsedLabelFont result{.family = font};
    auto const pixels = font.find("px");
    if (pixels != std::string::npos) {
        auto const separator = pixels == 0U
            ? std::string::npos
            : font.find_last_of(" \t", pixels - 1U);
        auto const begin = separator == std::string::npos
            ? 0U
            : separator + 1U;
        if (begin < pixels) {
            float parsedSize = result.size;
            auto const parsed = std::from_chars(
                font.data() + begin,
                font.data() + pixels,
                parsedSize);
            if (parsed.ec == std::errc{} &&
                parsed.ptr == font.data() + pixels &&
                std::isfinite(parsedSize) && parsedSize > 0.0F)
            {
                result.size = parsedSize;
            }
        }
        auto const familyBegin = font.find_first_not_of(" \t", pixels + 2U);
        result.family = familyBegin == std::string::npos
            ? std::string{"Helvetica"}
            : font.substr(familyBegin);
        if (separator != std::string::npos) {
            auto const weightEnd = font.find_last_not_of(" \t", separator);
            if (weightEnd != std::string::npos) {
                auto const weightSeparator = weightEnd == 0U
                    ? std::string::npos
                    : font.find_last_of(" \t", weightEnd - 1U);
                auto const weightBegin = weightSeparator == std::string::npos
                    ? 0U
                    : weightSeparator + 1U;
                auto const token = std::string_view(font).substr(
                    weightBegin,
                    weightEnd - weightBegin + 1U);
                uint32_t parsedWeight = result.weight;
                auto const parsed = std::from_chars(
                    token.data(),
                    token.data() + token.size(),
                    parsedWeight);
                if (parsed.ec == std::errc{} &&
                    parsed.ptr == token.data() + token.size() &&
                    parsedWeight > 0U && parsedWeight <= 1000U)
                {
                    result.weight = parsedWeight;
                }
                else if (token == "bold") {
                    result.weight = 700U;
                }
                else if (token == "normal") {
                    result.weight = 400U;
                }
            }
        }
    }
    return result;
}

double mercatorWorldX(double longitudeDeg)
{
    return (kMercatorTileSize * ((longitudeDeg * kDegToRad) + kPi)) /
        (2.0 * kPi);
}

double mercatorWorldY(double latitudeDeg)
{
    auto const latitudeRad = glm::clamp(
        latitudeDeg,
        -kMercatorMaximumLatitudeDegrees,
        kMercatorMaximumLatitudeDegrees) * kDegToRad;
    auto const mercatorTerm =
        glm::log(glm::tan((kPi * 0.25) + (latitudeRad * 0.5)));
    return (kMercatorTileSize * (kPi + mercatorTerm)) / (2.0 * kPi);
}

bool distanceScalesAt(
    double latitudeDeg,
    double& latitudeCosine,
    double& latitudeTangent,
    double& unitsPerMeter)
{
    auto const latitudeRad = glm::clamp(
        latitudeDeg,
        -kMercatorMaximumLatitudeDegrees,
        kMercatorMaximumLatitudeDegrees) * kDegToRad;
    latitudeCosine = glm::cos(latitudeRad);
    latitudeTangent = glm::tan(latitudeRad);
    if (!std::isfinite(latitudeCosine) ||
        !std::isfinite(latitudeTangent) ||
        std::abs(latitudeCosine) < 1e-12)
    {
        return false;
    }
    auto const worldSize = kMercatorTileSize;
    auto const latCosine = std::abs(latitudeCosine);
    unitsPerMeter =
        worldSize / kEarthCircumferenceMeters / latCosine;
    return std::isfinite(unitsPerMeter) && std::abs(unitsPerMeter) > 1e-12;
}

/** Preserve the distinction between an authored zero and no z-index at all. */
double resolvedZIndex(
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun)
{
    return rule.zIndex(evalFun).value_or(
        std::numeric_limits<double>::quiet_NaN());
}

JsValue gltfBuffersToJs(
    TileSubsetLayerRenderer::GltfBuffers const& buffers)
{
    return JsValue::Dict({
        {"nodeIndices", JsValue::Uint32Array(buffers.nodeIndices)},
        {"colors", JsValue::Uint8Array(buffers.colors)},
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
    });
}

JsValue gltfPickProxyBuffersToJs(
    TileSubsetLayerRenderer::GltfPickProxyBuffers const& buffers)
{
    return JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.positions)},
        {"startIndices", JsValue::Uint32Array(buffers.startIndices)},
        {"nodeIndices", JsValue::Uint32Array(buffers.nodeIndices)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
    });
}

} // namespace

size_t TileSubsetLayerRenderer::PickRefHash::operator()(
    PickRef const& value) const noexcept
{
    auto result = std::hash<uint32_t>{}(value.channelOrdinal);
    result ^= std::hash<uint32_t>{}(value.entryOrdinal) +
        0x9e3779b9U + (result << 6U) + (result >> 2U);
    result ^= std::hash<uint32_t>{}(value.endpointRole) +
        0x9e3779b9U + (result << 6U) + (result >> 2U);
    return result;
}

void TileSubsetLayerRenderer::ProjectedGeometryCache::reset()
{
    for (size_t index = 0; index < activeCount; ++index) {
        entries[index].points.clear();
    }
    activeCount = 0;
}

TileSubsetLayerRenderer::ProjectedGeometryCacheEntry*
TileSubsetLayerRenderer::ProjectedGeometryCache::find(
    simfil::ModelNodeAddress address,
    bool simplified)
{
    auto const active = std::span(entries).first(activeCount);
    auto const found = std::ranges::find(
        active,
        std::pair{address, simplified},
        [](ProjectedGeometryCacheEntry const& entry) {
            return std::pair{entry.address, entry.simplified};
        });
    return found == active.end() ? nullptr : &*found;
}

TileSubsetLayerRenderer::ProjectedGeometryCacheEntry&
TileSubsetLayerRenderer::ProjectedGeometryCache::append(
    simfil::ModelNodeAddress address,
    bool simplified)
{
    if (activeCount == entries.size()) {
        entries.emplace_back();
    }
    auto& entry = entries[activeCount++];
    entry.address = address;
    entry.simplified = simplified;
    entry.points.clear();
    return entry;
}

TileSubsetLayerRenderer::TileSubsetLayerRenderer(
    int /*viewIndex*/,
    std::string const& /*mapTileKey*/,
    FeatureLayerStyle const& style,
    int highlightMode,
    int fidelity)
    : style_(style),
      highlightMode_(
          highlightMode >= static_cast<int>(FeatureStyleRule::NoHighlight) &&
              highlightMode <=
                  static_cast<int>(FeatureStyleRule::SelectionHighlight)
              ? static_cast<FeatureStyleRule::HighlightMode>(highlightMode)
              : FeatureStyleRule::NoHighlight),
      fidelity_(
          fidelity >= static_cast<int>(FeatureStyleRule::AnyFidelity) &&
              fidelity <= static_cast<int>(FeatureStyleRule::LowFidelity)
              ? static_cast<FeatureStyleRule::Fidelity>(fidelity)
              : FeatureStyleRule::AnyFidelity)
{
    bridgeBuffers_.gltfPickProxies.startIndices.push_back(0);
}

TileSubsetLayerRenderer::~TileSubsetLayerRenderer() = default;

void TileSubsetLayerRenderer::resetForNextTile()
{
    subset_.reset();
    gpuContributionContext_ = {};
    bridgeBuffers_.gltfNodes.nodeIndices.clear();
    bridgeBuffers_.gltfNodes.colors.clear();
    bridgeBuffers_.gltfNodes.depthTests.clear();
    bridgeBuffers_.gltfNodes.featureAddresses.clear();
    bridgeBuffers_.gltfPickProxies.positions.clear();
    bridgeBuffers_.gltfPickProxies.startIndices.clear();
    bridgeBuffers_.gltfPickProxies.startIndices.push_back(0U);
    bridgeBuffers_.gltfPickProxies.nodeIndices.clear();
    bridgeBuffers_.gltfPickProxies.featureAddresses.clear();
    gpuPacketBuilder_.reset();
    projectedPointsScratch_.clear();
    wgsPathScratch_.clear();
    simplifiedPathScratch_.clear();
    pathSimplificationKeepScratch_.clear();
    pathSimplificationRangeScratch_.clear();
    featureGeometriesScratch_.clear();
    featureProjectionCacheScratch_.reset();
    vertexCount_ = 0U;
    bridgePickResults_.clear();
    pickRefs_.clear();
    pickNavigationAltitudes_.clear();
    pickIndices_.clear();
    runtimeIssues_.clear();
    runtimeIssueIndices_.clear();
    renderedRelationEndpointParts_.clear();
    renderedRelationEndpointLabels_.clear();
    relationEndpointLabelIdentity_.reset();
    featureOffsetSlotsByRule_.clear();
    attributeOffsetSlotsByFeature_.clear();
    attributeOffsetSlotsBySegment_.clear();
    attributeOffsetSlotsByTransitionLeg_.clear();
    transitionOffsetScaleGroups_.clear();
    subsetMapDepthSeed_ = 0U;
    currentDepthIdentity_ = 0U;
    subsetDepthPhase_ = 0U;
    gpuIconResources_.clear();
    hasCoordinateOriginWgs_ = false;
    coordinateOriginWgs_ = {0.0, 0.0, 0.0};
    coordinateOriginWorldX_ = 0.0;
    coordinateOriginWorldY_ = 0.0;
    coordinateOriginCosine_ = 1.0;
    coordinateOriginTangent_ = 0.0;
    coordinateUnitsPerMeter_ = 0.0;
    coordinateScalesValid_ = false;
    gpuSceneGeneration_ = 0U;
    gpuPacketSequence_ = 0U;
    gpuIconCatalogVersion_ = 0U;
    gpuOriginSlot_ = 0U;
    gpuOriginKey_ = 0U;
    lineSimplificationToleranceMeters_ = 0.0;
    hasRun_ = false;
}

void TileSubsetLayerRenderer::setCoordinateOrigin(
    double longitude,
    double latitude,
    double altitude)
{
    coordinateOriginWgs_ = {
        longitude,
        latitude,
        altitude,
    };
    hasCoordinateOriginWgs_ = true;
    coordinateOriginWorldX_ = mercatorWorldX(longitude);
    coordinateOriginWorldY_ = mercatorWorldY(latitude);
    coordinateScalesValid_ = distanceScalesAt(
        latitude,
        coordinateOriginCosine_,
        coordinateOriginTangent_,
        coordinateUnitsPerMeter_);
}

void TileSubsetLayerRenderer::setLineSimplificationTolerance(
    double toleranceMeters)
{
    lineSimplificationToleranceMeters_ =
        std::isfinite(toleranceMeters)
        ? std::max(0.0, toleranceMeters)
        : 0.0;
}

void TileSubsetLayerRenderer::configureGpuPacket(
    uint32_t sceneGeneration,
    uint32_t packetSequence,
    uint32_t iconCatalogVersion,
    uint32_t originSlot,
    uint32_t originKeyLow,
    uint32_t originKeyHigh)
{
    gpuSceneGeneration_ = sceneGeneration;
    gpuPacketSequence_ = packetSequence;
    gpuIconCatalogVersion_ = iconCatalogVersion;
    gpuOriginSlot_ = originSlot;
    gpuOriginKey_ = static_cast<uint64_t>(originKeyLow) |
        (static_cast<uint64_t>(originKeyHigh) << 32U);
}

void TileSubsetLayerRenderer::addGpuIconResource(
    std::string const& uri,
    uint32_t atlasPage,
    float u0,
    float v0,
    float u1,
    float v1,
    float pixelWidth,
    float pixelHeight)
{
    if (uri.empty() ||
        !std::isfinite(u0) || !std::isfinite(v0) ||
        !std::isfinite(u1) || !std::isfinite(v1) ||
        !std::isfinite(pixelWidth) || !std::isfinite(pixelHeight) ||
        u0 < 0.0F || v0 < 0.0F || u1 < u0 || v1 < v0 ||
        u1 > 1.0F || v1 > 1.0F ||
        pixelWidth <= 0.0F || pixelHeight <= 0.0F)
    {
        throw std::invalid_argument("Invalid GPU icon catalog entry.");
    }
    gpuIconResources_.insert_or_assign(uri, GpuIconResource{
        .atlasPage = atlasPage,
        .uv = {u0, v0, u1, v1},
        .pixelSize = {pixelWidth, pixelHeight},
    });
}

void TileSubsetLayerRenderer::addTileSubsetContribution(
    TileSubsetLayer const& subset,
    uint32_t contributionKeyLow,
    uint32_t contributionKeyHigh,
    uint32_t contributionRevision,
    uint32_t contributionSlot,
    uint32_t contributionActivationToken)
{
    if (!subset.model_) {
        throw std::invalid_argument("Cannot render an empty tile subset.");
    }
    if (subset_) {
        throw std::logic_error(
            "TileSubsetLayerRenderer accepts exactly one tile subset.");
    }
    subset_ = subset.model_;
    subsetMapDepthSeed_ = mapget::Hash{}
        .mix(subset_->mapId())
        .value();
    // Classic effectiveRenderOrder values repeat their source-list fraction in
    // every tile. Keep neighboring tiles on distinct stable depth phases so
    // their overlapping edge geometry cannot fight as packets arrive.
    subsetDepthPhase_ = subset_->tileId().mortonNumber() & 0xFU;
    gpuContributionContext_ = {
        .key = static_cast<uint64_t>(contributionKeyLow) |
            (static_cast<uint64_t>(contributionKeyHigh) << 32U),
        .revision = contributionRevision,
        .slot = contributionSlot,
        .activationToken = contributionActivationToken,
    };
    if (!hasCoordinateOriginWgs_) {
        coordinateOriginWgs_ = subset_->geometryAnchor();
        coordinateOriginWgs_.z = 0.0;
        hasCoordinateOriginWgs_ = true;
        coordinateOriginWorldX_ = mercatorWorldX(coordinateOriginWgs_.x);
        coordinateOriginWorldY_ = mercatorWorldY(coordinateOriginWgs_.y);
        coordinateScalesValid_ = distanceScalesAt(
            coordinateOriginWgs_.y,
            coordinateOriginCosine_,
            coordinateOriginTangent_,
            coordinateUnitsPerMeter_);
    }
}

std::vector<FeatureStyleRule const*> TileSubsetLayerRenderer::rulesForChannel(
    std::string const& channelId) const
{
    std::vector<FeatureStyleRule const*> result;
    for (auto const sourceIndex : channelRuleIndices(channelId)) {
        for (auto const& rule : style_.rules()) {
            if (rule.index() == sourceIndex &&
                rule.mode() == highlightMode_ &&
                fidelityMatches(fidelity_, rule.fidelity()))
            {
                result.push_back(&rule);
                break;
            }
        }
    }
    return result;
}

TileSubsetLayerRenderer::ChannelBinding const&
TileSubsetLayerRenderer::bindingFor(
    mapget::model_ptr<mapget::TileSubsetChannel> const& channel)
{
    if (!channel) {
        throw std::invalid_argument(
            "Cannot bind an empty subset channel.");
    }
    auto const channelId = channel->channelId();
    auto [found, inserted] = channelBindings_.try_emplace(channelId);
    auto& binding = found->second;
    if (inserted) {
        binding.rules = rulesForChannel(channelId);
        binding.hasBranches = std::ranges::any_of(
            binding.rules,
            [](FeatureStyleRule const* rule) {
                return rule &&
                    rule->branchMode() != FeatureStyleRule::BranchMode::None;
            });
        binding.fuseWithNext.assign(binding.rules.size(), uint8_t{0U});
        if (!binding.hasBranches) {
            for (size_t index = 1U; index < binding.rules.size(); ++index) {
                binding.fuseWithNext[index - 1U] =
                    canFuseFeatureRulePair(
                        *binding.rules[index - 1U],
                        *binding.rules[index])
                    ? uint8_t{1U}
                    : uint8_t{0U};
            }
        }
        binding.featureFields.expressions = channel->featureFields();
        binding.entryFields.expressions = channel->entryFields();
    }
    if (binding.rules.empty()) {
        // Search result-list channels are consumed by TypeScript and intentionally
        // have no authored rendering rule.
        if (channelId.starts_with("search-results:")) {
            return binding;
        }
        auto const sourceIndices = channelRuleIndices(channelId);
        auto const hasInactiveSourceRule = std::ranges::any_of(
            style_.rules(),
            [&](FeatureStyleRule const& rule) {
                return std::ranges::find(sourceIndices, rule.index()) !=
                        sourceIndices.end() &&
                    rule.mode() == highlightMode_;
            });
        // A bundle planned with AnyFidelity intentionally contains both
        // fidelity variants so the view can switch without a refetch.
        // Skipping the inactive variant is therefore not a style error.
        if (!hasInactiveSourceRule) {
            recordRuntimeIssue(
                "channelId",
                channelId,
                "No active top-level style rule matches this subset channel.",
                0);
        }
    }
    return binding;
}

void TileSubsetLayerRenderer::run()
{
    if (hasRun_) {
        throw std::logic_error(
            "TileSubsetLayerRenderer is a one-shot packet producer.");
    }
    if (!subset_) {
        throw std::logic_error(
            "TileSubsetLayerRenderer requires exactly one tile subset.");
    }
    hasRun_ = true;
    gpuPacketBuilder_.reset();
    gpuPacketBuilder_.configure(
        gpuSceneGeneration_,
        gpuPacketSequence_,
        gpuIconCatalogVersion_,
        GpuPacketOrigin{
            .slot = gpuOriginSlot_,
            .key = gpuOriginKey_,
            .longitude = coordinateOriginWgs_.x,
            .latitude = coordinateOriginWgs_.y,
            .altitude = coordinateOriginWgs_.z,
        });
    size_t terminalEntryCount = 0;
    subset_->forEachChannel(
        [&](mapget::model_ptr<mapget::TileSubsetChannel> const& channel) {
            if (!channel) {
                return true;
            }
            terminalEntryCount += channel->entryCount();
            return true;
        });
    pickRefs_.reserve(terminalEntryCount);
    pickIndices_.reserve(terminalEntryCount);
    gpuPacketBuilder_.beginContribution(
        gpuContributionContext_.key,
        gpuContributionContext_.revision,
        gpuContributionContext_.slot,
        gpuContributionContext_.activationToken);
    uint32_t channelOrdinal = 0;
    subset_->forEachChannel(
            [&](mapget::model_ptr<mapget::TileSubsetChannel> const& channel) {
                auto const currentChannelOrdinal = channelOrdinal++;
                auto const& binding = bindingFor(channel);
                if (binding.rules.empty()) {
                    return true;
                }
                uint32_t entryOrdinal = 0;
                switch (channel->scope()) {
                case mapget::Scope::Feature:
                    channel->forEachFeatureEntry(
                        [&](mapget::model_ptr<mapget::FeatureEntry> const& entry) {
                            renderFeature(
                                currentChannelOrdinal,
                                entryOrdinal++,
                                binding,
                                entry);
                            return true;
                        });
                    break;
                case mapget::Scope::Attribute:
                    channel->forEachAttributeValidityEntry(
                        [&](mapget::model_ptr<mapget::AttributeValidityEntry> const& entry) {
                            renderAttribute(
                                currentChannelOrdinal,
                                entryOrdinal++,
                                binding,
                                entry);
                            return true;
                        });
                    break;
                case mapget::Scope::Relation:
                    channel->forEachRelationEntry(
                        [&](mapget::model_ptr<mapget::RelationEntry> const& entry) {
                            renderRelation(
                                currentChannelOrdinal,
                                entryOrdinal++,
                                binding,
                                entry);
                            return true;
                        });
                    break;
                case mapget::Scope::Group:
                    channel->forEachGroupEntry(
                        [&](mapget::model_ptr<mapget::GroupEntry> const& entry) {
                            renderGroup(
                                currentChannelOrdinal,
                                entryOrdinal++,
                                binding,
                                entry);
                            return true;
                        });
                    break;
                }
                return true;
            });
    gpuPacketBuilder_.endContribution();
    for (uint32_t index = 0U; index < pickRefs_.size(); ++index) {
        auto const& pick = pickRefs_[index];
        gpuPacketBuilder_.appendPick({
            .contributionIndex = 0U,
            .localPickIndex = index,
            .channelOrdinal = pick.channelOrdinal,
            .entryOrdinal = pick.entryOrdinal,
            .endpointRole = pick.endpointRole,
            .navigationAltitude = pickNavigationAltitudes_[index],
        });
    }
    for (auto const& issue : runtimeIssues_) {
        gpuPacketBuilder_.appendRuntimeIssue({
            .contributionIndex = 0U,
            .ruleIndex = issue.ruleIndex,
            .occurrenceCount = issue.occurrenceCount,
            .property = issue.property,
            .expression = issue.expression,
            .message = issue.message,
        });
    }
}

BoundEvalFun TileSubsetLayerRenderer::makeEvalFun(
    ProjectedFields const& fields,
    mapget::model_ptr<mapget::Array> const& values,
    ProjectedEvalState& state)
{
    state = {
        .renderer = this,
        .fields = &fields,
        .values = values,
    };
    BoundEvalFun result;
    result.context_ = &state;
    result.evalRef_ = [](void* context, std::string const& expression) {
            auto& state = *static_cast<ProjectedEvalState*>(context);
            auto& fields = *state.fields;
            auto const foundBinding = std::ranges::find(
                fields.bindings,
                &expression,
                [](auto const& binding) {
                    return binding.first;
                });
            uint32_t index = std::numeric_limits<uint32_t>::max();
            if (foundBinding != fields.bindings.end()) {
                index = foundBinding->second;
            }
            else {
                auto const projectedExpression =
                    expandStyleExpressionForFilter(expression);
                auto const found = std::find(
                    fields.expressions.begin(),
                    fields.expressions.end(),
                    projectedExpression);
                if (found == fields.expressions.end()) {
                    state.renderer->recordRuntimeIssue(
                        "projection",
                        expression,
                        "Style expression was not projected by its subset channel.",
                        0);
                    return simfil::Value::undef();
                }
                index = static_cast<uint32_t>(
                    std::distance(fields.expressions.begin(), found));
                fields.bindings.emplace_back(&expression, index);
            }
            if (index == state.lastIndex) {
                return state.lastValue;
            }
            if (!state.values || index >= state.values->size()) {
                state.renderer->recordRuntimeIssue(
                    "projection",
                    expression,
                    "Projected value array does not match its channel schema.",
                    0);
                state.lastIndex = index;
                state.lastValue = simfil::Value::undef();
                return state.lastValue;
            }
            auto node = state.values->at(index);
            state.lastIndex = index;
            state.lastValue = node
                ? simfil::Value::field(*node)
                : simfil::Value::undef();
            return state.lastValue;
        };
    result.reportIssueRef_ = [](
            void* context,
            std::string const& property,
            std::string const& expression,
            std::string const& message,
            uint32_t ruleIndex)
        {
            static_cast<ProjectedEvalState*>(context)->renderer->recordRuntimeIssue(
                property,
                expression,
                message,
                ruleIndex);
        };
    return result;
}

bool TileSubsetLayerRenderer::forEachAdmittedRule(
    FeatureStyleRule const& rule,
    FeatureStyleRule::MatchContext const& context,
    BoundEvalFun const& entryEvalFun,
    std::function<void(FeatureStyleRule const&)> const& callback,
    BoundEvalFun const* featureEvalFun) const
{
    if (rule.branchMode() == FeatureStyleRule::BranchMode::None) {
        callback(rule);
        return true;
    }
    if (rule.branchMode() == FeatureStyleRule::BranchMode::FirstOf) {
        for (auto const& child : rule.subRules()) {
            if (child.forEachMatchingRule(
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
    for (auto const& child : rule.subRules()) {
        matched = child.forEachMatchingRule(
            context,
            entryEvalFun,
            callback,
            featureEvalFun) || matched;
    }
    return matched;
}

void TileSubsetLayerRenderer::renderFeature(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    ChannelBinding const& binding,
    mapget::model_ptr<mapget::FeatureEntry> const& entry)
{
    if (!entry || binding.rules.empty()) {
        return;
    }
    auto const geometry = entry->geometry();
    if (!geometry) {
        return;
    }
    ProjectedEvalState evalState;
    auto eval = makeEvalFun(
        binding.featureFields,
        binding.featureFields.expressions.empty()
            ? mapget::model_ptr<mapget::Array>{}
            : entry->values(),
        evalState);
    auto const needsFeatureType = binding.hasBranches;
    auto featureId = needsFeatureType
        ? entry->featureId()
        : mapget::model_ptr<mapget::FeatureId>{};
    if (needsFeatureType && !featureId) {
        return;
    }
    if (!featureId) {
        featureId = entry->featureId();
    }
    if (!featureId) {
        return;
    }
    currentDepthIdentity_ = featureDepthIdentity(featureId);
    FeatureStyleRule::MatchContext context{
        .featureType = featureId
            ? featureId->typeId()
            : std::string_view{},
    };
    featureGeometriesScratch_.clear();
    if (geometry) {
        geometry->forEachGeometry(
            [&](mapget::model_ptr<mapget::Geometry> const& item) {
                if (item) {
                    featureGeometriesScratch_.push_back({
                        .geometry = item,
                        .type = item->geomType(),
                        .name = geometryName(item),
                    });
                }
                return true;
            });
    }
    featureProjectionCacheScratch_.reset();
    std::optional<uint32_t> selectablePick;
    auto const* rules = &binding.rules;
    auto const* fuseWithNext = &binding.fuseWithNext;
    if (binding.hasBranches) {
        featureRulesScratch_.clear();
        for (auto const* topLevelRule : binding.rules) {
            if (topLevelRule->branchMode() == FeatureStyleRule::BranchMode::None) {
                featureRulesScratch_.push_back(topLevelRule);
                continue;
            }
            auto const matched = forEachAdmittedRule(
                *topLevelRule,
                context,
                eval,
                [&](FeatureStyleRule const& rule) {
                    featureRulesScratch_.push_back(&rule);
                });
            if (!matched) {
                recordRuntimeIssue(
                    "rule-match",
                    std::string(context.featureType),
                    "A server-admitted feature entry matched no concrete leaf of its top-level style rule.",
                    topLevelRule->index());
            }
        }
        rules = &featureRulesScratch_;
        fuseWithNext = nullptr;
    }
    for (size_t index = 0U; index < rules->size();) {
        auto const canFuse = index + 1U < rules->size() &&
            (fuseWithNext
                ? (*fuseWithNext)[index] != 0U
                : canFuseFeatureRulePair(
                    *(*rules)[index],
                    *(*rules)[index + 1U]));
        if (canFuse &&
            renderFeatureRulePair(
                geometry,
                featureGeometriesScratch_,
                *(*rules)[index],
                *(*rules)[index + 1U],
                eval,
                selectablePick,
                channelOrdinal,
                entryOrdinal))
        {
            index += 2U;
            continue;
        }
        renderFeatureRule(
            entry,
            geometry,
            featureGeometriesScratch_,
            *(*rules)[index],
            eval,
            featureId,
            selectablePick,
            channelOrdinal,
            entryOrdinal);
        ++index;
    }
}

void TileSubsetLayerRenderer::renderFeatureRule(
    mapget::model_ptr<mapget::FeatureEntry> const& entry,
    mapget::model_ptr<mapget::GeometryCollection> const& geometry,
    std::vector<ResolvedFeatureGeometry> const& geometries,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    mapget::model_ptr<mapget::FeatureId>& featureId,
    std::optional<uint32_t>& selectablePick,
    uint32_t channelOrdinal,
    uint32_t entryOrdinal)
{
    if (rule.selectable() && !selectablePick) {
        selectablePick = featurePickIndex(
            channelOrdinal,
            entryOrdinal,
            true);
    }
    auto const pick = rule.selectable()
        ? *selectablePick
        : kUnselectable;
    auto const increment = rule.offsetIncrement();
    auto const stacked = hasLocalOffset(increment);
    auto const slot = stacked
        ? featureOffsetSlotsByRule_[rule.renderIndex()]
        : 0U;
    auto const gltfCount = bridgeBuffers_.gltfNodes.nodeIndices.size();
    if (renderGeometryCollection(
            geometry,
            rule,
            evalFun,
            pick,
            rule.offset() + increment * static_cast<double>(slot),
            &featureProjectionCacheScratch_,
            &geometries) && stacked)
    {
        ++featureOffsetSlotsByRule_[rule.renderIndex()];
    }
    if (pick != kUnselectable &&
        bridgeBuffers_.gltfNodes.nodeIndices.size() > gltfCount &&
        !bridgePickResults_.contains(pick))
    {
        if (!featureId) {
            featureId = entry->featureId();
        }
        if (!featureId) {
            return;
        }
        bridgePickResults_[pick].featureId = featureId->toString();
    }
}

bool TileSubsetLayerRenderer::renderFeatureRulePair(
    mapget::model_ptr<mapget::GeometryCollection> const& geometry,
    std::vector<ResolvedFeatureGeometry> const& geometries,
    FeatureStyleRule const& outerRule,
    FeatureStyleRule const& innerRule,
    BoundEvalFun const& evalFun,
    std::optional<uint32_t>& selectablePick,
    uint32_t channelOrdinal,
    uint32_t entryOrdinal)
{
    auto const outerColor = outerRule.color(evalFun);
    auto const innerColor = innerRule.color(evalFun);
    auto const outerWidth = outerRule.width(evalFun);
    auto const innerWidth = innerRule.width(evalFun);
    if (!outerColor || !innerColor || innerWidth <= 0.0F ||
        outerWidth <= innerWidth)
    {
        return false;
    }
    auto const outerZIndex = resolvedZIndex(outerRule, evalFun);
    auto const innerZIndex = resolvedZIndex(innerRule, evalFun);
    if (outerZIndex != innerZIndex &&
        !(std::isnan(outerZIndex) && std::isnan(innerZIndex)))
    {
        return false;
    }
    if (innerRule.selectable() && !selectablePick) {
        selectablePick = featurePickIndex(
            channelOrdinal,
            entryOrdinal,
            true);
    }
    auto const pick = innerRule.selectable()
        ? *selectablePick
        : kUnselectable;
    auto const resolvedStyle = ResolvedGeometryStyle{
        .color = *outerColor,
        .zIndex = innerZIndex,
        .pathWidth = outerWidth,
        .pathArrow = FeatureStyleRule::NoArrow,
        .pathOverlay = GpuPathOverlay{
            .width = innerWidth,
            .color = {
                toColorByte(innerColor->r),
                toColorByte(innerColor->g),
                toColorByte(innerColor->b),
                toColorByte(innerColor->a),
            },
        },
    };
    static_cast<void>(renderGeometryCollection(
        geometry,
        innerRule,
        evalFun,
        pick,
        innerRule.offset(),
        &featureProjectionCacheScratch_,
        &geometries,
        &resolvedStyle));
    return true;
}

bool TileSubsetLayerRenderer::canFuseFeatureRulePair(
    FeatureStyleRule const& outerRule,
    FeatureStyleRule const& innerRule)
{
    constexpr auto kLineMask = uint32_t{1U} <<
        static_cast<std::underlying_type_t<mapget::GeomType>>(
            mapget::GeomType::Line);
    auto sameOffset = [](glm::dvec3 const& left, glm::dvec3 const& right) {
        return left.x == right.x && left.y == right.y && left.z == right.z;
    };
    auto zeroOffset = [](glm::dvec3 const& value) {
        return value.x == 0.0 && value.y == 0.0 && value.z == 0.0;
    };
    if (outerRule.geometryTypesMask() != kLineMask ||
        innerRule.geometryTypesMask() != kLineMask ||
        outerRule.geometryName() != innerRule.geometryName() ||
        outerRule.hasLabel() || innerRule.hasLabel() ||
        outerRule.isDashed() || innerRule.isDashed() ||
        outerRule.glow() || innerRule.glow() ||
        outerRule.flat() != innerRule.flat() ||
        outerRule.billboard() != innerRule.billboard() ||
        outerRule.depthTest() != innerRule.depthTest() ||
        outerRule.lateralOffsetUnit() != innerRule.lateralOffsetUnit() ||
        innerRule.lateralOffsetUnit() !=
            FeatureStyleRule::LateralOffsetUnit::Meter ||
        !sameOffset(outerRule.offset(), innerRule.offset()) ||
        !zeroOffset(outerRule.offsetIncrement()) ||
        !zeroOffset(innerRule.offsetIncrement()) ||
        (outerRule.selectable() && !innerRule.selectable()) ||
        outerRule.constantArrow() != FeatureStyleRule::NoArrow ||
        innerRule.constantArrow() != FeatureStyleRule::NoArrow)
    {
        return false;
    }
    return true;
}

void TileSubsetLayerRenderer::renderAttribute(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    ChannelBinding const& binding,
    mapget::model_ptr<mapget::AttributeValidityEntry> const& entry)
{
    if (!entry || binding.rules.empty()) {
        return;
    }
    auto const& topLevelRule = *binding.rules.front();
    auto const featureId = entry->featureId();
    if (!featureId) {
        return;
    }
    auto attributeIdentity = mapget::Hash{};
    attributeIdentity.hash_ = featureDepthIdentity(featureId);
    attributeIdentity
        .mix(entry->attributeIndex().value_or(
            mapget::AttributeValidityEntry::InvalidAttributeIndex))
        .mix(entry->hasValidity())
        .mix(entry->validityIndex());
    currentDepthIdentity_ = attributeIdentity.value();
    ProjectedEvalState hostEvalState;
    ProjectedEvalState entryEvalState;
    auto hostEval = makeEvalFun(
        binding.featureFields,
        entry->hostValues(),
        hostEvalState);
    auto entryEval = makeEvalFun(
        binding.entryFields,
        entry->values(),
        entryEvalState);
    auto const attributeName = entry->attributeName();
    auto const attributeLayer = entry->attributeLayer();
    auto const featureIdString = featureId->toString();
    FeatureStyleRule::MatchContext context{
        .featureType = featureId->typeId(),
        .attributeName = attributeName
            ? std::optional<std::string_view>{*attributeName}
            : std::nullopt,
        .attributeLayer = attributeLayer
            ? std::optional<std::string_view>{*attributeLayer}
            : std::nullopt,
        .hasValidity = entry->hasValidity(),
    };
    forEachAdmittedRule(
        topLevelRule,
        context,
        entryEval,
        [&](FeatureStyleRule const& rule) {
            auto const pick = pickIndex(
                channelOrdinal,
                entryOrdinal,
                0,
                rule.selectable(),
                [&] { return pickResult(entry, featureIdString); });
            auto const slotKey =
                std::to_string(channelOrdinal) + ":" +
                featureIdString + ":" +
                std::to_string(rule.renderIndex());
            auto& slot =
                attributeOffsetSlotsByFeature_[slotKey];
            bool rendered = false;
            if ((entry->isFeatureTransition() ||
                 rule.offsetIncrement().x != 0.0 ||
                 (rule.lateralOffsetUnit() ==
                      FeatureStyleRule::LateralOffsetUnit::Pixel &&
                  rule.offset().x != 0.0)) &&
                entry->geometry())
            {
                entry->geometry()->forEachGeometry(
                    [&](mapget::model_ptr<mapget::Geometry> const& geometry) {
                        if (geometry &&
                            geometry->geomType() == mapget::GeomType::Line)
                        {
                            auto const stackPrefix =
                                std::to_string(channelOrdinal) + ":" +
                                std::to_string(rule.renderIndex());
                            rendered = (entry->isFeatureTransition()
                                ? renderTransitionLine(
                                    entry,
                                    geometry,
                                    rule,
                                    entryEval,
                                    pick,
                                    stackPrefix)
                                : renderSegmentStackedLine(
                                    geometry,
                                    rule,
                                    entryEval,
                                    pick,
                                    stackPrefix)) || rendered;
                        }
                        else {
                            rendered =
                                renderGeometry(
                                    geometry,
                                    rule,
                                    entryEval,
                                    pick,
                                    rule.offset() +
                                        rule.offsetIncrement() *
                                            static_cast<double>(slot)) ||
                                rendered;
                        }
                        return true;
                    });
            }
            else {
                rendered = renderGeometryCollection(
                    entry->geometry(),
                    rule,
                    entryEval,
                    pick,
                    rule.offset() +
                        rule.offsetIncrement() *
                            static_cast<double>(slot));
            }
            if (rendered)
            {
                // AttributeValidityEntry is the renderer's terminal row. Each
                // rendered validity (including multiple validities of one
                // attribute) therefore consumes one presentation slot.
                ++slot;
            }
        },
        &hostEval);
}

void TileSubsetLayerRenderer::renderGroup(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    ChannelBinding const& binding,
    mapget::model_ptr<mapget::GroupEntry> const& entry)
{
    if (!entry || binding.rules.empty()) {
        return;
    }
    auto const& topLevelRule = *binding.rules.front();
    auto const representativeFeatureId = entry->representativeFeatureId();
    if (!representativeFeatureId) {
        return;
    }
    currentDepthIdentity_ = featureDepthIdentity(representativeFeatureId);
    ProjectedEvalState evalState;
    auto eval = makeEvalFun(
        binding.entryFields,
        entry->values(),
        evalState);
    FeatureStyleRule::MatchContext context{
        .featureType = representativeFeatureId->typeId(),
    };
    auto const matched = forEachAdmittedRule(
        topLevelRule,
        context,
        eval,
        [&](FeatureStyleRule const& rule) {
            auto const pick = pickIndex(
                channelOrdinal,
                entryOrdinal,
                0,
                rule.selectable(),
                [&] { return pickResult(entry, representativeFeatureId); });
            auto const increment = rule.offsetIncrement();
            auto const stacked = hasLocalOffset(increment);
            auto const slot = stacked
                ? featureOffsetSlotsByRule_[rule.renderIndex()]
                : 0U;
            if (renderGeometryCollection(
                    entry->geometry(),
                    rule,
                    eval,
                    pick,
                    rule.offset() +
                        increment *
                            static_cast<double>(slot)))
            {
                if (stacked) {
                    ++featureOffsetSlotsByRule_[rule.renderIndex()];
                }
            }
        });
    if (!matched) {
        recordRuntimeIssue(
            "rule-match",
            std::string(context.featureType),
            "A server-admitted group entry matched no concrete leaf of its top-level style rule.",
            topLevelRule.index());
    }
}

void TileSubsetLayerRenderer::renderRelation(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    ChannelBinding const& binding,
    mapget::model_ptr<mapget::RelationEntry> const& entry)
{
    if (!entry || binding.rules.empty()) {
        return;
    }
    auto const& topLevelRule = *binding.rules.front();
    auto const source = entry->source();
    auto const target = entry->target();
    auto const sourceFeatureId = source
        ? source->featureId()
        : mapget::model_ptr<mapget::FeatureId>{};
    auto const targetFeatureId = target
        ? target->featureId()
        : mapget::model_ptr<mapget::FeatureId>{};
    if (!source || !target || !sourceFeatureId || !targetFeatureId) {
        return;
    }
    auto const relationName = entry->name();
    auto relationIdentity = mapget::Hash{};
    relationIdentity.hash_ = featureDepthIdentity(sourceFeatureId);
    relationIdentity
        .mix(featureDepthIdentity(targetFeatureId))
        .mix(entry->relationId());
    auto const relationDepthIdentity = relationIdentity.value();

    ProjectedEvalState relationEvalState;
    auto relationEval = makeEvalFun(
        binding.entryFields,
        entry->values(),
        relationEvalState);
    FeatureStyleRule::MatchContext relationContext{
        .featureType = sourceFeatureId->typeId(),
        .relationName = relationName,
    };
    forEachAdmittedRule(
        topLevelRule,
        relationContext,
        relationEval,
        [&](FeatureStyleRule const& rule) {
            currentDepthIdentity_ = relationDepthIdentity;
            auto const relationPick = pickIndex(
                channelOrdinal,
                entryOrdinal,
                0,
                rule.selectable(),
                [&] {
                    return pickResult(
                        entry,
                        sourceFeatureId,
                        targetFeatureId,
                        0);
                });
            renderRelationLine(
                entry->sourceGeometry(),
                entry->targetGeometry(),
                source->geometry(),
                target->geometry(),
                rule,
                relationEval,
                relationPick);

            auto renderEndpoint =
                [&](mapget::model_ptr<mapget::FeatureEntry> const& endpoint,
                    mapget::model_ptr<mapget::FeatureId> const& endpointFeatureId,
                    mapget::model_ptr<mapget::GeometryCollection> const& geometry,
                    std::shared_ptr<FeatureStyleRule> const& endpointStyle,
                    uint32_t endpointRole)
            {
                if (!endpoint || !endpointFeatureId || !geometry || !endpointStyle)
                {
                    return;
                }
                ProjectedEvalState endpointEvalState;
                auto endpointEval = makeEvalFun(
                    binding.featureFields,
                    endpoint->values(),
                    endpointEvalState);
                FeatureStyleRule::MatchContext endpointContext{
                    .featureType = endpointFeatureId->typeId(),
                };
                std::optional<std::string> endpointFeatureIdString;
                auto getEndpointFeatureIdString = [&]() -> std::string const& {
                    if (!endpointFeatureIdString) {
                        endpointFeatureIdString = endpointFeatureId->toString();
                    }
                    return *endpointFeatureIdString;
                };
                endpointStyle->forEachMatchingRule(
                    endpointContext,
                    endpointEval,
                    [&](FeatureStyleRule const& endpointRule) {
                        std::ostringstream key;
                        key << endpointFeatureId->mapId() << ':'
                            << getEndpointFeatureIdString() << ':'
                            << endpointRule.renderIndex();
                        if (!renderedRelationEndpointParts_
                                 .insert(key.str())
                                 .second)
                        {
                            return;
                        }
                        auto const endpointPick = pickIndex(
                            channelOrdinal,
                            entryOrdinal,
                            endpointRole,
                            endpointRule.selectable(),
                            [&] {
                                return pickResult(
                                    entry,
                                    sourceFeatureId,
                                    targetFeatureId,
                                    endpointRole);
                            });
                        auto const previousLabelIdentity =
                            relationEndpointLabelIdentity_;
                        auto const previousDepthIdentity =
                            currentDepthIdentity_;
                        currentDepthIdentity_ =
                            featureDepthIdentity(endpointFeatureId);
                        relationEndpointLabelIdentity_ =
                            endpointFeatureId->mapId() + "\n" +
                            getEndpointFeatureIdString();
                        renderGeometryCollection(
                            geometry,
                            endpointRule,
                            endpointEval,
                            endpointPick,
                            endpointRule.offset());
                        relationEndpointLabelIdentity_ =
                            previousLabelIdentity;
                        currentDepthIdentity_ = previousDepthIdentity;
                    });
            };

            renderEndpoint(
                source,
                sourceFeatureId,
                entry->sourceGeometry(),
                rule.relationSourceStyle(),
                1);
            renderEndpoint(
                target,
                targetFeatureId,
                entry->targetGeometry(),
                rule.relationTargetStyle(),
                2);
        });
}

bool TileSubsetLayerRenderer::renderGeometryCollection(
    mapget::model_ptr<mapget::GeometryCollection> const& collection,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    uint32_t pick,
    glm::dvec3 const& offset,
    ProjectedGeometryCache* projectionCache,
    std::vector<ResolvedFeatureGeometry> const*
        resolvedGeometries,
    ResolvedGeometryStyle const* resolvedStyle)
{
    bool rendered = false;
    std::optional<mapget::Point> labelPosition;
    if (!collection && !resolvedGeometries) {
        return rendered;
    }
    auto renderOne =
        [&](mapget::model_ptr<mapget::Geometry> const& geometry,
            std::optional<mapget::GeomType> resolvedType,
            std::optional<std::string_view> resolvedName) {
            if (!geometry) {
                return true;
            }
            auto const type = resolvedType
                ? *resolvedType
                : geometry->geomType();
            auto const renderedGeometry = renderGeometry(
                geometry,
                rule,
                evalFun,
                pick,
                offset,
                false,
                projectionCache,
                resolvedType,
                resolvedName,
                resolvedStyle);
            if (renderedGeometry && !labelPosition && rule.hasLabel())
            {
                auto presentationOffset = offset;
                if (type == mapget::GeomType::Line &&
                    rule.lateralOffsetUnit() ==
                        FeatureStyleRule::LateralOffsetUnit::Pixel)
                {
                    presentationOffset.x = 0.0;
                }
                auto transformed = applyPresentationTransform(
                    geometry->toSelfContained(),
                    rule,
                    presentationOffset);
                if (!transformed.points_.empty()) {
                    labelPosition = projectWgsPoint(
                        geometryCenter(transformed));
                }
            }
            rendered = renderedGeometry || rendered;
            return true;
    };
    if (resolvedGeometries) {
        for (auto const& resolved : *resolvedGeometries) {
            renderOne(
                resolved.geometry,
                resolved.type,
                resolved.name);
        }
    }
    else {
        collection->forEachGeometry(
            [&](mapget::model_ptr<mapget::Geometry> const& geometry) {
                return renderOne(geometry, std::nullopt, std::nullopt);
            });
    }
    if (rendered && labelPosition && rule.hasLabel()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
            appendLabel(
                *labelPosition,
                text,
                rule,
                resolvedStyle
                    ? resolvedStyle->zIndex
                    : resolvedZIndex(rule, evalFun),
                pick);
        }
    }
    return rendered;
}

bool TileSubsetLayerRenderer::renderGeometry(
    mapget::model_ptr<mapget::Geometry> const& geometry,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    uint32_t pick,
    glm::dvec3 const& offset,
    bool renderLabel,
    ProjectedGeometryCache* projectionCache,
    std::optional<mapget::GeomType> resolvedType,
    std::optional<std::string_view> resolvedName,
    ResolvedGeometryStyle const* resolvedStyle)
{
    if (!geometry) {
        return false;
    }
    auto const name = resolvedType ? resolvedName : geometryName(geometry);
    auto const type = resolvedType
        ? *resolvedType
        : geometry->geomType();
    auto const supportsOwnType = rule.supports(type, name);
    auto const gltfAsAabb =
        type == mapget::GeomType::GltfNodeIndex &&
        rule.supports(mapget::GeomType::AABB, name);
    if (!supportsOwnType && !gltfAsAabb) {
        return false;
    }

    auto color = resolvedStyle
        ? std::optional<glm::fvec4>{resolvedStyle->color}
        : rule.color(evalFun);
    if (!color) {
        return false;
    }
    auto const zIndex = resolvedStyle
        ? resolvedStyle->zIndex
        : resolvedZIndex(rule, evalFun);
    auto const pathWidth = type == mapget::GeomType::Line
        ? std::max(
            0.0F,
            resolvedStyle
                ? resolvedStyle->pathWidth
                : rule.width(evalFun))
        : 0.0F;
    auto const pathArrow = type == mapget::GeomType::Line
        ? resolvedStyle
            ? resolvedStyle->pathArrow
            : rule.arrow(evalFun)
        : FeatureStyleRule::NoArrow;
    if (type == mapget::GeomType::Line && pathWidth <= 0.0F &&
        !rule.hasLabel())
    {
        return false;
    }

    if (type == mapget::GeomType::GltfNodeIndex) {
        if (supportsOwnType) {
            appendGltf(geometry, rule, evalFun, pick);
        }
        else {
            appendAabb(
                offsetAabbOrigin(
                    geometry->gltfNodeAabbOrigin(),
                    rule,
                    offset),
                geometry->gltfNodeAabbSize(),
                rule,
                *color,
                zIndex,
                pick);
        }
        return true;
    }
    if (type == mapget::GeomType::AABB) {
        appendAabb(
            offsetAabbOrigin(
                geometry->aabbOrigin(),
                rule,
                offset),
            geometry->aabbSize(),
            rule,
            *color,
            zIndex,
            pick);
        return true;
    }

    auto presentationOffset = offset;
    auto const pixelLateralOffset =
        type == mapget::GeomType::Line &&
        rule.lateralOffsetUnit() ==
            FeatureStyleRule::LateralOffsetUnit::Pixel;
    if (pixelLateralOffset) {
        presentationOffset.x = 0.0;
    }
    auto const simplifyBeforeProjection =
        type == mapget::GeomType::Line &&
        lineSimplificationToleranceMeters_ > 0.0 &&
        !pixelLateralOffset &&
        !rule.isDashed() &&
        pathArrow == FeatureStyleRule::NoArrow;
    mapget::SelfContainedGeometry transformed;
    auto const needsTransform = rule.flat() || hasLocalOffset(presentationOffset);
    std::vector<mapget::Point> const* projected = nullptr;
    if (needsTransform || type == mapget::GeomType::Polygon) {
        transformed = applyPresentationTransform(
            geometry->toSelfContained(),
            rule,
            presentationOffset);
        if (simplifyBeforeProjection) {
            projectPathPoints(
                transformed.points_,
                true,
                projectedPointsScratch_);
        }
        else {
            projectedPointsScratch_.clear();
            projectedPointsScratch_.reserve(transformed.points_.size());
            for (auto const& point : transformed.points_) {
                projectedPointsScratch_.push_back(projectWgsPoint(point));
            }
        }
        projected = &projectedPointsScratch_;
    }
    else if (projectionCache) {
        auto* found = projectionCache->find(
            geometry->addr(),
            simplifyBeforeProjection);
        if (!found) {
            found = &projectionCache->append(
                geometry->addr(),
                simplifyBeforeProjection);
            wgsPathScratch_.clear();
            geometry->forEachPoint([&](mapget::Point&& point) {
                wgsPathScratch_.push_back(std::move(point));
                return true;
            });
            projectPathPoints(
                wgsPathScratch_,
                simplifyBeforeProjection,
                found->points);
        }
        projected = &found->points;
    }
    else {
        wgsPathScratch_.clear();
        geometry->forEachPoint([&](mapget::Point&& point) {
            wgsPathScratch_.push_back(std::move(point));
            return true;
        });
        projectPathPoints(
            wgsPathScratch_,
            simplifyBeforeProjection,
            projectedPointsScratch_);
        projected = &projectedPointsScratch_;
    }

    switch (type) {
    case mapget::GeomType::Points:
        if (rule.hasIconUrl()) {
            auto const uri = rule.iconUrl(evalFun);
            for (auto const& point : *projected) {
                appendIcon(
                    point,
                    uri,
                    rule,
                    evalFun,
                    *color,
                    zIndex,
                    pick);
            }
        }
        else {
            for (auto const& point : *projected) {
                appendPoint(
                    point,
                    rule,
                    evalFun,
                    *color,
                    zIndex,
                    pick);
            }
        }
        break;
    case mapget::GeomType::Line:
        if (pixelLateralOffset) {
            appendPath(
                *projected,
                rule,
                *color,
                zIndex,
                pick,
                pathWidth,
                pathArrow,
                std::vector<float>(
                    projected->size(),
                    static_cast<float>(offset.x)));
        }
        else {
            appendPath(
                *projected,
                rule,
                *color,
                zIndex,
                pick,
                pathWidth,
                pathArrow,
                {},
                {},
                0.0F,
                simplifyBeforeProjection,
                resolvedStyle
                    ? resolvedStyle->pathOverlay
                    : std::nullopt);
        }
        break;
    case mapget::GeomType::Polygon:
        appendSurface(
            *projected,
            transformed.polygonRingStarts_,
            rule,
            *color,
            zIndex,
            pick);
        break;
    case mapget::GeomType::Mesh:
        appendMesh(*projected, rule, *color, zIndex, pick);
        break;
    case mapget::GeomType::AABB:
    case mapget::GeomType::GltfNodeIndex:
        break;
    }

    if (renderLabel && rule.hasLabel() && !projected->empty()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
        auto labelPoint = transformed.points_.empty()
                ? (*projected)[projected->size() / 2U]
                : projectWgsPoint(geometryCenter(transformed));
            appendLabel(
                labelPoint,
                text,
                rule,
                zIndex,
                pick);
        }
    }
    return !projected->empty();
}

bool TileSubsetLayerRenderer::renderTransitionLine(
    mapget::model_ptr<mapget::AttributeValidityEntry> const& entry,
    mapget::model_ptr<mapget::Geometry> const& geometry,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    uint32_t pick,
    std::string const& stackPrefix)
{
    if (!entry || !entry->isFeatureTransition() || !geometry ||
        geometry->geomType() != mapget::GeomType::Line ||
        !rule.supports(mapget::GeomType::Line, geometryName(geometry)))
    {
        return false;
    }
    auto const source = geometry->toSelfContained();
    auto const pivot = entry->transitionPivotIndex();
    auto const fromId = entry->transitionFromFeatureId();
    auto const toId = entry->transitionToFeatureId();
    auto const fromEnd = entry->transitionFromConnectedEnd();
    auto const toEnd = entry->transitionToConnectedEnd();
    if (!pivot || *pivot == 0 || *pivot + 1 >= source.points_.size() ||
        !fromId || !toId || !fromEnd || !toEnd)
    {
        return false;
    }
    auto color = rule.color(evalFun);
    auto const width = rule.width(evalFun);
    if (!color || width <= 0.0f) {
        return false;
    }
    auto const arrow = rule.arrow(evalFun);
    auto const zIndex = resolvedZIndex(rule, evalFun);

    std::vector<mapget::Point> incomingWgs(
        source.points_.begin(),
        source.points_.begin() + static_cast<std::ptrdiff_t>(*pivot));
    std::vector<mapget::Point> outgoingWgs(
        source.points_.begin() + static_cast<std::ptrdiff_t>(*pivot + 1),
        source.points_.end());
    if (incomingWgs.size() < 2 || outgoingWgs.size() < 2) {
        return false;
    }

    auto projectLeg = [&](std::vector<mapget::Point> const& points) {
        std::vector<mapget::Point> projected;
        projected.reserve(points.size());
        for (auto const& point : points) {
            projected.push_back(projectWgsPoint(point));
        }
        return projected;
    };
    auto const incomingCenterline = projectLeg(incomingWgs);
    auto const outgoingCenterline = projectLeg(outgoingWgs);
    auto const incomingDirection =
        terminalDirection(incomingCenterline, true);
    auto const outgoingDirection =
        terminalDirection(outgoingCenterline, false);
    if (!incomingDirection || !outgoingDirection) {
        return false;
    }

    // Deck and offsetGeometryLocally both define positive lateral offset as
    // right-of-traversal.  Transition geometry is ordered outer -> junction ->
    // outer, so the signed cross product gives the desired visible road side:
    // clockwise/right turns are positive and counter-clockwise/left turns are
    // negative.  Connected-end metadata is only needed to translate that
    // visible side into the road's canonical digitization side for stacking.
    auto const headingCross =
        (*incomingDirection)[0] * (*outgoingDirection)[1] -
        (*incomingDirection)[1] * (*outgoingDirection)[0];
    // A sharp cross-road turn is still an ordinary transition: it needs the
    // full fillet and ordinary safety calculation. Geometry alone cannot
    // distinguish it from a U-turn. The latter returns to the same connected
    // end of the same road and receives the deliberately compact hairpin
    // construction below.
    auto const uTurn =
        fromId->toString() == toId->toString() && *fromEnd == *toEnd;
    constexpr double kTurnSideThreshold = 0.05;

    auto legKey = [&](mapget::model_ptr<mapget::FeatureId> const& id,
                      mapget::ValidityData::TransitionEnd end,
                      int canonicalSide) {
        return stackPrefix + ":" + id->toString() + ":" +
            (end == mapget::ValidityData::End ? "end" : "start") + ":" +
            (canonicalSide > 0 ? "right" : "left");
    };

    auto stackKeys = [&](int pathSide) {
        // Incoming traversal follows digitization when the connected road end
        // is End. Outgoing traversal follows it when the connected end is
        // Start. Reversed traversal swaps the road's physical left/right side.
        auto const fromCanonicalSide =
            *fromEnd == mapget::ValidityData::End
            ? pathSide
            : -pathSide;
        auto const toCanonicalSide =
            *toEnd == mapget::ValidityData::Start
            ? pathSide
            : -pathSide;
        return std::pair{
            legKey(fromId, *fromEnd, fromCanonicalSide),
            legKey(toId, *toEnd, toCanonicalSide),
        };
    };

    int pathSide = headingCross > kTurnSideThreshold
        ? -1
        : headingCross < -kTurnSideThreshold
            ? 1
            : uTurn
                // A geometrically exact U-turn has no cross-product sign.
                // Prefer the conventional left-side hairpin.
                ? -1
                : 0;
    if (pathSide == 0) {
        // Straight transitions have no intrinsic side. Put them on the side
        // whose two physical road-side stacks are least occupied. Preserve
        // the authored sign only as the stable tie-breaker.
        auto authoredSide = rule.offset().x;
        if (std::abs(authoredSide) <= 1.0e-12) {
            authoredSide = rule.offsetIncrement().x;
        }
        auto const preferredSide = authoredSide < 0.0 ? -1 : 1;
        auto sideCost = [&](int candidate) {
            auto const [candidateFrom, candidateTo] = stackKeys(candidate);
            auto const fromCount =
                attributeOffsetSlotsByTransitionLeg_[candidateFrom];
            auto const toCount =
                attributeOffsetSlotsByTransitionLeg_[candidateTo];
            return std::pair{
                std::max(fromCount, toCount),
                fromCount + toCount,
            };
        };
        auto const preferredCost = sideCost(preferredSide);
        auto const alternateCost = sideCost(-preferredSide);
        pathSide = alternateCost < preferredCost
            ? -preferredSide
            : preferredSide;
    }

    auto const [fromKey, toKey] = stackKeys(pathSide);
    auto const fromSlot = attributeOffsetSlotsByTransitionLeg_[fromKey];
    auto const toSlot = attributeOffsetSlotsByTransitionLeg_[toKey];
    auto lateralOffsetForSlot = [&](uint32_t slot) {
        // Turn direction owns the sign; the style owns lane distance and
        // spacing. This prevents a positive YAML offset from forcing every
        // maneuver onto the right side.
        auto const magnitude = std::abs(
            rule.offset().x +
            rule.offsetIncrement().x * static_cast<double>(slot));
        return static_cast<double>(pathSide) * magnitude;
    };
    auto const fromLateralOffset = lateralOffsetForSlot(fromSlot);
    auto const toLateralOffset = lateralOffsetForSlot(toSlot);

    auto transformLeg = [&](std::vector<mapget::Point> const& points,
                            uint32_t selectedSlot,
                            double lateralOffset) {
        auto offset = rule.offset() +
            rule.offsetIncrement() * static_cast<double>(selectedSlot);
        if (rule.lateralOffsetUnit() ==
            FeatureStyleRule::LateralOffsetUnit::Pixel)
        {
            offset.x = 0.0;
        }
        else {
            offset.x = lateralOffset;
        }
        auto transformed = applyPresentationTransform(
            mapget::SelfContainedGeometry{
                points,
                {},
                mapget::GeomType::Line,
            },
            rule,
            offset);
        return projectLeg(transformed.points_);
    };
    auto incoming = transformLeg(
        incomingWgs,
        fromSlot,
        fromLateralOffset);
    auto outgoing = transformLeg(
        outgoingWgs,
        toSlot,
        toLateralOffset);
    auto const incomingLength = lineLength(incoming);
    auto const outgoingLength = lineLength(outgoing);
    auto const maximumTrim = std::min({
        uTurn ? kTransitionUTurnTrimMeters : kTransitionFilletMeters,
        incomingLength * 0.4,
        outgoingLength * 0.4,
    });
    if (maximumTrim <= 1.0e-6) {
        return false;
    }
    // Slightly different U-turn trim distances keep the two centerline
    // endpoints distinct. Together with the pixel-side displacement this
    // produces a compact hairpin instead of a large self-returning teardrop.
    auto const incomingTrim = uTurn ? maximumTrim * 0.75 : maximumTrim;
    auto const outgoingTrim = uTurn ? maximumTrim * 1.25 : maximumTrim;
    incoming = trimLineEnd(incoming, incomingTrim);
    outgoing = trimLineStart(outgoing, outgoingTrim);
    auto const curveIncomingDirection = terminalDirection(incoming, true);
    auto const curveOutgoingDirection = terminalDirection(outgoing, false);
    if (incoming.size() < 2 || outgoing.size() < 2 ||
        !curveIncomingDirection || !curveOutgoingDirection)
    {
        return false;
    }

    auto const pixelOffsets =
        rule.lateralOffsetUnit() ==
        FeatureStyleRule::LateralOffsetUnit::Pixel;
    auto const fromLateralOffsetPx = pixelOffsets
        ? static_cast<float>(fromLateralOffset)
        : 0.0f;
    auto const toLateralOffsetPx = pixelOffsets
        ? static_cast<float>(toLateralOffset)
        : 0.0f;
    auto offsetVector = [](std::array<double, 2> const& direction,
                           float lateralOffsetPx) {
        return glm::fvec2{
            static_cast<float>(direction[1]) * lateralOffsetPx,
            static_cast<float>(-direction[0]) * lateralOffsetPx,
        };
    };
    auto const fromOffsetVectorPx =
        offsetVector(*curveIncomingDirection, fromLateralOffsetPx);
    auto const toOffsetVectorPx =
        offsetVector(*curveOutgoingDirection, toLateralOffsetPx);
    auto const maximumLateralOffsetPx = std::max(
        std::abs(fromLateralOffsetPx),
        std::abs(toLateralOffsetPx));
    auto const fromOffsetUnit =
        offsetVector(*curveIncomingDirection, static_cast<float>(pathSide));
    auto const toOffsetUnit =
        offsetVector(*curveOutgoingDirection, static_cast<float>(pathSide));
    auto const offsetUnitCross =
        static_cast<double>(fromOffsetUnit.x) * toOffsetUnit.y -
        static_cast<double>(fromOffsetUnit.y) * toOffsetUnit.x;
    auto const offsetUnitDot =
        static_cast<double>(fromOffsetUnit.x) * toOffsetUnit.x +
        static_cast<double>(fromOffsetUnit.y) * toOffsetUnit.y;
    auto offsetRotation = glm::atan(offsetUnitCross, offsetUnitDot);
    if (uTurn) {
        // The offset-vector arc itself forms the visible compact hairpin. It
        // must initially advance with the incoming road and finish with the
        // outgoing road, which is the opposite rotation direction from an
        // inside parallel curve. Pick that winding while retaining the exact
        // (possibly slightly non-antiparallel) endpoint vector.
        if (pathSide < 0 && offsetRotation >= 0.0) {
            offsetRotation -= 2.0 * kPi;
        }
        else if (pathSide > 0 && offsetRotation <= 0.0) {
            offsetRotation += 2.0 * kPi;
        }
    }
    else if (offsetUnitDot < -0.999999 &&
             std::abs(offsetUnitCross) <= 1.0e-6)
    {
        // A geometrically exact cross-road hairpin has two equally short
        // inside curves. Keep its winding deterministic from the chosen side.
        offsetRotation = pathSide < 0 ? kPi : -kPi;
    }
    auto const bridgeSamples = std::max<size_t>(
        kTransitionFilletSamples,
        static_cast<size_t>(std::ceil(
            std::abs(offsetRotation) /
            kTransitionMaximumAngularStep)));
    auto interpolateOffsetVector = [&](double progress) {
        if (progress <= 0.0) {
            return fromOffsetVectorPx;
        }
        if (progress >= 1.0) {
            return toOffsetVectorPx;
        }
        auto const magnitude =
            std::abs(static_cast<double>(fromLateralOffsetPx)) +
            (std::abs(static_cast<double>(toLateralOffsetPx)) -
             std::abs(static_cast<double>(fromLateralOffsetPx))) * progress;
        auto const angle = offsetRotation * progress;
        auto const cosine = glm::cos(angle);
        auto const sine = glm::sin(angle);
        return glm::fvec2{
            static_cast<float>(
                (fromOffsetUnit.x * cosine -
                 fromOffsetUnit.y * sine) * magnitude),
            static_cast<float>(
                (fromOffsetUnit.x * sine +
                 fromOffsetUnit.y * cosine) * magnitude),
        };
    };

    std::vector<mapget::Point> path = incoming;
    std::vector<float> lateralOffsetsPx(
        incoming.size(),
        fromLateralOffsetPx);
    std::vector<glm::fvec2> lateralOffsetVectorsPx(
        incoming.size(),
        fromOffsetVectorPx);
    auto const p0 = incoming.back();
    auto const p3 = outgoing.front();
    auto appendCubic = [&](mapget::Point const& start,
                           mapget::Point const& control1,
                           mapget::Point const& control2,
                           mapget::Point const& end,
                           size_t samples,
                           double progressStart,
                           double progressEnd) {
        for (size_t sample = 1; sample <= samples; ++sample) {
            auto const t = static_cast<double>(sample) /
                static_cast<double>(samples);
            path.push_back(cubicPoint(
                start,
                control1,
                control2,
                end,
                t));
            auto const progress =
                progressStart + (progressEnd - progressStart) * t;
            // Smoothstep makes the screen-space displacement tangent to both
            // constant road-leg stacks. Rotate the road normal while
            // interpolating its radius: component-wise interpolation shrinks
            // a 20 px 90-degree turn to 14.1 px at its midpoint and collapses
            // an exact U-turn through zero, visually erasing the lane stack.
            auto const eased =
                progress * progress * (3.0 - 2.0 * progress);
            lateralOffsetsPx.push_back(static_cast<float>(
                static_cast<double>(fromLateralOffsetPx) +
                (static_cast<double>(toLateralOffsetPx) -
                 fromLateralOffsetPx) * eased));
            lateralOffsetVectorsPx.push_back(
                interpolateOffsetVector(eased));
        }
    };
    if (pixelOffsets) {
        // Screen-space transition vectors already provide the visible bend
        // between the two leg stacks. Keep the underlying world bridge a
        // compact, non-overshooting Hermite curve. This is especially
        // important for U-turns: a world-space side loop plus a fixed-pixel
        // side change can cancel and form a second loop at one zoom level.
        auto const chordLength = planarDistance(p0, p3);
        auto const handle = std::min(
            maximumTrim * 0.5,
            chordLength * 0.5);
        auto const p1 = mapget::Point{
            p0.x + (*curveIncomingDirection)[0] * handle,
            p0.y + (*curveIncomingDirection)[1] * handle,
            p0.z + (p3.z - p0.z) / 3.0,
        };
        auto const p2 = mapget::Point{
            p3.x - (*curveOutgoingDirection)[0] * handle,
            p3.y - (*curveOutgoingDirection)[1] * handle,
            p3.z - (p3.z - p0.z) / 3.0,
        };
        appendCubic(
            p0,
            p1,
            p2,
            p3,
            bridgeSamples,
            0.0,
            1.0);
    }
    else if (uTurn) {
        // A U-turn needs a genuine curve: a single cubic with collinear,
        // opposite endpoint tangents collapses and gives PathLayer an
        // undefined 180-degree join. Keep this hairpin deliberately compact;
        // its lane separation remains the style's zoom-independent pixels.
        auto forwardX =
            (*curveIncomingDirection)[0] - (*curveOutgoingDirection)[0];
        auto forwardY =
            (*curveIncomingDirection)[1] - (*curveOutgoingDirection)[1];
        auto const forwardLength = std::hypot(forwardX, forwardY);
        if (forwardLength <= 1.0e-9) {
            return false;
        }
        forwardX /= forwardLength;
        forwardY /= forwardLength;
        // (dy, -dx) is right of forward; pathSide selects right/left.
        auto const sideX = forwardY * static_cast<double>(pathSide);
        auto const sideY = -forwardX * static_cast<double>(pathSide);
        auto const center = mapget::Point{
            (p0.x + p3.x) * 0.5,
            (p0.y + p3.y) * 0.5,
            (p0.z + p3.z) * 0.5,
        };
        auto const forwardReach = maximumTrim;
        auto const sideReach = maximumTrim * 0.45;
        auto const apex = mapget::Point{
            center.x + forwardX * forwardReach + sideX * sideReach,
            center.y + forwardY * forwardReach + sideY * sideReach,
            center.z,
        };
        auto const handle = maximumTrim * 0.55;
        auto const startControl = mapget::Point{
            p0.x + (*curveIncomingDirection)[0] * handle,
            p0.y + (*curveIncomingDirection)[1] * handle,
            p0.z + (apex.z - p0.z) * 0.5,
        };
        auto const apexControlDistance = sideReach * 0.5;
        auto const incomingApexControl = mapget::Point{
            apex.x - sideX * apexControlDistance,
            apex.y - sideY * apexControlDistance,
            apex.z,
        };
        auto const outgoingApexControl = mapget::Point{
            apex.x + sideX * apexControlDistance,
            apex.y + sideY * apexControlDistance,
            apex.z,
        };
        auto const endControl = mapget::Point{
            p3.x - (*curveOutgoingDirection)[0] * handle,
            p3.y - (*curveOutgoingDirection)[1] * handle,
            p3.z - (p3.z - apex.z) * 0.5,
        };
        auto const halfSamples = std::max<size_t>(
            2,
            (bridgeSamples + 1) / 2);
        appendCubic(
            p0,
            startControl,
            incomingApexControl,
            apex,
            halfSamples,
            0.0,
            0.5);
        appendCubic(
            apex,
            outgoingApexControl,
            endControl,
            p3,
            halfSamples,
            0.5,
            1.0);
    }
    else {
        auto const handle = maximumTrim * 0.75;
        auto const p1 = mapget::Point{
            p0.x + (*curveIncomingDirection)[0] * handle,
            p0.y + (*curveIncomingDirection)[1] * handle,
            p0.z + (p3.z - p0.z) / 3.0,
        };
        auto const p2 = mapget::Point{
            p3.x - (*curveOutgoingDirection)[0] * handle,
            p3.y - (*curveOutgoingDirection)[1] * handle,
            p3.z - (p3.z - p0.z) / 3.0,
        };
        appendCubic(
            p0,
            p1,
            p2,
            p3,
            bridgeSamples,
            0.0,
            1.0);
    }
    path.insert(path.end(), outgoing.begin() + 1, outgoing.end());
    lateralOffsetsPx.insert(
        lateralOffsetsPx.end(),
        outgoing.size() - 1,
        toLateralOffsetPx);
    lateralOffsetVectorsPx.insert(
        lateralOffsetVectorsPx.end(),
        outgoing.size() - 1,
        toOffsetVectorPx);

    auto lateralOffsetScaleThreshold = 0.0f;
    TransitionOffsetScaleGroup* scaleGroup = nullptr;
    if (pixelOffsets && maximumLateralOffsetPx > 1.0e-6f) {
        // Every maneuver rendered for one host/rule contracts by the same
        // factor, otherwise stack spacing changes relative to its neighbors.
        // Ordinary turns contribute a bound measured from their exact sampled
        // centerline and vector motion. A semantic U-turn's correctly wound
        // vector arc advances with both legs and cannot fold; it inherits the
        // group's bound without imposing its former, overly aggressive 0.9 m
        // trim-radius estimate.
        auto const scaleGroupKey =
            stackPrefix + ":" + entry->featureId()->toString() + ":turn";
        scaleGroup = &transitionOffsetScaleGroups_[scaleGroupKey];
        auto const pathScaleThreshold = uTurn
            ? 0.0
            : transitionOffsetScaleThreshold(
                path,
                lateralOffsetVectorsPx);
        if (pathScaleThreshold > 0.0) {
            scaleGroup->scaleThresholdMetersPerPixel =
                scaleGroup->scaleThresholdMetersPerPixel > 0.0
                ? std::min(
                    scaleGroup->scaleThresholdMetersPerPixel,
                    pathScaleThreshold)
                : pathScaleThreshold;
        }
        lateralOffsetScaleThreshold = static_cast<float>(
            scaleGroup->scaleThresholdMetersPerPixel);
        for (auto const& handle : scaleGroup->gpuHandles) {
            gpuPacketBuilder_.updateAdaptiveOffsetThreshold(
                handle,
                lateralOffsetScaleThreshold);
        }
    }

    auto const gpuHandle = appendPath(
        path,
        rule,
        *color,
        zIndex,
        pick,
        width,
        arrow,
        lateralOffsetsPx,
        lateralOffsetVectorsPx,
        lateralOffsetScaleThreshold);
    if (scaleGroup) {
        scaleGroup->gpuHandles.push_back(gpuHandle);
    }
    attributeOffsetSlotsByTransitionLeg_[fromKey] = fromSlot + 1U;
    if (toKey != fromKey) {
        attributeOffsetSlotsByTransitionLeg_[toKey] = toSlot + 1U;
    }
    if (rule.hasLabel()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
            appendLabel(
                path[path.size() / 2],
                text,
                rule,
                zIndex,
                pick);
        }
    }
    return true;
}

bool TileSubsetLayerRenderer::renderSegmentStackedLine(
    mapget::model_ptr<mapget::Geometry> const& geometry,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    uint32_t pick,
    std::string const& stackPrefix)
{
    if (!geometry ||
        geometry->geomType() != mapget::GeomType::Line ||
        !rule.supports(mapget::GeomType::Line, geometryName(geometry)))
    {
        return false;
    }
    auto const source = geometry->toSelfContained();
    if (source.points_.size() < 2) {
        return false;
    }
    auto color = rule.color(evalFun);
    auto const width = rule.width(evalFun);
    if (!color || width <= 0.0f) {
        return false;
    }
    auto const arrow = rule.arrow(evalFun);
    auto const zIndex = resolvedZIndex(rule, evalFun);

    auto pointKey = [](mapget::Point const& point) {
        return std::array<int64_t, 3>{
            static_cast<int64_t>(std::llround(point.x * 1.0e9)),
            static_cast<int64_t>(std::llround(point.y * 1.0e9)),
            static_cast<int64_t>(std::llround(point.z * 1.0e3)),
        };
    };
    auto segmentKey = [&](mapget::Point const& first,
                          mapget::Point const& second) {
        auto left = pointKey(first);
        auto right = pointKey(second);
        if (right < left) {
            std::swap(left, right);
        }
        std::ostringstream stream;
        stream << stackPrefix;
        for (auto const value : left) {
            stream << ':' << value;
        }
        for (auto const value : right) {
            stream << ':' << value;
        }
        return stream.str();
    };

    std::unordered_set<std::string> occupiedSegments;
    for (size_t index = 1; index < source.points_.size(); ++index) {
        auto const& first = source.points_[index - 1];
        auto const& second = source.points_[index];
        if (first.distanceTo(second) <= 1.0e-9) {
            continue;
        }
        occupiedSegments.insert(segmentKey(first, second));
    }
    if (occupiedSegments.empty()) {
        return false;
    }
    uint32_t slot = 0;
    for (auto const& key : occupiedSegments) {
        slot = std::max(slot, attributeOffsetSlotsBySegment_[key]);
    }
    auto presentationOffset = rule.offset() +
        rule.offsetIncrement() * static_cast<double>(slot);
    auto lateralOffsetPx = 0.0f;
    if (rule.lateralOffsetUnit() ==
        FeatureStyleRule::LateralOffsetUnit::Pixel)
    {
        lateralOffsetPx = static_cast<float>(presentationOffset.x);
        presentationOffset.x = 0.0;
    }
    auto transformed = applyPresentationTransform(
        source,
        rule,
        presentationOffset);
    std::vector<mapget::Point> projected;
    projected.reserve(transformed.points_.size());
    for (auto const& point : transformed.points_) {
        auto const projectedPoint = projectWgsPoint(point);
        if (projected.empty() ||
            projected.back().distanceTo(projectedPoint) > 1.0e-6)
        {
            projected.push_back(projectedPoint);
        }
    }
    if (projected.size() < 2) {
        return false;
    }
    std::vector<float> lateralOffsetsPx(
        projected.size(), lateralOffsetPx);
    appendPath(
        projected,
        rule,
        *color,
        zIndex,
        pick,
        width,
        arrow,
        lateralOffsetsPx);
    for (auto const& key : occupiedSegments) {
        attributeOffsetSlotsBySegment_[key] = slot + 1U;
    }
    if (rule.hasLabel()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
            appendLabel(
                projectWgsPoint(geometryCenter(source)),
                text,
                rule,
                zIndex,
                pick);
        }
    }
    return true;
}

void TileSubsetLayerRenderer::renderRelationLine(
    mapget::model_ptr<mapget::GeometryCollection> const& sourceGeometry,
    mapget::model_ptr<mapget::GeometryCollection> const& targetGeometry,
    mapget::model_ptr<mapget::GeometryCollection> const& sourceFeatureGeometry,
    mapget::model_ptr<mapget::GeometryCollection> const& targetFeatureGeometry,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    uint32_t pick)
{
    std::optional<mapget::Point> sourceCenter;
    std::optional<mapget::Point> targetCenter;

    if (rule.relationLineGeometry() ==
        FeatureStyleRule::RelationLineGeometry::NearestEndpoints)
    {
        struct EndpointCandidate {
            mapget::Point wgs;
            mapget::Point local;
            bool lineEndpoint = false;
        };
        auto candidates = [&](mapget::model_ptr<mapget::GeometryCollection> const& collection) {
            std::vector<EndpointCandidate> result;
            if (!collection) {
                return result;
            }
            collection->forEachGeometry(
                [&](mapget::model_ptr<mapget::Geometry> const& geometry) {
                    if (!geometry) {
                        return true;
                    }
                    auto const value = geometry->toSelfContained();
                    if (value.points_.empty()) {
                        return true;
                    }
                    auto append = [&](mapget::Point const& point, bool lineEndpoint) {
                        result.push_back({
                            .wgs = point,
                            .local = projectWgsPoint(point),
                            .lineEndpoint = lineEndpoint,
                        });
                    };
                    if (geometry->geomType() == mapget::GeomType::Line) {
                        append(value.points_.front(), true);
                        if (value.points_.size() > 1U) {
                            append(value.points_.back(), true);
                        }
                    }
                    else if (geometry->geomType() == mapget::GeomType::Points) {
                        for (auto const& point : value.points_) {
                            append(point, false);
                        }
                    }
                    else {
                        append(geometryCenter(value), false);
                    }
                    return true;
                });
            return result;
        };
        auto candidatesWithFallback = [&](auto const& effective, auto const& feature) {
            auto result = candidates(effective);
            return result.empty() ? candidates(feature) : result;
        };
        auto const sourceCandidates = candidatesWithFallback(
            sourceGeometry,
            sourceFeatureGeometry);
        auto const targetCandidates = candidatesWithFallback(
            targetGeometry,
            targetFeatureGeometry);
        std::optional<std::pair<EndpointCandidate, EndpointCandidate>> nearest;
        auto nearestDistanceSquared = std::numeric_limits<double>::infinity();
        for (auto const& source : sourceCandidates) {
            for (auto const& target : targetCandidates) {
                auto const dx = target.local.x - source.local.x;
                auto const dy = target.local.y - source.local.y;
                auto const distanceSquared = dx * dx + dy * dy;
                if (distanceSquared < nearestDistanceSquared) {
                    nearestDistanceSquared = distanceSquared;
                    nearest = {source, target};
                }
            }
        }
        if (nearest) {
            auto source = nearest->first;
            auto target = nearest->second;
            if (source.lineEndpoint && target.lineEndpoint) {
                auto const distance = std::sqrt(nearestDistanceSquared);
                if (distance > 1.0e-6) {
                    // A short gap keeps ordinary lane endpoints legible. Point
                    // endpoints represent zero-length lanes and remain exact.
                    auto const trim = std::min(1.5, distance * 0.25);
                    auto const dx = (target.local.x - source.local.x) / distance;
                    auto const dy = (target.local.y - source.local.y) / distance;
                    source.local.x += dx * trim;
                    source.local.y += dy * trim;
                    target.local.x -= dx * trim;
                    target.local.y -= dy * trim;
                    source.wgs = unprojectLocalPoint(source.local);
                    target.wgs = unprojectLocalPoint(target.local);
                }
            }
            sourceCenter = source.wgs;
            targetCenter = target.wgs;
        }

        // Some relation carriers, notably NDS.Classic LaneConnector features,
        // intentionally have no geometry. Their endpoint validity still gives
        // the exact lane endpoint; draw a short stub into the target feature so
        // the relation remains visible without inventing a carrier position.
        auto inwardPoint = [&](mapget::model_ptr<mapget::GeometryCollection> const& collection,
                               mapget::Point const& anchor) -> std::optional<mapget::Point> {
            constexpr auto stubLengthMeters = 8.0;
            auto const anchorLocal = projectWgsPoint(anchor);
            auto nearestDistanceSquared = std::numeric_limits<double>::infinity();
            std::optional<mapget::Point> result;
            if (!collection) {
                return result;
            }
            collection->forEachGeometry(
                [&](mapget::model_ptr<mapget::Geometry> const& geometry) {
                    if (!geometry || geometry->geomType() != mapget::GeomType::Line) {
                        return true;
                    }
                    auto const value = geometry->toSelfContained();
                    if (value.points_.size() < 2U) {
                        return true;
                    }
                    for (auto const fromFront : {true, false}) {
                        auto const& endpoint = fromFront
                            ? value.points_.front()
                            : value.points_.back();
                        auto const endpointLocal = projectWgsPoint(endpoint);
                        auto const dx = endpointLocal.x - anchorLocal.x;
                        auto const dy = endpointLocal.y - anchorLocal.y;
                        auto const distanceSquared = dx * dx + dy * dy;
                        if (distanceSquared >= nearestDistanceSquared) {
                            continue;
                        }
                        auto remaining = stubLengthMeters;
                        auto current = endpointLocal;
                        auto interior = current;
                        for (size_t step = 1U; step < value.points_.size(); ++step) {
                            auto const index = fromFront
                                ? step
                                : value.points_.size() - 1U - step;
                            auto const next = projectWgsPoint(value.points_[index]);
                            auto const segmentX = next.x - current.x;
                            auto const segmentY = next.y - current.y;
                            auto const segmentZ = next.z - current.z;
                            auto const length = std::sqrt(
                                segmentX * segmentX +
                                segmentY * segmentY +
                                segmentZ * segmentZ);
                            if (length > 1.0e-9) {
                                auto const fraction = std::min(1.0, remaining / length);
                                interior = {
                                    current.x + segmentX * fraction,
                                    current.y + segmentY * fraction,
                                    current.z + segmentZ * fraction,
                                };
                                remaining -= length;
                                if (remaining <= 0.0) {
                                    break;
                                }
                            }
                            current = next;
                        }
                        if (interior.distanceTo(endpointLocal) > 1.0e-6) {
                            nearestDistanceSquared = distanceSquared;
                            result = unprojectLocalPoint(interior);
                        }
                    }
                    return true;
                });
            return result;
        };
        if (!sourceCenter && !targetCandidates.empty()) {
            auto const endpoint = targetCandidates.front().wgs;
            if (auto const interior = inwardPoint(targetFeatureGeometry, endpoint)) {
                sourceCenter = endpoint;
                targetCenter = *interior;
            }
        }
        else if (!targetCenter && !sourceCandidates.empty()) {
            auto const endpoint = sourceCandidates.front().wgs;
            if (auto const interior = inwardPoint(sourceFeatureGeometry, endpoint)) {
                sourceCenter = *interior;
                targetCenter = endpoint;
            }
        }
    }
    else {
        sourceCenter = collectionCenter(sourceGeometry);
        targetCenter = collectionCenter(targetGeometry);
    }
    if (!sourceCenter || !targetCenter) {
        return;
    }
    auto const liftedSource = mapget::Point{
        sourceCenter->x,
        sourceCenter->y,
        sourceCenter->z + rule.relationLineHeightOffset(),
    };
    auto const liftedTarget = mapget::Point{
        targetCenter->x,
        targetCenter->y,
        targetCenter->z + rule.relationLineHeightOffset(),
    };
    auto color = rule.color(evalFun);
    auto const width = rule.width(evalFun);
    auto const arrow = rule.arrow(evalFun);
    if (color && width > 0.0f && rule.supports(mapget::GeomType::Line))
    {
        auto line = applyPresentationTransform(
            mapget::SelfContainedGeometry{
                {liftedSource, liftedTarget},
                {},
                mapget::GeomType::Line,
            },
            rule,
            rule.offset());
        std::vector<mapget::Point> projected;
        for (auto const& point : line.points_) {
            projected.push_back(projectWgsPoint(point));
        }
        appendPath(
            projected,
            rule,
            *color,
            resolvedZIndex(rule, evalFun),
            pick,
            width,
            arrow);
    }

    auto marker = rule.relationLineEndMarkerStyle();
    if (!marker) {
        return;
    }
    FeatureStyleRule::MatchContext markerContext{
        .featureType = "",
    };
    marker->forEachMatchingRule(
        markerContext,
        evalFun,
        [&](FeatureStyleRule const& markerRule) {
            auto markerColor = markerRule.color(evalFun);
            auto const markerWidth = markerRule.width(evalFun);
            auto const markerArrow = markerRule.arrow(evalFun);
            if (!markerColor ||
                markerWidth <= 0.0F ||
                !markerRule.supports(mapget::GeomType::Line))
            {
                return;
            }
            for (auto const& endpoints : {
                     std::array<mapget::Point, 2>{
                         *sourceCenter,
                         liftedSource},
                     std::array<mapget::Point, 2>{
                         *targetCenter,
                         liftedTarget}})
            {
                auto line = applyPresentationTransform(
                    mapget::SelfContainedGeometry{
                        {endpoints[0], endpoints[1]},
                        {},
                        mapget::GeomType::Line,
                    },
                    markerRule,
                    markerRule.offset());
                std::vector<mapget::Point> projected;
                for (auto const& point : line.points_) {
                    projected.push_back(projectWgsPoint(point));
                }
                appendPath(
                    projected,
                    markerRule,
                    *markerColor,
                    resolvedZIndex(markerRule, evalFun),
                    pick,
                    markerWidth,
                    markerArrow);
            }
        });
}

uint32_t TileSubsetLayerRenderer::pickIndex(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    uint32_t endpointRole,
    bool selectable,
    std::function<PickResult()> const& resultFactory)
{
    if (!selectable) {
        return kUnselectable;
    }
    PickRef key{
        channelOrdinal,
        entryOrdinal,
        endpointRole,
    };
    if (auto found = pickIndices_.find(key);
        found != pickIndices_.end())
    {
        return found->second;
    }
    auto const index = static_cast<uint32_t>(pickRefs_.size());
    bridgePickResults_.emplace(index, resultFactory());
    pickRefs_.push_back(key);
    pickNavigationAltitudes_.push_back(
        std::numeric_limits<float>::quiet_NaN());
    pickIndices_.emplace(key, index);
    return index;
}

uint32_t TileSubsetLayerRenderer::featurePickIndex(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    bool selectable)
{
    if (!selectable) {
        return kUnselectable;
    }
    auto const index = static_cast<uint32_t>(pickRefs_.size());
    pickRefs_.push_back({channelOrdinal, entryOrdinal, 0U});
    pickNavigationAltitudes_.push_back(
        std::numeric_limits<float>::quiet_NaN());
    return index;
}

void TileSubsetLayerRenderer::recordPickNavigationAltitude(
    uint32_t pick,
    std::span<mapget::Point const> points)
{
    if (pick == kUnselectable || pick >= pickNavigationAltitudes_.size() ||
        points.empty() || std::isfinite(pickNavigationAltitudes_[pick]))
    {
        return;
    }
    auto const altitude = coordinateOriginWgs_.z +
        points[points.size() / 2U].z;
    if (std::isfinite(altitude)) {
        pickNavigationAltitudes_[pick] = static_cast<float>(altitude);
    }
}

TileSubsetLayerRenderer::PickResult
TileSubsetLayerRenderer::pickResult(
    mapget::model_ptr<mapget::AttributeValidityEntry> const& entry,
    std::string const& featureId)
{
    PickResult result;
    if (!entry) {
        return result;
    }
    result.featureId = featureId;
    result.attributeIndex = entry->attributeIndex();
    result.hasValidity = entry->hasValidity();
    result.validityIndex = entry->validityIndex();
    return result;
}

TileSubsetLayerRenderer::PickResult
TileSubsetLayerRenderer::pickResult(
    mapget::model_ptr<mapget::GroupEntry> const& entry,
    mapget::model_ptr<mapget::FeatureId> const& representativeFeatureId)
{
    PickResult result;
    if (!entry) {
        return result;
    }
    if (representativeFeatureId) {
        result.featureId = representativeFeatureId->toString();
    }
    auto members = entry->memberFeatureIds();
    // A singleton group is semantically identical to its representative.
    // Omitting the duplicate member avoids resolving and formatting the same
    // FeatureId twice for the overwhelmingly common point-grid case.
    if (!members || members->size() <= 1U) {
        return result;
    }
    result.memberFeatureIds.reserve(members->size());
    for (uint32_t index = 0; index < members->size(); ++index) {
        auto node = members->at(index);
        auto member = node
            ? entry->model().resolve<mapget::FeatureId>(*node)
            : mapget::model_ptr<mapget::FeatureId>{};
        if (member) {
            result.memberFeatureIds.push_back(
                member->toString());
        }
    }
    return result;
}

TileSubsetLayerRenderer::PickResult
TileSubsetLayerRenderer::pickResult(
    mapget::model_ptr<mapget::RelationEntry> const& entry,
    mapget::model_ptr<mapget::FeatureId> const& sourceFeatureId,
    mapget::model_ptr<mapget::FeatureId> const& targetFeatureId,
    uint32_t endpointRole)
{
    PickResult result;
    if (!entry) {
        return result;
    }
    auto const& endpointFeatureId = endpointRole == 2
        ? targetFeatureId
        : sourceFeatureId;
    if (endpointFeatureId) {
        result.featureId = endpointFeatureId->toString();
    }
    if (sourceFeatureId) {
        result.relationSourceFeatureId = sourceFeatureId->toString();
    }
    result.relationId = entry->relationId();
    if (!result.relationSourceFeatureId.empty()) {
        auto const marker =
            ":" + result.relationSourceFeatureId + "#";
        auto const markerPosition =
            result.relationId.find(marker);
        if (markerPosition != std::string::npos) {
            auto const begin =
                result.relationId.data() +
                markerPosition +
                marker.size();
            auto const end =
                result.relationId.data() +
                result.relationId.size();
            uint32_t ordinal = 0;
            auto const parsed =
                std::from_chars(begin, end, ordinal);
            if (parsed.ec == std::errc{} &&
                parsed.ptr != begin)
            {
                result.relationIndex = ordinal;
            }
        }
    }
    return result;
}

void TileSubsetLayerRenderer::recordRuntimeIssue(
    std::string const& property,
    std::string const& expression,
    std::string const& message,
    uint32_t ruleIndex)
{
    auto const key = property + '\n' + expression + '\n' + message +
        '\n' + std::to_string(ruleIndex);
    if (auto found = runtimeIssueIndices_.find(key);
        found != runtimeIssueIndices_.end())
    {
        ++runtimeIssues_[found->second].occurrenceCount;
        return;
    }
    runtimeIssueIndices_.emplace(key, runtimeIssues_.size());
    runtimeIssues_.push_back(RuntimeIssue{
        property,
        expression,
        message,
        ruleIndex,
        1,
    });
}

void TileSubsetLayerRenderer::appendPoint(
    mapget::Point const& point,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    glm::fvec4 const& color,
    double zIndex,
    uint32_t pick)
{
    recordPickNavigationAltitude(pick, std::span{&point, size_t{1U}});
    auto const radius = std::max(
        0.0f,
        rule.width(evalFun) * 0.5f);
    gpuPacketBuilder_.appendPoint(
        GpuPointRecordData{
            .position = point,
            .radius = radius,
            .style = gpuRecordStyle(rule, color, zIndex, pick),
        },
        rule.billboard().value_or(false),
        rule.depthTest());
    ++vertexCount_;
}

void TileSubsetLayerRenderer::appendIcon(
    mapget::Point const& point,
    std::string const& uri,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    glm::fvec4 const& color,
    double zIndex,
    uint32_t pick)
{
    if (uri.empty()) {
        return;
    }
    auto const resource = gpuIconResources_.find(uri);
    if (resource == gpuIconResources_.end()) {
        gpuPacketBuilder_.appendResourceRequest({
            .resourceKind = static_cast<uint32_t>(GpuResourceKind::Icon),
            .uri = uri,
        });
        return;
    }
    auto const scale = std::max(0.0F, rule.width(evalFun));
    if (scale <= 0.0F) {
        return;
    }
    recordPickNavigationAltitude(pick, std::span{&point, size_t{1U}});
    gpuPacketBuilder_.appendIcon(
        GpuIconRecordData{
            .position = point,
            .pixelSize = {
                resource->second.pixelSize[0] * scale,
                resource->second.pixelSize[1] * scale,
            },
            .pixelOffset = {0.0F, 0.0F},
            .uv = resource->second.uv,
            .atlasPage = resource->second.atlasPage,
            .flags = 0U,
            .style = gpuRecordStyle(rule, color, zIndex, pick),
        },
        rule.billboard().value_or(true),
        rule.depthTest());
    ++vertexCount_;
}

void TileSubsetLayerRenderer::appendSurface(
    std::vector<mapget::Point> const& points,
    std::vector<uint32_t> const& ringStarts,
    FeatureStyleRule const& rule,
    glm::fvec4 const& color,
    double zIndex,
    uint32_t pick)
{
    if (points.size() < 3) {
        return;
    }
    recordPickNavigationAltitude(pick, points);
    gpuPacketBuilder_.appendSurface(
        points,
        ringStarts,
        gpuRecordStyle(rule, color, zIndex, pick),
        rule.depthTest());
    vertexCount_ += static_cast<uint32_t>(points.size());
}

void TileSubsetLayerRenderer::appendMesh(
    std::vector<mapget::Point> const& points,
    FeatureStyleRule const& rule,
    glm::fvec4 const& color,
    double zIndex,
    uint32_t pick)
{
    for (size_t index = 0; index + 2 < points.size(); index += 3) {
        appendSurface(
            {points[index], points[index + 1], points[index + 2]},
            {},
            rule,
            color,
            zIndex,
            pick);
    }
}

GpuPathRecordHandle TileSubsetLayerRenderer::appendPath(
    std::vector<mapget::Point> const& points,
    FeatureStyleRule const& rule,
    glm::fvec4 const& color,
    double zIndex,
    uint32_t pick,
    float width,
    FeatureStyleRule::Arrow arrow,
    std::span<float const> lateralOffsetsPx,
    std::span<glm::fvec2 const> lateralOffsetVectorsPx,
    float lateralOffsetScaleThreshold,
    bool simplificationApplied,
    std::optional<GpuPathOverlay> pathOverlay)
{
    width = std::max(0.0F, width);
    if (points.size() < 2 || width <= 0.0f) {
        return {};
    }
    auto const hasOffsetVectors =
        lateralOffsetVectorsPx.size() >= points.size();
    auto const dashed = rule.isDashed();
    auto const dashLength =
        static_cast<float>(std::max(1, rule.dashLength()));
    auto renderedPoints = std::span<mapget::Point const>{points};
    if (!simplificationApplied &&
        lineSimplificationToleranceMeters_ > 0.0 &&
        lateralOffsetsPx.empty() &&
        lateralOffsetVectorsPx.empty() &&
        !dashed &&
        arrow == FeatureStyleRule::NoArrow)
    {
        renderedPoints = simplifyPath(points);
    }
    recordPickNavigationAltitude(pick, renderedPoints);
    auto const gpuHandle = gpuPacketBuilder_.appendPath(
        GpuPathRecordData{
            .points = renderedPoints,
            .lateralOffsetsPx = lateralOffsetsPx,
            .lateralOffsetVectorsPx = lateralOffsetVectorsPx,
            .width = width,
            .dashLength = dashed ? dashLength : 1.0F,
            .dashGap = dashed ? dashLength : 0.0F,
            .lateralOffsetScaleThreshold = hasOffsetVectors
                ? std::max(0.0F, lateralOffsetScaleThreshold)
                : 0.0F,
            .forwardArrow =
                arrow == FeatureStyleRule::ForwardArrow ||
                arrow == FeatureStyleRule::DoubleArrow,
            .backwardArrow =
                arrow == FeatureStyleRule::BackwardArrow ||
                arrow == FeatureStyleRule::DoubleArrow,
            .overlay = std::move(pathOverlay),
            .style = gpuRecordStyle(rule, color, zIndex, pick),
        },
        rule.billboard().value_or(false),
        rule.depthTest());
    vertexCount_ += static_cast<uint32_t>(renderedPoints.size());
    if (arrow == FeatureStyleRule::ForwardArrow ||
        arrow == FeatureStyleRule::BackwardArrow) {
        vertexCount_ += 3U;
    }
    else if (arrow == FeatureStyleRule::DoubleArrow) {
        vertexCount_ += 6U;
    }
    return gpuHandle;
}

void TileSubsetLayerRenderer::projectPathPoints(
    std::span<mapget::Point const> points,
    bool simplify,
    std::vector<mapget::Point>& projected)
{
    auto retained = points;
    if (simplify && points.size() > 2U) {
        retained = simplifyPath(points, true);
    }
    projected.clear();
    projected.reserve(retained.size());
    for (auto const& point : retained) {
        projected.push_back(projectWgsPoint(point));
    }
}

std::span<mapget::Point const> TileSubsetLayerRenderer::simplifyPath(
    std::span<mapget::Point const> points,
    bool wgs84Coordinates)
{
    if (points.size() <= 2U) {
        return points;
    }
    auto const toleranceSquared =
        lineSimplificationToleranceMeters_ *
        lineSimplificationToleranceMeters_;
    pathSimplificationKeepScratch_.assign(points.size(), uint8_t{0U});
    pathSimplificationKeepScratch_.front() = 1U;
    pathSimplificationKeepScratch_.back() = 1U;
    pathSimplificationRangeScratch_.clear();
    pathSimplificationRangeScratch_.push_back(0U);
    pathSimplificationRangeScratch_.push_back(
        static_cast<uint32_t>(points.size() - 1U));

    auto asVector = [&](mapget::Point const& point) {
        if (!wgs84Coordinates) {
            return glm::dvec3{point.x, point.y, point.z};
        }
        auto longitudeDelta = point.x - coordinateOriginWgs_.x;
        if (longitudeDelta > 180.0) {
            longitudeDelta -= 360.0;
        }
        else if (longitudeDelta < -180.0) {
            longitudeDelta += 360.0;
        }
        return glm::dvec3{
            glm::radians(longitudeDelta) *
                kFallbackEarthRadiusMeters * coordinateOriginCosine_,
            glm::radians(point.y - coordinateOriginWgs_.y) *
                kFallbackEarthRadiusMeters,
            point.z - coordinateOriginWgs_.z,
        };
    };
    while (!pathSimplificationRangeScratch_.empty()) {
        auto const end = pathSimplificationRangeScratch_.back();
        pathSimplificationRangeScratch_.pop_back();
        auto const begin = pathSimplificationRangeScratch_.back();
        pathSimplificationRangeScratch_.pop_back();
        if (end <= begin + 1U) {
            continue;
        }
        auto const startPoint = asVector(points[begin]);
        auto const endPoint = asVector(points[end]);
        auto const segment = endPoint - startPoint;
        auto const segmentLengthSquared = glm::dot(segment, segment);
        auto maximumDistanceSquared = 0.0;
        auto maximumIndex = begin;
        for (auto index = begin + 1U; index < end; ++index) {
            auto const point = asVector(points[index]);
            auto const amount = segmentLengthSquared > 0.0
                ? glm::clamp(
                    glm::dot(point - startPoint, segment) /
                        segmentLengthSquared,
                    0.0,
                    1.0)
                : 0.0;
            auto const delta = point - (startPoint + amount * segment);
            auto const distanceSquared = glm::dot(delta, delta);
            if (distanceSquared > maximumDistanceSquared) {
                maximumDistanceSquared = distanceSquared;
                maximumIndex = index;
            }
        }
        if (maximumDistanceSquared <= toleranceSquared) {
            continue;
        }
        pathSimplificationKeepScratch_[maximumIndex] = 1U;
        pathSimplificationRangeScratch_.push_back(begin);
        pathSimplificationRangeScratch_.push_back(maximumIndex);
        pathSimplificationRangeScratch_.push_back(maximumIndex);
        pathSimplificationRangeScratch_.push_back(end);
    }

    simplifiedPathScratch_.clear();
    simplifiedPathScratch_.reserve(points.size());
    for (size_t index = 0U; index < points.size(); ++index) {
        if (pathSimplificationKeepScratch_[index] != 0U) {
            simplifiedPathScratch_.push_back(points[index]);
        }
    }
    return simplifiedPathScratch_;
}

void TileSubsetLayerRenderer::appendAabb(
    mapget::Point const& origin,
    mapget::Point const& size,
    FeatureStyleRule const& rule,
    glm::fvec4 const& color,
    double zIndex,
    uint32_t pick)
{
    auto const x0 = origin.x;
    auto const y0 = origin.y;
    auto const z0 = origin.z;
    auto const x1 = origin.x + size.x;
    auto const y1 = origin.y + size.y;
    auto const z1 = origin.z + size.z;
    std::array<mapget::Point, 8> const wgs{{
        {x0, y0, z0},
        {x1, y0, z0},
        {x0, y1, z0},
        {x1, y1, z0},
        {x0, y0, z1},
        {x1, y0, z1},
        {x0, y1, z1},
        {x1, y1, z1},
    }};
    std::array<mapget::Point, 8> projected{};
    std::transform(
        wgs.begin(),
        wgs.end(),
        projected.begin(),
        [&](mapget::Point const& point) {
            return projectWgsPoint(point);
        });
    static constexpr std::array<std::array<size_t, 3>, 12> triangles{{
        {0, 1, 3}, {0, 3, 2},
        {4, 6, 7}, {4, 7, 5},
        {0, 4, 5}, {0, 5, 1},
        {2, 3, 7}, {2, 7, 6},
        {0, 2, 6}, {0, 6, 4},
        {1, 5, 7}, {1, 7, 3},
    }};
    for (auto const& triangle : triangles) {
        appendSurface(
            {
                projected[triangle[0]],
                projected[triangle[1]],
                projected[triangle[2]],
            },
            {},
            rule,
            color,
            zIndex,
            pick);
    }
}

void TileSubsetLayerRenderer::appendGltf(
    mapget::model_ptr<mapget::Geometry> const& geometry,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    uint32_t pick)
{
    std::optional<glm::fvec4> tint;
    if (rule.hasExplicitColor()) {
        tint = rule.color(evalFun);
    }
    else if (rule.hasExplicitOpacity()) {
        auto base = rule.color(evalFun);
        if (base) {
            tint = glm::fvec4{
                1.0f,
                1.0f,
                1.0f,
                std::clamp(base->a, 0.0f, 1.0f),
            };
        }
    }
    else {
        tint = glm::fvec4{1.0f, 1.0f, 1.0f, 1.0f};
    }
    if (!tint) {
        return;
    }

    auto& buffers = bridgeBuffers_.gltfNodes;
    buffers.nodeIndices.push_back(geometry->gltfNodeIndex());
    buffers.colors.insert(
        buffers.colors.end(),
        {
            toColorByte(tint->r),
            toColorByte(tint->g),
            toColorByte(tint->b),
            toColorByte(tint->a),
        });
    buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
    buffers.featureAddresses.push_back(pick);

    if (pick == kUnselectable) {
        return;
    }
    auto const origin = geometry->gltfNodeAabbOrigin();
    auto const size = geometry->gltfNodeAabbSize();
    std::array<mapget::Point, 8> projected{{
        projectWgsPoint(origin),
        projectWgsPoint({origin.x + size.x, origin.y, origin.z}),
        projectWgsPoint({origin.x, origin.y + size.y, origin.z}),
        projectWgsPoint({origin.x + size.x, origin.y + size.y, origin.z}),
        projectWgsPoint({origin.x, origin.y, origin.z + size.z}),
        projectWgsPoint({origin.x + size.x, origin.y, origin.z + size.z}),
        projectWgsPoint({origin.x, origin.y + size.y, origin.z + size.z}),
        projectWgsPoint({origin.x + size.x, origin.y + size.y, origin.z + size.z}),
    }};
    static constexpr std::array<std::array<size_t, 3>, 12> triangles{{
        {0, 1, 3}, {0, 3, 2},
        {4, 6, 7}, {4, 7, 5},
        {0, 4, 5}, {0, 5, 1},
        {2, 3, 7}, {2, 7, 6},
        {0, 2, 6}, {0, 6, 4},
        {1, 5, 7}, {1, 7, 3},
    }};
    auto& proxies = bridgeBuffers_.gltfPickProxies;
    for (auto const& triangle : triangles) {
        for (auto const index : triangle) {
            auto const& point = projected[index];
            proxies.positions.insert(
                proxies.positions.end(),
                {
                    static_cast<float>(point.x),
                    static_cast<float>(point.y),
                    static_cast<float>(point.z),
                });
        }
    }
    proxies.startIndices.push_back(
        static_cast<uint32_t>(proxies.positions.size() / 3));
    proxies.nodeIndices.push_back(geometry->gltfNodeIndex());
    proxies.featureAddresses.push_back(pick);
    vertexCount_ += 36;
}

void TileSubsetLayerRenderer::appendLabel(
    mapget::Point const& point,
    std::string const& text,
    FeatureStyleRule const& rule,
    double zIndex,
    uint32_t pick)
{
    if (relationEndpointLabelIdentity_) {
        auto const key = *relationEndpointLabelIdentity_ + "\n" + text;
        if (!renderedRelationEndpointLabels_.insert(key).second) {
            return;
        }
    }
    auto const absolutePosition = unprojectLocalPoint(point);
    auto const font = parseLabelFont(rule.labelFont());
    auto labelFlags = static_cast<uint32_t>(GpuLabelFlag::None);
    if (rule.billboard().value_or(true)) {
        labelFlags |= static_cast<uint32_t>(GpuLabelFlag::Billboard);
    }
    if (rule.depthTest()) {
        labelFlags |= static_cast<uint32_t>(GpuLabelFlag::DepthTest);
    }
    if (rule.showBackground()) {
        labelFlags |= static_cast<uint32_t>(GpuLabelFlag::Background);
    }
    if (rule.labelCollision()) {
        labelFlags |= static_cast<uint32_t>(GpuLabelFlag::Collision);
    }
    auto const pixelOffset = rule.labelPixelOffset().value_or(
        std::pair<float, float>{0.0F, 0.0F});
    auto const backgroundPadding = rule.labelBackgroundPadding();
    auto colorBytes = [&](glm::fvec4 const& value) {
        return std::array<uint8_t, 4>{
            toColorByte(value.r),
            toColorByte(value.g),
            toColorByte(value.b),
            toColorByte(value.a * rule.labelOpacity()),
        };
    };
    gpuPacketBuilder_.appendLabel({
        .localPickIndex = gpuPickIndex(pick),
        .positionWgs84 = {
            absolutePosition.x,
            absolutePosition.y,
            absolutePosition.z,
        },
        .text = text,
        .fontFamily = font.family,
        .size = font.size * rule.labelScale(),
        .pixelOffset = {pixelOffset.first, pixelOffset.second},
        .angle = 0.0F,
        .zIndex = std::isfinite(zIndex) ? zIndex : 0.0,
        .color = colorBytes(rule.labelColor()),
        .outlineColor = colorBytes(rule.labelOutlineColor()),
        .backgroundColor = colorBytes(rule.labelBackgroundColor()),
        .outlineWidth = rule.labelOutlineWidth(),
        .backgroundPadding = {
            static_cast<float>(backgroundPadding.first),
            static_cast<float>(backgroundPadding.second),
        },
        .flags = labelFlags,
        .horizontalOrigin = labelOriginCode(rule.labelHorizontalOrigin()),
        .verticalOrigin = labelOriginCode(rule.labelVerticalOrigin()),
        .renderOrder = rule.renderIndex(),
        .fontWeight = font.weight,
        .collisionPriority = rule.labelCollisionPriority(),
    });
    ++vertexCount_;
}

mapget::Point TileSubsetLayerRenderer::projectWgsPoint(
    mapget::Point const& wgsPoint) const
{
    if (!hasCoordinateOriginWgs_) {
        const_cast<TileSubsetLayerRenderer*>(this)->setCoordinateOrigin(
            wgsPoint.x,
            wgsPoint.y,
            0.0);
    }
    if (!coordinateScalesValid_) {
        auto const lat0 = glm::radians(coordinateOriginWgs_.y);
        return {
            glm::radians(wgsPoint.x - coordinateOriginWgs_.x) *
                glm::cos(lat0) * kFallbackEarthRadiusMeters,
            glm::radians(wgsPoint.y - coordinateOriginWgs_.y) *
                kFallbackEarthRadiusMeters,
            wgsPoint.z - coordinateOriginWgs_.z,
        };
    }
    auto deltaX = mercatorWorldX(wgsPoint.x) - coordinateOriginWorldX_;
    deltaX -= glm::round(deltaX / kMercatorTileSize) * kMercatorTileSize;
    auto const latitudeDelta =
        (wgsPoint.y - coordinateOriginWgs_.y) * kDegToRad;
    double localY = 0.0;
    if (std::abs(latitudeDelta) <=
        kMercatorTaylorMaximumLatitudeDeltaRadians)
    {
        auto const latitudeDelta2 = latitudeDelta * latitudeDelta;
        auto const tangent2 =
            coordinateOriginTangent_ * coordinateOriginTangent_;
        auto const metersPerRadian =
            kEarthCircumferenceMeters / (2.0 * kPi);
        localY = metersPerRadian * (
            latitudeDelta +
            0.5 * coordinateOriginTangent_ * latitudeDelta2 +
            ((1.0 + 2.0 * tangent2) / 6.0) *
                latitudeDelta2 * latitudeDelta);
    }
    else {
        localY = (mercatorWorldY(wgsPoint.y) - coordinateOriginWorldY_) /
            coordinateUnitsPerMeter_;
    }
    return {
        deltaX / coordinateUnitsPerMeter_,
        localY,
        wgsPoint.z - coordinateOriginWgs_.z,
    };
}

mapget::Point TileSubsetLayerRenderer::unprojectLocalPoint(
    mapget::Point const& localPoint) const
{
    if (!coordinateScalesValid_) {
        auto const latitude0 = glm::radians(coordinateOriginWgs_.y);
        return {
            coordinateOriginWgs_.x + glm::degrees(
                localPoint.x /
                (glm::cos(latitude0) * kFallbackEarthRadiusMeters)),
            coordinateOriginWgs_.y + glm::degrees(
                localPoint.y / kFallbackEarthRadiusMeters),
            coordinateOriginWgs_.z + localPoint.z,
        };
    }
    auto const worldY = coordinateOriginWorldY_ +
        localPoint.y * coordinateUnitsPerMeter_;
    auto const mercatorTerm =
        worldY * (2.0 * kPi / kMercatorTileSize) - kPi;
    auto const latitudeRadians =
        2.0 * glm::atan(glm::exp(mercatorTerm)) - kPi * 0.5;
    auto const worldX = coordinateOriginWorldX_ +
        localPoint.x * coordinateUnitsPerMeter_;
    auto const longitudeRadians =
        worldX * (2.0 * kPi / kMercatorTileSize) - kPi;
    auto longitudeDegrees = glm::degrees(longitudeRadians);
    longitudeDegrees = std::fmod(longitudeDegrees + 180.0, 360.0);
    if (longitudeDegrees < 0.0) {
        longitudeDegrees += 360.0;
    }
    longitudeDegrees -= 180.0;
    return {
        longitudeDegrees,
        glm::degrees(latitudeRadians),
        coordinateOriginWgs_.z + localPoint.z,
    };
}

uint32_t TileSubsetLayerRenderer::gpuPickIndex(
    uint32_t legacyPickIndex) const
{
    return legacyPickIndex == kUnselectable
        ? kGpuUnselectable
        : legacyPickIndex;
}

GpuRecordStyle TileSubsetLayerRenderer::gpuRecordStyle(
    FeatureStyleRule const& rule,
    glm::fvec4 const& color,
    double zIndex,
    uint32_t legacyPickIndex) const
{
    GpuRecordStyle result{
        .color = {
            toColorByte(color.r),
            toColorByte(color.g),
            toColorByte(color.b),
            toColorByte(color.a),
        },
        .zIndex = zIndex,
        .depthTieKey = depthTieKey(
            currentDepthIdentity_,
            rule.renderIndex()),
        .localPickIndex = gpuPickIndex(legacyPickIndex),
        .renderOrder = rule.renderIndex(),
    };
    if (auto const& glow = rule.glow();
        glow && glow->radius > 0.0F && glow->opacity > 0.0F)
    {
        result.glowColor = {
            toColorByte(glow->color.r),
            toColorByte(glow->color.g),
            toColorByte(glow->color.b),
            toColorByte(glow->color.a * glow->opacity),
        };
        result.glowRadius = glow->radius;
    }
    return result;
}

uint64_t TileSubsetLayerRenderer::featureDepthIdentity(
    mapget::model_ptr<mapget::FeatureId> const& featureId) const
{
    if (!featureId) {
        return subsetMapDepthSeed_;
    }
    auto identity = mapget::Hash{};
    if (auto const externalMapId = featureId->externalMapId()) {
        identity.mix(*externalMapId);
    }
    else {
        identity.hash_ = subsetMapDepthSeed_;
    }
    return identity
        .mix(featureId->typeId())
        .mix(featureId->keyValuePairs())
        .value();
}

uint32_t TileSubsetLayerRenderer::depthTieKey(
    uint64_t semanticIdentity,
    uint32_t ruleRenderIndex) const
{
    auto const hash = mapget::Hash{}
        .mix(semanticIdentity)
        .mix(ruleRenderIndex)
        .value();
    auto const folded = static_cast<uint32_t>(hash) ^
        static_cast<uint32_t>(hash >> 32U);
    // The GPU masks this key to its available power-of-two tie lattice. Add
    // the tile phase instead of overwriting low bits so that same-tile
    // semantic identities still participate in that ordering.
    return folded + subsetDepthPhase_;
}

JsValue TileSubsetLayerRenderer::coordinateOriginToJs() const
{
    std::array<double, 3> const origin = hasCoordinateOriginWgs_
        ? std::array<double, 3>{
              coordinateOriginWgs_.x,
              coordinateOriginWgs_.y,
              coordinateOriginWgs_.z}
        : std::array<double, 3>{0.0, 0.0, 0.0};
    return JsValue::Float64Array(origin);
}

JsValue TileSubsetLayerRenderer::pickResultsToJs() const
{
    auto results = JsValue::List();
    for (uint32_t index = 0U; index < pickRefs_.size(); ++index) {
        auto item = JsValue::Dict();
        auto const found = bridgePickResults_.find(index);
        if (found == bridgePickResults_.end()) {
            results.push(item);
            continue;
        }
        auto const& pick = found->second;
        if (!pick.featureId.empty()) {
            item.set("featureId", JsValue(pick.featureId));
        }
        if (pick.attributeIndex) {
            item.set(
                "attributeIndex",
                JsValue(*pick.attributeIndex));
        }
        if (pick.hasValidity) {
            item.set(
                "hasValidity",
                JsValue(*pick.hasValidity));
            item.set(
                "validityIndex",
                JsValue(pick.validityIndex));
        }
        if (!pick.relationId.empty()) {
            item.set("relationId", JsValue(pick.relationId));
        }
        if (!pick.relationSourceFeatureId.empty()) {
            item.set(
                "relationSourceFeatureId",
                JsValue(pick.relationSourceFeatureId));
        }
        if (pick.relationIndex) {
            item.set(
                "relationIndex",
                JsValue(*pick.relationIndex));
        }
        if (!pick.memberFeatureIds.empty()) {
            auto members = JsValue::List();
            for (auto const& member : pick.memberFeatureIds) {
                members.push(JsValue(member));
            }
            item.set("memberFeatureIds", members);
        }
        results.push(item);
    }
    return results;
}

uint8_t TileSubsetLayerRenderer::toColorByte(float value)
{
    return static_cast<uint8_t>(
        std::clamp(value, 0.0f, 1.0f) * 255.0f + 0.5f);
}

NativeJsValue TileSubsetLayerRenderer::renderBridgeResult() const
{
    auto const hasGltfBridge =
        !bridgeBuffers_.gltfNodes.nodeIndices.empty() ||
        !bridgeBuffers_.gltfPickProxies.featureAddresses.empty();
    auto result = JsValue::Dict({
        {"gltfNodes", gltfBuffersToJs(bridgeBuffers_.gltfNodes)},
        {"gltfPickProxies",
         gltfPickProxyBuffersToJs(bridgeBuffers_.gltfPickProxies)},
        {"coordinateOrigin", coordinateOriginToJs()},
        {"pickResults", hasGltfBridge ? pickResultsToJs() : JsValue::List()},
    });
    if (subset_ && subset_->glbAttachmentName())
    {
        result.set(
            "glbAttachmentName",
            JsValue(*subset_->glbAttachmentName()));
    }
    return *result;
}

NativeJsValue TileSubsetLayerRenderer::renderPackets() const
{
    auto result = JsValue::List();
    for (auto const& packet : renderPacketFragmentsBytes()) {
        result.push(JsValue::Uint8Array(std::span<uint8_t const>{
            reinterpret_cast<uint8_t const*>(packet.data()),
            packet.size(),
        }));
    }
    return *result;
}

std::vector<std::byte> TileSubsetLayerRenderer::renderPacketBytes() const
{
    return gpuPacketBuilder_.build();
}

std::vector<std::vector<std::byte>>
TileSubsetLayerRenderer::renderPacketFragmentsBytes() const
{
    return gpuPacketBuilder_.buildFragments();
}

uint32_t TileSubsetLayerRenderer::vertexCount() const
{
    return vertexCount_;
}

} // namespace erdblick
