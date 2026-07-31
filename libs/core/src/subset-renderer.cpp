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

JsValue pointBuffersToJs(
    TileSubsetLayerRenderer::PointBuffers const& buffers)
{
    return JsValue::Dict({
        {"positions", JsValue::Float32Array(buffers.positions)},
        {"colors", JsValue::Uint8Array(buffers.colors)},
        {"radii", JsValue::Float32Array(buffers.radii)},
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
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
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
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
        {"depthTests", JsValue::Uint8Array(buffers.depthTests)},
        {"featureAddresses", JsValue::Uint32Array(buffers.featureAddresses)},
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
    buffers_.arrowWorld.startIndices.push_back(0);
    buffers_.arrowBillboard.startIndices.push_back(0);
    buffers_.gltfPickProxies.startIndices.push_back(0);
}

TileSubsetLayerRenderer::~TileSubsetLayerRenderer() = default;

uint32_t TileSubsetLayerRenderer::abiVersion() const
{
    return 3U;
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
        renderedRelationEndpointParts_.clear();
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
            if (rule.offsetIncrement().x != 0.0 &&
                entry->geometry())
            {
                entry->geometry()->forEachGeometry(
                    [&](mapget::model_ptr<mapget::Geometry> const& geometry) {
                        if (geometry &&
                            geometry->geomType() == mapget::GeomType::Line)
                        {
                            rendered =
                                renderSegmentStackedLine(
                                    geometry,
                                    rule,
                                    entryEval,
                                    pick,
                                    std::to_string(channelOrdinal) + ":" +
                                        std::to_string(rule.renderIndex())) ||
                                rendered;
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
                            << endpoint->addr().value_ << ':'
                            << geometry->addr().value_ << ':'
                            << endpointRule.renderIndex() << ':'
                            << endpointRole;
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
                        renderGeometryCollection(
                            geometry,
                            endpointRule,
                            endpointEval,
                            endpointPick,
                            endpointRule.offset());
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
    if (!collection) {
        return rendered;
    }
    collection->forEachGeometry(
        [&](mapget::model_ptr<mapget::Geometry> const& geometry) {
            rendered =
                renderGeometry(
                    geometry,
                    rule,
                    evalFun,
                    pick,
                    offset) ||
                rendered;
            return true;
        });
    return rendered;
}

bool TileSubsetLayerRenderer::renderGeometry(
    mapget::model_ptr<mapget::Geometry> const& geometry,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    uint32_t pick,
    glm::dvec3 const& offset)
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
            pick);
        return true;
    }

    auto transformed = applyPresentationTransform(
        geometry->toSelfContained(),
        rule,
        offset);
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
                pick);
        }
        break;
    case mapget::GeomType::Line:
        appendPath(projected, rule, evalFun, *color, pick);
        break;
    case mapget::GeomType::Polygon:
        appendSurface(
            projected,
            transformed.polygonRingStarts_,
            rule,
            *color,
            pick);
        break;
    case mapget::GeomType::Mesh:
        appendMesh(projected, rule, *color, pick);
        break;
    case mapget::GeomType::AABB:
    case mapget::GeomType::GltfNodeIndex:
        break;
    }

    if (rule.hasLabel() && !transformed.points_.empty()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
            appendLabel(
                projectWgsPoint(geometryCenter(transformed)),
                text,
                rule,
                pick);
        }
    }
    return !projected.empty();
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
    if (!color || rule.width(evalFun) <= 0.0f) {
        return false;
    }

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

    std::vector<mapget::Point> projected;
    projected.reserve(source.points_.size() * 2);
    std::unordered_set<std::string> occupiedSegments;
    auto appendDistinct = [&](mapget::Point const& point) {
        if (projected.empty() ||
            projected.back().distanceTo(point) > 1.0e-6)
        {
            projected.push_back(point);
        }
    };
    for (size_t index = 1; index < source.points_.size(); ++index) {
        auto const& first = source.points_[index - 1];
        auto const& second = source.points_[index];
        if (first.distanceTo(second) <= 1.0e-9) {
            continue;
        }
        auto key = segmentKey(first, second);
        auto const slot = attributeOffsetSlotsBySegment_[key];
        auto transformed = applyPresentationTransform(
            mapget::SelfContainedGeometry{
                {first, second},
                {},
                mapget::GeomType::Line,
            },
            rule,
            rule.offset() +
                rule.offsetIncrement() *
                    static_cast<double>(slot));
        if (transformed.points_.size() != 2) {
            continue;
        }
        appendDistinct(projectWgsPoint(transformed.points_[0]));
        appendDistinct(projectWgsPoint(transformed.points_[1]));
        occupiedSegments.insert(std::move(key));
    }
    if (projected.size() < 2) {
        return false;
    }
    appendPath(projected, rule, evalFun, *color, pick);
    for (auto const& key : occupiedSegments) {
        ++attributeOffsetSlotsBySegment_[key];
    }
    if (rule.hasLabel()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
            appendLabel(
                projectWgsPoint(geometryCenter(source)),
                text,
                rule,
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
        appendPath(projected, rule, evalFun, *color, pick);
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
    buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
    buffers.featureAddresses.push_back(pick);
    ++vertexCount_;
}

void TileSubsetLayerRenderer::appendSurface(
    std::vector<mapget::Point> const& points,
    std::vector<uint32_t> const& ringStarts,
    FeatureStyleRule const& rule,
    glm::fvec4 const& color,
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
    buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
    buffers.featureAddresses.push_back(pick);
    buffers.startIndices.push_back(
        static_cast<uint32_t>(buffers.positions.size() / 3));
    vertexCount_ += static_cast<uint32_t>(points.size());
}

void TileSubsetLayerRenderer::appendMesh(
    std::vector<mapget::Point> const& points,
    FeatureStyleRule const& rule,
    glm::fvec4 const& color,
    uint32_t pick)
{
    for (size_t index = 0; index + 2 < points.size(); index += 3) {
        appendSurface(
            {points[index], points[index + 1], points[index + 2]},
            {},
            rule,
            color,
            pick);
    }
}

void TileSubsetLayerRenderer::appendPath(
    std::vector<mapget::Point> const& points,
    FeatureStyleRule const& rule,
    BoundEvalFun const& evalFun,
    glm::fvec4 const& color,
    uint32_t pick)
{
    auto const width =
        std::max(0.0f, rule.width(evalFun));
    if (points.size() < 2 || width <= 0.0f) {
        return;
    }
    auto& buffers = rule.billboard().value_or(false)
        ? buffers_.pathBillboard
        : buffers_.pathWorld;
    auto const dashed = rule.isDashed();
    auto const dashLength =
        static_cast<float>(std::max(1, rule.dashLength()));
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
        buffers.widths.push_back(width);
        buffers.dashArrays.push_back(dashed ? dashLength : 1.0f);
        buffers.dashArrays.push_back(dashed ? dashLength : 0.0f);
    }
    buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
    buffers.featureAddresses.push_back(pick);
    buffers.startIndices.push_back(
        static_cast<uint32_t>(buffers.positions.size() / 3));
    vertexCount_ += static_cast<uint32_t>(points.size());

    auto const arrow = rule.arrow(evalFun);
    if (arrow == FeatureStyleRule::ForwardArrow ||
        arrow == FeatureStyleRule::DoubleArrow)
    {
        appendArrowHead(
            points.back(),
            points[points.size() - 2],
            rule,
            width,
            color,
            pick);
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
            pick);
    }
}

