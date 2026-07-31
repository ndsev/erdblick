#pragma once

#include "layer.h"
#include "style.h"

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace erdblick
{

/**
 * Deck-buffer renderer for immutable, server-evaluated TileSubsetLayers.
 *
 * The renderer performs no SIMFIL compilation or full-feature traversal. It
 * binds style expression strings to the projected scalar columns of each
 * channel, applies the remaining client-owned rule-tree semantics, and emits
 * renderer-local picking references.
 */
class TileSubsetLayerRenderer
{
public:
    TileSubsetLayerRenderer(
        int viewIndex,
        std::string const& mapTileKey,
        FeatureLayerStyle const& style,
        int highlightMode,
        int fidelity);
    ~TileSubsetLayerRenderer();

    [[nodiscard]] uint32_t abiVersion() const;
    void setCoordinateOrigin(
        double longitude,
        double latitude,
        double altitude);
    void addTileSubsetLayer(TileSubsetLayer const& subset);
    void run();
    [[nodiscard]] NativeJsValue renderResult() const;
    [[nodiscard]] NativeJsValue runtimeStyleIssues() const;
    [[nodiscard]] uint32_t vertexCount() const;

    struct PointBuffers {
        std::vector<float> positions;
        std::vector<uint8_t> colors;
        std::vector<float> radii;
        std::vector<uint8_t> depthTests;
        std::vector<uint32_t> featureAddresses;
    };

    struct SurfaceBuffers {
        std::vector<float> positions;
        std::vector<uint32_t> startIndices;
        std::vector<uint32_t> holeIndices;
        std::vector<uint32_t> holeIndexStarts;
        std::vector<uint8_t> colors;
        std::vector<uint8_t> depthTests;
        std::vector<uint32_t> featureAddresses;
    };

    struct PathBuffers {
        std::vector<float> positions;
        std::vector<uint32_t> startIndices;
        std::vector<uint8_t> colors;
        std::vector<float> widths;
        std::vector<uint8_t> depthTests;
        std::vector<uint32_t> featureAddresses;
        std::vector<float> dashArrays;
    };

    struct GltfBuffers {
        std::vector<uint32_t> nodeIndices;
        std::vector<uint8_t> colors;
        std::vector<uint8_t> depthTests;
        std::vector<uint32_t> featureAddresses;
    };

    struct GltfPickProxyBuffers {
        std::vector<float> positions;
        std::vector<uint32_t> startIndices;
        std::vector<uint32_t> nodeIndices;
        std::vector<uint32_t> featureAddresses;
    };

    struct GeometryBuffers {
        PointBuffers pointWorld;
        PointBuffers pointBillboard;
        std::vector<JsValue> labelWorld;
        std::vector<JsValue> labelBillboard;
        SurfaceBuffers surfaces;
        PathBuffers pathWorld;
        PathBuffers pathBillboard;
        PathBuffers arrowWorld;
        PathBuffers arrowBillboard;
        GltfBuffers gltfNodes;
        GltfPickProxyBuffers gltfPickProxies;
    };

private:
    struct ChannelBinding {
        FeatureStyleRule const* rule = nullptr;
        std::vector<std::string> featureFields;
        std::vector<std::string> entryFields;
    };

    struct RuntimeIssue {
        std::string property;
        std::string expression;
        std::string message;
        uint32_t ruleIndex = 0;
        uint64_t occurrenceCount = 1;
    };

    struct PickRef {
        uint32_t subsetOrdinal = 0;
        uint32_t channelOrdinal = 0;
        uint32_t entryOrdinal = 0;
        uint32_t endpointRole = 0;

        bool operator==(PickRef const&) const = default;
    };

    struct PickRefHash {
        size_t operator()(PickRef const& value) const noexcept;
    };

    struct PickResult {
        uint32_t subsetOrdinal = 0;
        std::string featureId;
        std::optional<uint32_t> attributeIndex;
        std::optional<bool> hasValidity;
        uint32_t validityIndex = 0;
        std::string relationId;
        std::string relationSourceFeatureId;
        std::optional<uint32_t> relationIndex;
        std::vector<std::string> memberFeatureIds;
    };

    [[nodiscard]] ChannelBinding bindingFor(
        mapget::model_ptr<mapget::TileSubsetChannel> const& channel);
    [[nodiscard]] FeatureStyleRule const* ruleForChannel(
        std::string const& channelId) const;

    void renderFeature(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        ChannelBinding const& binding,
        mapget::model_ptr<mapget::FeatureEntry> const& entry);
    void renderAttribute(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        ChannelBinding const& binding,
        mapget::model_ptr<mapget::AttributeValidityEntry> const& entry);
    void renderGroup(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        ChannelBinding const& binding,
        mapget::model_ptr<mapget::GroupEntry> const& entry);
    void renderRelation(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        ChannelBinding const& binding,
        mapget::model_ptr<mapget::RelationEntry> const& entry);

    bool renderGeometryCollection(
        mapget::model_ptr<mapget::GeometryCollection> const& geometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex,
        glm::dvec3 const& offset);
    bool renderGeometry(
        mapget::model_ptr<mapget::Geometry> const& geometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex,
        glm::dvec3 const& offset);
    bool renderSegmentStackedLine(
        mapget::model_ptr<mapget::Geometry> const& geometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex,
        std::string const& stackPrefix);
    void renderRelationLine(
        mapget::model_ptr<mapget::GeometryCollection> const& sourceGeometry,
        mapget::model_ptr<mapget::GeometryCollection> const& targetGeometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex);

    [[nodiscard]] BoundEvalFun makeEvalFun(
        std::vector<std::string> const& fields,
        mapget::model_ptr<mapget::Array> const& values);
    [[nodiscard]] uint32_t pickIndex(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        uint32_t endpointRole,
        bool selectable,
        PickResult result);
    [[nodiscard]] static PickResult pickResult(
        mapget::model_ptr<mapget::FeatureEntry> const& entry);
    [[nodiscard]] static PickResult pickResult(
        mapget::model_ptr<mapget::AttributeValidityEntry> const& entry);
    [[nodiscard]] static PickResult pickResult(
        mapget::model_ptr<mapget::GroupEntry> const& entry);
    [[nodiscard]] static PickResult pickResult(
        mapget::model_ptr<mapget::RelationEntry> const& entry,
        uint32_t endpointRole);
    void recordRuntimeIssue(
        std::string const& property,
        std::string const& expression,
        std::string const& message,
        uint32_t ruleIndex);

    [[nodiscard]] mapget::Point projectWgsPoint(
        mapget::Point const& wgsPoint) const;
    [[nodiscard]] JsValue coordinateOriginToJs() const;
    [[nodiscard]] JsValue pickRefsToJs() const;
    [[nodiscard]] JsValue pickResultsToJs() const;
    [[nodiscard]] JsValue subsetVertexCountsToJs() const;

    void appendPoint(
        mapget::Point const& point,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        uint32_t pickIndex);
    void appendSurface(
        std::vector<mapget::Point> const& points,
        std::vector<uint32_t> const& ringStarts,
        FeatureStyleRule const& rule,
        glm::fvec4 const& color,
        uint32_t pickIndex);
    void appendMesh(
        std::vector<mapget::Point> const& points,
        FeatureStyleRule const& rule,
        glm::fvec4 const& color,
        uint32_t pickIndex);
    void appendPath(
        std::vector<mapget::Point> const& points,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        uint32_t pickIndex);
    void appendArrowHead(
        mapget::Point const& tip,
        mapget::Point const& previous,
        FeatureStyleRule const& rule,
        float width,
        glm::fvec4 const& color,
        uint32_t pickIndex);
    void appendAabb(
        mapget::Point const& origin,
        mapget::Point const& size,
        FeatureStyleRule const& rule,
        glm::fvec4 const& color,
        uint32_t pickIndex);
    void appendGltf(
        mapget::model_ptr<mapget::Geometry> const& geometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex);
    void appendLabel(
        mapget::Point const& point,
        std::string const& text,
        FeatureStyleRule const& rule,
        uint32_t pickIndex);

    [[nodiscard]] static JsValue geometryBuffersToJs(
        GeometryBuffers const& buffers);
    [[nodiscard]] static uint8_t toColorByte(float value);

    FeatureLayerStyle const& style_;
    FeatureStyleRule::HighlightMode highlightMode_;
    FeatureStyleRule::Fidelity fidelity_;
    std::vector<mapget::TileSubsetLayer::Ptr> subsets_;
    GeometryBuffers buffers_;
    uint32_t vertexCount_ = 0;

    std::vector<PickRef> pickRefs_;
    std::vector<PickResult> pickResults_;
    std::vector<uint32_t> subsetVertexCounts_;
    std::unordered_map<PickRef, uint32_t, PickRefHash> pickIndices_;
    std::vector<RuntimeIssue> runtimeIssues_;
    std::unordered_map<std::string, size_t> runtimeIssueIndices_;
    std::unordered_set<std::string> renderedRelationEndpointParts_;
    std::unordered_map<uint32_t, uint32_t> featureOffsetSlotsByRule_;
    std::unordered_map<std::string, uint32_t>
        attributeOffsetSlotsByFeature_;
    std::unordered_map<std::string, uint32_t>
        attributeOffsetSlotsBySegment_;

    mutable bool hasCoordinateOriginWgs_ = false;
    mutable mapget::Point coordinateOriginWgs_{0.0, 0.0, 0.0};
    uint32_t currentSubsetOrdinal_ = 0;
};

} // namespace erdblick
