#include "subset-renderer.h"
#include "style-filter-plan.h"

#include "geometry.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <limits>
#include <sstream>

#include <glm/common.hpp>
#include <glm/exponential.hpp>
#include <glm/trigonometric.hpp>

namespace erdblick
{
namespace
{

constexpr uint32_t kUnselectable = std::numeric_limits<uint32_t>::max();
constexpr double kPi = 3.14159265358979323846;
constexpr double kDegToRad = kPi / 180.0;
constexpr double kMercatorTileSize = 512.0;
constexpr double kFallbackEarthRadiusMeters = 6378137.0;
constexpr double kEarthCircumferenceMeters = 40.03e6;
constexpr double kArrowHeadLengthMinMeters = 2.0;
constexpr double kArrowHeadLengthMaxMeters = 24.0;
constexpr double kArrowHeadLengthFraction = 0.35;
constexpr double kArrowHeadWidthFraction = 0.55;
constexpr double kArrowSegmentEpsilonMeters = 1e-6;
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

std::optional<uint32_t> channelRuleIndex(std::string_view channelId)
{
    auto const separator = channelId.rfind(':');
    if (separator == std::string_view::npos ||
        separator + 1 >= channelId.size())
    {
        return std::nullopt;
    }
    uint32_t value = 0;
    auto const suffix = channelId.substr(separator + 1);
    auto parsed = std::from_chars(
        suffix.data(),
        suffix.data() + suffix.size(),
        value);
    if (parsed.ec != std::errc{} ||
        parsed.ptr != suffix.data() + suffix.size())
    {
        return std::nullopt;
    }
    return value;
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

JsValue rgbaBytes(glm::fvec4 const& color)
{
    auto toByte = [](float value) {
        return static_cast<uint8_t>(std::round(
            std::clamp(value, 0.0f, 1.0f) * 255.0f));
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
    return (kMercatorTileSize * ((longitudeDeg * kDegToRad) + kPi)) /
        (2.0 * kPi);
}

double mercatorWorldY(double latitudeDeg)
{
    auto const latitudeRad = latitudeDeg * kDegToRad;
    auto const mercatorTerm =
        glm::log(glm::tan((kPi * 0.25) + (latitudeRad * 0.5)));
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
        return false;
    }
    auto const worldSize = kMercatorTileSize;
    auto const latCosine = std::abs(latitudeCos);
    unitsPerMeter =
        worldSize / kEarthCircumferenceMeters / latCosine;
    unitsPerMeter2 =
        unitsPerMeter * std::tan(latitudeRad) /
        kFallbackEarthRadiusMeters;
    return std::isfinite(unitsPerMeter) &&
        std::isfinite(unitsPerMeter2) &&
        std::abs(unitsPerMeter) > 1e-12;
}

/** Preserve the distinction between an authored zero and no z-index at all. */
double resolvedZIndex(
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun)
{
    return rule.zIndex(evalFun).value_or(
        std::numeric_limits<double>::quiet_NaN());
}

JsValue pointBuffersToJs(
    TileSubsetLayerRenderer::PointBuffers const& buffers)
{
    return JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.positions)},
        {"colors", JsValue::Uint8Array(buffers.colors)},
        {"radii", JsValue::Float32Array(buffers.radii)},
        {"zIndices", JsValue::Float64Array(buffers.zIndices)},
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
        {"glowColors", JsValue::Uint8Array(buffers.glowColors)},
        {"glowRadii", JsValue::Float32Array(buffers.glowRadii)},
    });
}

JsValue surfaceBuffersToJs(
    TileSubsetLayerRenderer::SurfaceBuffers const& buffers)
{
    return JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.positions)},
        {"startIndices", JsValue::Uint32Array(buffers.startIndices)},
        {"holeIndices", JsValue::Uint32Array(buffers.holeIndices)},
        {"holeIndexStarts", JsValue::Uint32Array(buffers.holeIndexStarts)},
        {"colors", JsValue::Uint8Array(buffers.colors)},
        {"zIndices", JsValue::Float64Array(buffers.zIndices)},
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
        {"glowColors", JsValue::Uint8Array(buffers.glowColors)},
        {"glowRadii", JsValue::Float32Array(buffers.glowRadii)},
    });
}

JsValue pathBuffersToJs(
    TileSubsetLayerRenderer::PathBuffers const& buffers,
    bool includeDashArrays)
{
    auto result = JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.positions)},
        {"startIndices", JsValue::Uint32Array(buffers.startIndices)},
        {"colors", JsValue::Uint8Array(buffers.colors)},
        {"widths", JsValue::Float32Array(buffers.widths)},
        {"lateralOffsetsPx", JsValue::Float32Array(buffers.lateralOffsetsPx)},
        {"lateralOffsetVectorsPx",
         JsValue::Float32Array(buffers.lateralOffsetVectorsPx)},
        {"lateralOffsetScaleThresholds",
         JsValue::Float32Array(buffers.lateralOffsetScaleThresholds)},
        {"zIndices", JsValue::Float64Array(buffers.zIndices)},
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
        {"glowColors", JsValue::Uint8Array(buffers.glowColors)},
        {"glowRadii", JsValue::Float32Array(buffers.glowRadii)},
    });
    if (includeDashArrays) {
        result.set(
            "dashArrays",
            JsValue::Float32Array(buffers.dashArrays));
    }
    return result;
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
    auto result = std::hash<uint32_t>{}(value.subsetOrdinal);
    result ^= std::hash<uint32_t>{}(value.channelOrdinal) +
        0x9e3779b9U + (result << 6U) + (result >> 2U);
    result ^= std::hash<uint32_t>{}(value.entryOrdinal) +
        0x9e3779b9U + (result << 6U) + (result >> 2U);
    result ^= std::hash<uint32_t>{}(value.endpointRole) +
        0x9e3779b9U + (result << 6U) + (result >> 2U);
    return result;
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
    buffers_.surfaces.startIndices.push_back(0);
    buffers_.surfaces.holeIndexStarts.push_back(0);
    buffers_.pathWorld.startIndices.push_back(0);
    buffers_.pathBillboard.startIndices.push_back(0);
    buffers_.transitionPathWorld.startIndices.push_back(0);
    buffers_.transitionPathBillboard.startIndices.push_back(0);
    buffers_.arrowWorld.startIndices.push_back(0);
    buffers_.arrowBillboard.startIndices.push_back(0);
    buffers_.gltfPickProxies.startIndices.push_back(0);
}