void TileSubsetLayerRenderer::appendArrowHead(
    mapget::Point const& tip,
    mapget::Point const& previous,
    FeatureStyleRule const& rule,
    float width,
    glm::fvec4 const& color,
    uint32_t pick)
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
    }
    buffers.depthTests.push_back(rule.depthTest() ? 1U : 0U);
    buffers.featureAddresses.push_back(pick);
    buffers.startIndices.push_back(
        static_cast<uint32_t>(buffers.positions.size() / 3));
    vertexCount_ += 3;
}

void TileSubsetLayerRenderer::appendAabb(
    mapget::Point const& origin,
    mapget::Point const& size,
    FeatureStyleRule const& rule,
    glm::fvec4 const& color,
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
    uint32_t pick)
{
    auto params = JsValue::Dict({
        {"featureAddress", JsValue(pick)},
        {"position", JsValue::Dict({
            {"x", JsValue(point.x)},
            {"y", JsValue(point.y)},
            {"z", JsValue(point.z)},
        })},
        {"text", JsValue(text)},
        {"fillColor", rgbaBytes(rule.labelColor())},
        {"outlineColor", rgbaBytes(rule.labelOutlineColor())},
        {"outlineWidth", JsValue(rule.labelOutlineWidth())},
        {"scale", JsValue(rule.labelScale())},
        {"billboard", JsValue(rule.billboard().value_or(true))},
        {"depthTest", JsValue(rule.depthTest())},
    });
    if (rule.showBackground()) {
        params.set(
            "backgroundColor",
            rgbaBytes(rule.labelBackgroundColor()));
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