TileSubsetLayerRenderer::~TileSubsetLayerRenderer() = default;

uint32_t TileSubsetLayerRenderer::abiVersion() const
{
    return 5U;
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
}

void TileSubsetLayerRenderer::addTileSubsetLayer(
    TileSubsetLayer const& subset)
{
    if (subset.model_) {
        subsets_.push_back(subset.model_);
        if (!hasCoordinateOriginWgs_) {
            coordinateOriginWgs_ = subset.model_->geometryAnchor();
            coordinateOriginWgs_.z = 0.0;
            hasCoordinateOriginWgs_ = true;
        }
    }
}

FeatureStyleRule const* TileSubsetLayerRenderer::ruleForChannel(
    std::string const& channelId) const
{
    auto const sourceIndex = channelRuleIndex(channelId);
    if (!sourceIndex) {
        return nullptr;
    }
    for (auto const& rule : style_.rules()) {
        if (rule.index() == *sourceIndex &&
            rule.mode() == highlightMode_ &&
            fidelityMatches(fidelity_, rule.fidelity()))
        {
            return &rule;
        }
    }
    return nullptr;
}

TileSubsetLayerRenderer::ChannelBinding
TileSubsetLayerRenderer::bindingFor(
    mapget::model_ptr<mapget::TileSubsetChannel> const& channel)
{
    ChannelBinding binding;
    if (!channel) {
        return binding;
    }
    binding.rule = ruleForChannel(channel->channelId());
    binding.featureFields = channel->featureFields();
    binding.entryFields = channel->entryFields();
    if (!binding.rule) {
        // Search presentations append one result-list channel that deliberately
        // has no top-level render rule. It is consumed by TypeScript only.
        if (channel->channelId().starts_with("search-results:")) {
            return binding;
        }
        auto const sourceIndex =
            channelRuleIndex(channel->channelId());
        auto const sourceRule =
            sourceIndex
                ? std::ranges::find_if(
                      style_.rules(),
                      [sourceIndex](FeatureStyleRule const& rule) {
                          return rule.index() == *sourceIndex;
                      })
                : style_.rules().end();
        // A bundle planned with AnyFidelity intentionally contains both
        // fidelity variants so the view can switch without a refetch.
        // Skipping the inactive variant is therefore not a style error.
        if (sourceRule == style_.rules().end() ||
            sourceRule->mode() != highlightMode_)
        {
            recordRuntimeIssue(
                "channelId",
                channel->channelId(),
                "No active top-level style rule matches this subset channel.",
                0);
        }
    }
    return binding;
}

void TileSubsetLayerRenderer::run()
{
    subsetVertexCounts_.clear();
    currentSubsetOrdinal_ = 0;
    for (auto const& subset : subsets_) {
        auto const vertexCountBefore = vertexCount_;
        if (!subset) {
            subsetVertexCounts_.push_back(0);
            ++currentSubsetOrdinal_;
            continue;
        }
        // These counters historically belonged to one per-tile renderer.
        // A presentation block must not let one subset's offset slots or
        // relation endpoint addresses affect another model pool.
        featureOffsetSlotsByRule_.clear();
        attributeOffsetSlotsByFeature_.clear();
        attributeOffsetSlotsBySegment_.clear();
        attributeOffsetSlotsByTransitionLeg_.clear();
        renderedRelationEndpointParts_.clear();
        renderedRelationEndpointLabels_.clear();
        relationEndpointLabelIdentity_.reset();
        uint32_t channelOrdinal = 0;
        subset->forEachChannel(
            [&](mapget::model_ptr<mapget::TileSubsetChannel> const& channel) {
                auto const currentChannelOrdinal = channelOrdinal++;
                auto const binding = bindingFor(channel);
                if (!binding.rule) {
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
        subsetVertexCounts_.push_back(
            vertexCount_ - vertexCountBefore);
        ++currentSubsetOrdinal_;
    }
}

BoundEvalFun TileSubsetLayerRenderer::makeEvalFun(
    std::vector<std::string> const& fields,
    mapget::model_ptr<mapget::Array> const& values)
{
    return BoundEvalFun{
        [this, &fields, values](std::string const& expression) {
            auto const projectedExpression =
                expandStyleExpressionForFilter(expression);
            auto const found = std::find(
                fields.begin(),
                fields.end(),
                projectedExpression);
            if (found == fields.end()) {
                recordRuntimeIssue(
                    "projection",
                    expression,
                    "Style expression was not projected by its subset channel.",
                    0);
                return simfil::Value::undef();
            }
            auto const index = static_cast<uint32_t>(
                std::distance(fields.begin(), found));
            if (!values || index >= values->size()) {
                recordRuntimeIssue(
                    "projection",
                    expression,
                    "Projected value array does not match its channel schema.",
                    0);
                return simfil::Value::undef();
            }
            auto node = values->at(index);
            return node
                ? simfil::Value::field(*node)
                : simfil::Value::undef();
        },
        [this](
            std::string const& property,
            std::string const& expression,
            std::string const& message,
            uint32_t ruleIndex)
        {
            recordRuntimeIssue(
                property,
                expression,
                message,
                ruleIndex);
        },
    };
}

void TileSubsetLayerRenderer::renderFeature(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    ChannelBinding const& binding,
    mapget::model_ptr<mapget::FeatureEntry> const& entry)
{
    if (!entry || !entry->featureId() || !binding.rule) {
        return;
    }
    auto eval = makeEvalFun(binding.featureFields, entry->values());
    FeatureStyleRule::MatchContext context{
        .featureType = entry->featureId()->typeId(),
    };
    auto const matched = binding.rule->forEachMatchingRule(
        context,
        eval,
        [&](FeatureStyleRule const& rule) {
            auto const pick = pickIndex(
                channelOrdinal,
                entryOrdinal,
                0,
                rule.selectable(),
                pickResult(entry));
            auto const slot =
                featureOffsetSlotsByRule_[rule.renderIndex()];
            if (renderGeometryCollection(
                    entry->geometry(),
                    rule,
                    eval,
                    pick,
                    rule.offset() +
                        rule.offsetIncrement() *
                            static_cast<double>(slot)))
            {
                ++featureOffsetSlotsByRule_[rule.renderIndex()];
            }
        });
    if (!matched) {
        recordRuntimeIssue(
            "rule-match",
            std::string(context.featureType),
            "A server-admitted feature entry matched no concrete leaf of its top-level style rule.",
            binding.rule->index());
    }
}

void TileSubsetLayerRenderer::renderAttribute(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    ChannelBinding const& binding,
    mapget::model_ptr<mapget::AttributeValidityEntry> const& entry)
{
    if (!entry || !entry->featureId() || !binding.rule) {
        return;
    }
    auto hostEval =
        makeEvalFun(binding.featureFields, entry->hostValues());
    auto entryEval =
        makeEvalFun(binding.entryFields, entry->values());
    auto const attributeName = entry->attributeName();
    auto const attributeLayer = entry->attributeLayer();
    FeatureStyleRule::MatchContext context{
        .featureType = entry->featureId()->typeId(),
        .attributeName = attributeName
            ? std::optional<std::string_view>{*attributeName}
            : std::nullopt,
        .attributeLayer = attributeLayer
            ? std::optional<std::string_view>{*attributeLayer}
            : std::nullopt,
        .hasValidity = entry->hasValidity(),
    };
    binding.rule->forEachMatchingRule(
        context,
        entryEval,
        [&](FeatureStyleRule const& rule) {
            auto const pick = pickIndex(
                channelOrdinal,
                entryOrdinal,
                0,
                rule.selectable(),
                pickResult(entry));
            auto const slotKey =
                std::to_string(channelOrdinal) + ":" +
                entry->featureId()->toString() + ":" +
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
    if (!entry || !entry->representativeFeatureId() || !binding.rule) {
        return;
    }
    auto eval = makeEvalFun(binding.entryFields, entry->values());
    FeatureStyleRule::MatchContext context{
        .featureType = entry->representativeFeatureId()->typeId(),
    };
    auto const matched = binding.rule->forEachMatchingRule(
        context,
        eval,
        [&](FeatureStyleRule const& rule) {
            auto const pick = pickIndex(
                channelOrdinal,
                entryOrdinal,
                0,
                rule.selectable(),
                pickResult(entry));
            auto const slot =
                featureOffsetSlotsByRule_[rule.renderIndex()];
            if (renderGeometryCollection(
                    entry->geometry(),
                    rule,
                    eval,
                    pick,
                    rule.offset() +
                        rule.offsetIncrement() *
                            static_cast<double>(slot)))
            {
                ++featureOffsetSlotsByRule_[rule.renderIndex()];
            }
        });
    if (!matched) {
        recordRuntimeIssue(
            "rule-match",
            std::string(context.featureType),
            "A server-admitted group entry matched no concrete leaf of its top-level style rule.",
            binding.rule->index());
    }
}

void TileSubsetLayerRenderer::renderRelation(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    ChannelBinding const& binding,
    mapget::model_ptr<mapget::RelationEntry> const& entry)
{
    if (!entry || !entry->source() || !entry->target() ||
        !entry->source()->featureId() || !entry->target()->featureId() ||
        !binding.rule)
    {
        return;
    }

    auto relationEval =
        makeEvalFun(binding.entryFields, entry->values());
    auto const relationName = entry->name();
    FeatureStyleRule::MatchContext relationContext{
        .featureType = entry->source()->featureId()->typeId(),
        .relationName = relationName,
    };
    binding.rule->forEachMatchingRule(
        relationContext,
        relationEval,
        [&](FeatureStyleRule const& rule) {
            auto const relationPick = pickIndex(
                channelOrdinal,
                entryOrdinal,
                0,
                rule.selectable(),
                pickResult(entry, 0));
            renderRelationLine(
                entry->sourceGeometry(),
                entry->targetGeometry(),
                rule,
                relationEval,
                relationPick);

            auto renderEndpoint =
                [&](mapget::model_ptr<mapget::FeatureEntry> const& endpoint,
                    mapget::model_ptr<mapget::GeometryCollection> const& geometry,
                    std::shared_ptr<FeatureStyleRule> const& endpointStyle,
                    uint32_t endpointRole)
            {
                if (!endpoint || !endpoint->featureId() || !geometry ||
                    !endpointStyle)
                {
                    return;
                }
                auto endpointEval =
                    makeEvalFun(binding.featureFields, endpoint->values());
                FeatureStyleRule::MatchContext endpointContext{
                    .featureType = endpoint->featureId()->typeId(),
                };
                endpointStyle->forEachMatchingRule(
                    endpointContext,
                    endpointEval,
                    [&](FeatureStyleRule const& endpointRule) {
                        std::ostringstream key;
                        key << currentSubsetOrdinal_ << ':'
                            << endpoint->featureId()->mapId() << ':'
                            << endpoint->featureId()->toString() << ':'
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
                            pickResult(entry, endpointRole));
                        auto const previousLabelIdentity =
                            relationEndpointLabelIdentity_;
                        relationEndpointLabelIdentity_ =
                            endpoint->featureId()->mapId() + "\n" +
                            endpoint->featureId()->toString();
                        renderGeometryCollection(
                            geometry,
                            endpointRule,
                            endpointEval,
                            endpointPick,
                            endpointRule.offset());
                        relationEndpointLabelIdentity_ =
                            previousLabelIdentity;
                    });
            };

            renderEndpoint(
                entry->source(),
                entry->sourceGeometry(),
                rule.relationSourceStyle(),
                1);
            renderEndpoint(
                entry->target(),
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
    glm::dvec3 const& offset)
{
    bool rendered = false;
    std::optional<mapget::Point> labelPosition;
    if (!collection) {
        return rendered;
    }
    collection->forEachGeometry(
        [&](mapget::model_ptr<mapget::Geometry> const& geometry) {
            auto const renderedGeometry = renderGeometry(
                geometry,
                rule,
                evalFun,
                pick,
                offset,
                false);
            if (renderedGeometry && !labelPosition && rule.hasLabel() &&
                geometry)
            {
                auto presentationOffset = offset;
                if (geometry->geomType() == mapget::GeomType::Line &&
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
        });
    if (rendered && labelPosition && rule.hasLabel()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
            appendLabel(
                *labelPosition,
                text,
                rule,
                resolvedZIndex(rule, evalFun),
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
    bool renderLabel)
{
    if (!geometry) {
        return false;
    }
    auto const name = geometryName(geometry);
    auto const type = geometry->geomType();
    auto const supportsOwnType = rule.supports(type, name);
    auto const gltfAsAabb =
        type == mapget::GeomType::GltfNodeIndex &&
        rule.supports(mapget::GeomType::AABB, name);
    if (!supportsOwnType && !gltfAsAabb) {
        return false;
    }

    auto color = rule.color(evalFun);
    if (!color) {
        return false;
    }
    auto const zIndex = resolvedZIndex(rule, evalFun);

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
    auto transformed = applyPresentationTransform(
        geometry->toSelfContained(),
        rule,
        presentationOffset);
    std::vector<mapget::Point> projected;
    projected.reserve(transformed.points_.size());
    for (auto const& point : transformed.points_) {
        projected.push_back(projectWgsPoint(point));
    }

    switch (type) {
    case mapget::GeomType::Points:
        for (auto const& point : projected) {
            appendPoint(
                point,
                rule,
                evalFun,
                *color,
                zIndex,
                pick);
        }
        break;
    case mapget::GeomType::Line:
        if (pixelLateralOffset) {
            appendPath(
                projected,
                rule,
                evalFun,
                *color,
                zIndex,
                pick,
                std::vector<float>(
                    projected.size(),
                    static_cast<float>(offset.x)));
        }
        else {
            appendPath(
                projected,
                rule,
                evalFun,
                *color,
                zIndex,
                pick);
        }
        break;
    case mapget::GeomType::Polygon:
        appendSurface(
            projected,
            transformed.polygonRingStarts_,
            rule,
            *color,
            zIndex,
            pick);
        break;
    case mapget::GeomType::Mesh:
        appendMesh(projected, rule, *color, zIndex, pick);
        break;
    case mapget::GeomType::AABB:
    case mapget::GeomType::GltfNodeIndex:
        break;
    }

    if (renderLabel && rule.hasLabel() && !transformed.points_.empty()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
            appendLabel(
                projectWgsPoint(geometryCenter(transformed)),
                text,
                rule,
                zIndex,
                pick);
        }
    }
    return !projected.empty();
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
    auto offsetRotation = std::atan2(offsetUnitCross, offsetUnitDot);
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
        auto const cosine = std::cos(angle);
        auto const sine = std::sin(angle);
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
        auto thresholdBuffer = [&](TransitionOffsetBuffer buffer)
            -> PathBuffers& {
            switch (buffer) {
            case TransitionOffsetBuffer::PathWorld:
                return buffers_.transitionPathWorld;
            case TransitionOffsetBuffer::PathBillboard:
                return buffers_.transitionPathBillboard;
            case TransitionOffsetBuffer::ArrowWorld:
                return buffers_.arrowWorld;
            case TransitionOffsetBuffer::ArrowBillboard:
                return buffers_.arrowBillboard;
            }
            return buffers_.transitionPathWorld;
        };
        for (auto const& slot : scaleGroup->slots) {
            auto& thresholds = thresholdBuffer(slot.buffer)
                .lateralOffsetScaleThresholds;
            if (slot.index < thresholds.size()) {
                thresholds[slot.index] = lateralOffsetScaleThreshold;
            }
        }
    }

    auto const billboard = rule.billboard().value_or(false);
    auto& transitionBuffers = billboard
        ? buffers_.transitionPathBillboard
        : buffers_.transitionPathWorld;
    auto& arrowBuffers = billboard
        ? buffers_.arrowBillboard
        : buffers_.arrowWorld;
    auto const transitionThresholdIndex =
        transitionBuffers.lateralOffsetScaleThresholds.size();
    auto const firstArrowThresholdIndex =
        arrowBuffers.lateralOffsetScaleThresholds.size();
    appendPath(
        path,
        rule,
        evalFun,
        *color,
        zIndex,
        pick,
        lateralOffsetsPx,
        lateralOffsetVectorsPx,
        lateralOffsetScaleThreshold);
    if (scaleGroup) {
        scaleGroup->slots.push_back({
            billboard
                ? TransitionOffsetBuffer::PathBillboard
                : TransitionOffsetBuffer::PathWorld,
            transitionThresholdIndex,
        });
        for (auto index = firstArrowThresholdIndex;
             index < arrowBuffers.lateralOffsetScaleThresholds.size();
             ++index) {
            scaleGroup->slots.push_back({
                billboard
                    ? TransitionOffsetBuffer::ArrowBillboard
                    : TransitionOffsetBuffer::ArrowWorld,
                index,
            });
        }
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
        evalFun,
        *color,
        zIndex,
        pick,
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
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    uint32_t pick)
{
    auto sourceCenter = collectionCenter(sourceGeometry);
    auto targetCenter = collectionCenter(targetGeometry);
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
    if (color && rule.width(evalFun) > 0.0f &&
        rule.supports(mapget::GeomType::Line))
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
            evalFun,
            *color,
            resolvedZIndex(rule, evalFun),
            pick);
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
            if (!markerColor ||
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
                    evalFun,
                    *markerColor,
                    resolvedZIndex(markerRule, evalFun),
                    pick);
            }
        });
}

uint32_t TileSubsetLayerRenderer::pickIndex(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    uint32_t endpointRole,
    bool selectable,
    PickResult result)
{
    if (!selectable) {
        return kUnselectable;
    }
    PickRef key{
        currentSubsetOrdinal_,
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
    result.subsetOrdinal = currentSubsetOrdinal_;
    pickRefs_.push_back(key);
    pickResults_.push_back(std::move(result));
    pickIndices_.emplace(key, index);
    return index;
}

TileSubsetLayerRenderer::PickResult
TileSubsetLayerRenderer::pickResult(
    mapget::model_ptr<mapget::FeatureEntry> const& entry)
{
    PickResult result;
    if (entry && entry->featureId()) {
        result.featureId = entry->featureId()->toString();
    }
    return result;
}

TileSubsetLayerRenderer::PickResult
TileSubsetLayerRenderer::pickResult(
    mapget::model_ptr<mapget::AttributeValidityEntry> const& entry)
{
    PickResult result;
    if (!entry) {
        return result;
    }
    if (entry->featureId()) {
        result.featureId = entry->featureId()->toString();
    }
    result.attributeIndex = entry->attributeIndex();
    result.hasValidity = entry->hasValidity();
    result.validityIndex = entry->validityIndex();
    return result;
}

TileSubsetLayerRenderer::PickResult
TileSubsetLayerRenderer::pickResult(
    mapget::model_ptr<mapget::GroupEntry> const& entry)
{
    PickResult result;
    if (!entry) {
        return result;
    }
    if (entry->representativeFeatureId()) {
        result.featureId =
            entry->representativeFeatureId()->toString();
    }
    auto members = entry->memberFeatureIds();
    if (!members) {
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
    uint32_t endpointRole)
{
    PickResult result;
    if (!entry) {
        return result;
    }
    auto endpoint =
        endpointRole == 2 ? entry->target() : entry->source();
    if (endpoint && endpoint->featureId()) {
        result.featureId =
            endpoint->featureId()->toString();
    }
    auto source = entry->source();
    if (source && source->featureId()) {
        result.relationSourceFeatureId =
            source->featureId()->toString();
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
    auto& buffers = rule.billboard().value_or(false)
        ? buffers_.pointBillboard
        : buffers_.pointWorld;
    buffers.positions.insert(
        buffers.positions.end(),
        {
            static_cast<float>(point.x),
            static_cast<float>(point.y),
            static_cast<float>(point.z),
        });
    buffers.colors.insert(
        buffers.colors.end(),
        {
            toColorByte(color.r),
            toColorByte(color.g),
            toColorByte(color.b),
            toColorByte(color.a),
        });
    buffers.radii.push_back(
        std::max(
            0.0f,
            rule.width(evalFun) * 0.5f));
    buffers.zIndices.push_back(zIndex);
    buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
    buffers.featureAddresses.push_back(pick);
    appendGlow(rule, buffers.glowColors, buffers.glowRadii);
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
    auto& buffers = buffers_.surfaces;
    auto const startVertex =
        static_cast<uint32_t>(buffers.positions.size() / 3);
    for (auto const& point : points) {
        buffers.positions.insert(
            buffers.positions.end(),
            {
                static_cast<float>(point.x),
                static_cast<float>(point.y),
                static_cast<float>(point.z),
            });
        buffers.colors.insert(
            buffers.colors.end(),
            {
                toColorByte(color.r),
                toColorByte(color.g),
                toColorByte(color.b),
                toColorByte(color.a),
            });
    }
    for (size_t index = 1; index < ringStarts.size(); ++index) {
        if (ringStarts[index] < points.size()) {
            buffers.holeIndices.push_back(
                startVertex + ringStarts[index]);
        }
    }
    buffers.holeIndexStarts.push_back(
        static_cast<uint32_t>(buffers.holeIndices.size()));
    buffers.zIndices.push_back(zIndex);
    buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
    buffers.featureAddresses.push_back(pick);
    appendGlow(rule, buffers.glowColors, buffers.glowRadii);
    buffers.startIndices.push_back(
        static_cast<uint32_t>(buffers.positions.size() / 3));
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

void TileSubsetLayerRenderer::appendPath(
    std::vector<mapget::Point> const& points,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    glm::fvec4 const& color,
    double zIndex,
    uint32_t pick,
    std::span<float const> lateralOffsetsPx,
    std::span<glm::fvec2 const> lateralOffsetVectorsPx,
    float lateralOffsetScaleThreshold)
{
    auto const width =
        std::max(0.0f, rule.width(evalFun));
    if (points.size() < 2 || width <= 0.0f) {
        return;
    }
    auto const hasOffsetVectors =
        lateralOffsetVectorsPx.size() >= points.size();
    auto& buffers = hasOffsetVectors
        ? (rule.billboard().value_or(false)
            ? buffers_.transitionPathBillboard
            : buffers_.transitionPathWorld)
        : (rule.billboard().value_or(false)
            ? buffers_.pathBillboard
            : buffers_.pathWorld);
    auto const dashed = rule.isDashed();
    auto const dashLength =
        static_cast<float>(std::max(1, rule.dashLength()));
    for (size_t pointIndex = 0; pointIndex < points.size(); ++pointIndex) {
        auto const& point = points[pointIndex];
        buffers.positions.insert(
            buffers.positions.end(),
            {
                static_cast<float>(point.x),
                static_cast<float>(point.y),
                static_cast<float>(point.z),
            });
        buffers.colors.insert(
            buffers.colors.end(),
            {
                toColorByte(color.r),
                toColorByte(color.g),
                toColorByte(color.b),
                toColorByte(color.a),
            });
        buffers.widths.push_back(width);
        buffers.lateralOffsetsPx.push_back(
            pointIndex < lateralOffsetsPx.size()
                ? lateralOffsetsPx[pointIndex]
                : 0.0f);
        if (hasOffsetVectors) {
            buffers.lateralOffsetVectorsPx.push_back(
                lateralOffsetVectorsPx[pointIndex].x);
            buffers.lateralOffsetVectorsPx.push_back(
                lateralOffsetVectorsPx[pointIndex].y);
        }
        buffers.dashArrays.push_back(dashed ? dashLength : 1.0f);
        buffers.dashArrays.push_back(dashed ? dashLength : 0.0f);
    }
    buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
    buffers.featureAddresses.push_back(pick);
    buffers.lateralOffsetScaleThresholds.push_back(
        hasOffsetVectors
            ? std::max(0.0f, lateralOffsetScaleThreshold)
            : 0.0f);
    buffers.zIndices.push_back(zIndex);
    appendGlow(rule, buffers.glowColors, buffers.glowRadii);
    buffers.startIndices.push_back(
        static_cast<uint32_t>(buffers.positions.size() / 3));
    vertexCount_ += static_cast<uint32_t>(points.size());

    auto const arrow = rule.arrow(evalFun);
    auto endpointOffsetVector = [&](size_t begin,
                                    size_t end,
                                    size_t offsetIndex,
                                    float lateralOffsetPx) {
        if (hasOffsetVectors) {
            return lateralOffsetVectorsPx[offsetIndex];
        }
        auto const dx = points[end].x - points[begin].x;
        auto const dy = points[end].y - points[begin].y;
        auto const length = std::hypot(dx, dy);
        return length > kArrowSegmentEpsilonMeters
            ? glm::fvec2{
                static_cast<float>(dy / length) * lateralOffsetPx,
                static_cast<float>(-dx / length) * lateralOffsetPx}
            : glm::fvec2{};
    };
    if (arrow == FeatureStyleRule::ForwardArrow ||
        arrow == FeatureStyleRule::DoubleArrow)
    {
        appendArrowHead(
            points.back(),
            points[points.size() - 2],
            rule,
            width,
            color,
            zIndex,
            pick,
            endpointOffsetVector(
                points.size() - 2,
                points.size() - 1,
                points.size() - 1,
                lateralOffsetsPx.size() >= points.size()
                    ? lateralOffsetsPx.back()
                    : 0.0f),
            lateralOffsetScaleThreshold);
    }
    if (arrow == FeatureStyleRule::BackwardArrow ||
        arrow == FeatureStyleRule::DoubleArrow)
    {
        appendArrowHead(
            points.front(),
            points[1],
            rule,
            width,
            color,
            zIndex,
            pick,
            endpointOffsetVector(
                0,
                1,
                0,
                !lateralOffsetsPx.empty()
                    ? lateralOffsetsPx.front()
                    : 0.0f),
            lateralOffsetScaleThreshold);
    }
}

void TileSubsetLayerRenderer::appendArrowHead(
    mapget::Point const& tip,
    mapget::Point const& previous,
    FeatureStyleRule const& rule,
    float width,
    glm::fvec4 const& color,
    double zIndex,
    uint32_t pick,
    glm::fvec2 lateralOffsetVectorPx,
    float lateralOffsetScaleThreshold)
{
    auto const dx = tip.x - previous.x;
    auto const dy = tip.y - previous.y;
    auto const dz = tip.z - previous.z;
    auto const length = std::sqrt(dx * dx + dy * dy + dz * dz);
    if (length <= kArrowSegmentEpsilonMeters) {
        return;
    }
    auto const dirX = dx / length;
    auto const dirY = dy / length;
    auto const dirZ = dz / length;
    auto perpX = -dirY;
    auto perpY = dirX;
    auto perpLength = std::sqrt(perpX * perpX + perpY * perpY);
    if (perpLength <= kArrowSegmentEpsilonMeters) {
        perpX = 1.0;
        perpY = 0.0;
        perpLength = 1.0;
    }
    perpX /= perpLength;
    perpY /= perpLength;
    auto const headLength = std::clamp(
        length * kArrowHeadLengthFraction,
        kArrowHeadLengthMinMeters,
        kArrowHeadLengthMaxMeters);
    auto const halfWidth =
        headLength * kArrowHeadWidthFraction;
    auto const base = mapget::Point{
        tip.x - dirX * headLength,
        tip.y - dirY * headLength,
        tip.z - dirZ * headLength,
    };
    auto const left = mapget::Point{
        base.x + perpX * halfWidth,
        base.y + perpY * halfWidth,
        base.z,
    };
    auto const right = mapget::Point{
        base.x - perpX * halfWidth,
        base.y - perpY * halfWidth,
        base.z,
    };

    auto& buffers = rule.billboard().value_or(false)
        ? buffers_.arrowBillboard
        : buffers_.arrowWorld;
    for (auto const& point : {left, tip, right}) {
        buffers.positions.insert(
            buffers.positions.end(),
            {
                static_cast<float>(point.x),
                static_cast<float>(point.y),
                static_cast<float>(point.z),
            });
        buffers.colors.insert(
            buffers.colors.end(),
            {
                toColorByte(color.r),
                toColorByte(color.g),
                toColorByte(color.b),
                toColorByte(color.a),
            });
        buffers.widths.push_back(
            std::max(1.0f, width));
        buffers.lateralOffsetsPx.push_back(0.0f);
        buffers.lateralOffsetVectorsPx.push_back(
            lateralOffsetVectorPx.x);
        buffers.lateralOffsetVectorsPx.push_back(
            lateralOffsetVectorPx.y);
    }
    buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
    buffers.featureAddresses.push_back(pick);
    buffers.lateralOffsetScaleThresholds.push_back(
        std::max(0.0f, lateralOffsetScaleThreshold));
    buffers.zIndices.push_back(zIndex);
    appendGlow(rule, buffers.glowColors, buffers.glowRadii);
    buffers.startIndices.push_back(
        static_cast<uint32_t>(buffers.positions.size() / 3));
    vertexCount_ += 3;
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

    auto& buffers = buffers_.gltfNodes;
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
    auto& proxies = buffers_.gltfPickProxies;
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
    auto fillColor = rule.labelColor();
    fillColor.a *= rule.labelOpacity();
    auto outlineColor = rule.labelOutlineColor();
    outlineColor.a *= rule.labelOpacity();
    auto params = JsValue::Dict({
        {"featureAddress", JsValue(pick)},
        {"position", JsValue::Dict({
            {"x", JsValue(point.x)},
            {"y", JsValue(point.y)},
            {"z", JsValue(point.z)},
        })},
        {"text", JsValue(text)},
        {"fillColor", rgbaBytes(fillColor)},
        {"outlineColor", rgbaBytes(outlineColor)},
        {"outlineWidth", JsValue(rule.labelOutlineWidth())},
        {"scale", JsValue(rule.labelScale())},
        {"billboard", JsValue(rule.billboard().value_or(true))},
        {"depthTest", JsValue(rule.depthTest())},
    });
    if (std::isfinite(zIndex)) {
        params.set("zIndex", JsValue(zIndex));
    }
    if (rule.showBackground()) {
        auto backgroundColor = rule.labelBackgroundColor();
        backgroundColor.a *= rule.labelOpacity();
        params.set(
            "backgroundColor",
            rgbaBytes(backgroundColor));
        params.set(
            "backgroundPadding",
            JsValue::List({
                JsValue(rule.labelBackgroundPadding().first),
                JsValue(rule.labelBackgroundPadding().second),
            }));
    }
    if (auto const& offset = rule.labelPixelOffset()) {
        params.set(
            "pixelOffset",
            JsValue::List({
                JsValue(offset->first),
                JsValue(offset->second),
            }));
    }
    (rule.billboard().value_or(true)
         ? buffers_.labelBillboard
         : buffers_.labelWorld)
        .push_back(params);
    ++vertexCount_;
}

mapget::Point TileSubsetLayerRenderer::projectWgsPoint(
    mapget::Point const& wgsPoint) const
{
    if (!hasCoordinateOriginWgs_) {
        coordinateOriginWgs_ = {
            wgsPoint.x,
            wgsPoint.y,
            0.0,
        };
        hasCoordinateOriginWgs_ = true;
    }
    double unitsPerMeter = 0.0;
    double unitsPerMeter2 = 0.0;
    if (!distanceScalesAt(
            coordinateOriginWgs_.y,
            unitsPerMeter,
            unitsPerMeter2))
    {
        auto const lat0 = glm::radians(coordinateOriginWgs_.y);
        return {
            glm::radians(wgsPoint.x - coordinateOriginWgs_.x) *
                glm::cos(lat0) * kFallbackEarthRadiusMeters,
            glm::radians(wgsPoint.y - coordinateOriginWgs_.y) *
                kFallbackEarthRadiusMeters,
            wgsPoint.z - coordinateOriginWgs_.z,
        };
    }
    auto const deltaX =
        mercatorWorldX(wgsPoint.x) -
        mercatorWorldX(coordinateOriginWgs_.x);
    auto const deltaY =
        mercatorWorldY(wgsPoint.y) -
        mercatorWorldY(coordinateOriginWgs_.y);
    auto const yMeters = deltaY / unitsPerMeter;
    auto const xDenominator =
        unitsPerMeter + unitsPerMeter2 * yMeters;
    return {
        std::abs(xDenominator) < 1e-12
            ? 0.0
            : deltaX / xDenominator,
        yMeters,
        wgsPoint.z - coordinateOriginWgs_.z,
    };
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

JsValue TileSubsetLayerRenderer::pickRefsToJs() const
{
    std::vector<uint32_t> flattened;
    flattened.reserve(pickRefs_.size() * 4);
    for (auto const& pick : pickRefs_) {
        flattened.push_back(pick.subsetOrdinal);
        flattened.push_back(pick.channelOrdinal);
        flattened.push_back(pick.entryOrdinal);
        flattened.push_back(pick.endpointRole);
    }
    return JsValue::Uint32Array(flattened);
}

JsValue TileSubsetLayerRenderer::pickResultsToJs() const
{
    auto results = JsValue::List();
    for (auto const& pick : pickResults_) {
        auto item = JsValue::Dict();
        item.set(
            "subsetOrdinal",
            JsValue(pick.subsetOrdinal));
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

JsValue TileSubsetLayerRenderer::subsetVertexCountsToJs() const
{
    return JsValue::Uint32Array(subsetVertexCounts_);
}

uint8_t TileSubsetLayerRenderer::toColorByte(float value)
{
    return static_cast<uint8_t>(std::round(
        std::clamp(value, 0.0f, 1.0f) * 255.0f));
}

void TileSubsetLayerRenderer::appendGlow(
    FeatureStyleRule const& rule,
    std::vector<uint8_t>& colors,
    std::vector<float>& radii)
{
    auto const& glow = rule.glow();
    if (!glow || glow->radius <= 0.0f || glow->opacity <= 0.0f) {
        colors.insert(colors.end(), {0U, 0U, 0U, 0U});
        radii.push_back(0.0f);
        return;
    }
    colors.insert(colors.end(), {
        toColorByte(glow->color.r),
        toColorByte(glow->color.g),
        toColorByte(glow->color.b),
        toColorByte(glow->color.a * glow->opacity),
    });
    radii.push_back(std::max(0.0f, glow->radius));
}

JsValue TileSubsetLayerRenderer::geometryBuffersToJs(
    GeometryBuffers const& buffers)
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
        {"transitionPathWorld",
         pathBuffersToJs(buffers.transitionPathWorld, true)},
        {"transitionPathBillboard",
         pathBuffersToJs(buffers.transitionPathBillboard, true)},
        {"arrowWorld", pathBuffersToJs(buffers.arrowWorld, false)},
        {"arrowBillboard", pathBuffersToJs(buffers.arrowBillboard, false)},
        {"gltfNodes", gltfBuffersToJs(buffers.gltfNodes)},
        {"gltfPickProxies",
         gltfPickProxyBuffersToJs(buffers.gltfPickProxies)},
    });
}

NativeJsValue TileSubsetLayerRenderer::renderResult() const
{
    auto result = geometryBuffersToJs(buffers_);
    result.set("coordinateOrigin", coordinateOriginToJs());
    result.set("pickRefs", pickRefsToJs());
    result.set("pickResults", pickResultsToJs());
    result.set(
        "subsetVertexCounts",
        subsetVertexCountsToJs());
    if (!subsets_.empty() && subsets_.front() &&
        subsets_.front()->glbAttachmentName())
    {
        result.set(
            "glbAttachmentName",
            JsValue(*subsets_.front()->glbAttachmentName()));
    }
    return *result;
}

NativeJsValue TileSubsetLayerRenderer::runtimeStyleIssues() const
{
    auto result = JsValue::List();
    for (auto const& issue : runtimeIssues_) {
        result.push(JsValue::Dict({
            {"property", JsValue(issue.property)},
            {"expression", JsValue(issue.expression)},
            {"message", JsValue(issue.message)},
            {"ruleIndex", JsValue(issue.ruleIndex)},
            {"occurrenceCount",
             JsValue(static_cast<double>(issue.occurrenceCount))},
        }));
    }
    return *result;
}

uint32_t TileSubsetLayerRenderer::vertexCount() const
{
    return vertexCount_;
}

} // namespace erdblick
