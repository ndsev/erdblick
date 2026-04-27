#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "visualization-base.h"

namespace erdblick
{

/**
 * Deck ABI v1 visualization scaffold.
 * This class exposes raw SharedUint8Array accessors used by the deck renderer path.
 */
class DeckFeatureLayerVisualization : public FeatureLayerVisualizationBase
{
public:
    using GeometryOutputMode = FeatureLayerVisualizationBase::GeometryOutputMode;

    /** Initialize deck-oriented geometry buffers for one map tile/style combination. */
    DeckFeatureLayerVisualization(
        int viewIndex,
        std::string const& mapTileKey,
        const FeatureLayerStyle& style,
        NativeJsValue const& rawOptionValues,
        NativeJsValue const& rawFeatureMergeService,
        FeatureStyleRule::HighlightMode const& highlightMode = FeatureStyleRule::NoHighlight,
        FeatureStyleRule::Fidelity fidelity = FeatureStyleRule::AnyFidelity,
        int highFidelityStage = 0,
        int maxLowFiLod = -1,
        int geometryOutputMode = static_cast<int>(GeometryOutputMode::All),
        NativeJsValue const& rawFeatureIdSubset = {});
    /** Finalize and release any accumulated geometry buffers. */
    ~DeckFeatureLayerVisualization() override;

    /** Return the deck renderer ABI version expected by the frontend worker. */
    [[nodiscard]] uint32_t abiVersion() const;
    /** Switch between full, point-only, and non-point-only emission modes. */
    void setGeometryOutputMode(int mode);
    /** Return the currently configured geometry-output mode. */
    [[nodiscard]] int geometryOutputMode() const;
    /** Add a parsed tile layer and seed any deck-specific aggregation state. */
    void addTileFeatureLayer(TileFeatureLayer const& tile);
    /** Materialize all accumulated buffers as the JS payload consumed by the deck worker. */
    [[nodiscard]] NativeJsValue renderResult() const;
    /** Return the merge-service payload for point aggregation. */
    [[nodiscard]] NativeJsValue mergedPointFeatures() const;
    /** Return unresolved external relation references collected during rendering. */
    [[nodiscard]] NativeJsValue externalRelationReferences() const;
    /** Resolve previously deferred external relation targets and finish rendering them. */
    void processResolvedExternalReferences(NativeJsValue const& resolvedReferences);

private:
    /** Convert WGS84 positions to the point format expected by deck geometry buffers. */
    mapget::Point projectWgsPoint(
        mapget::Point const& wgsPoint) const override;
    /** Track per-feature LOD state before the base class emits geometry. */
    void onFeatureForRendering(mapget::Feature const& feature) override;
    /** Keep low-fi bundle generation alive even when the base class would normally cull it. */
    [[nodiscard]] bool bypassLowFiMaxLodFilter() const override;
    /** Prefix rule ids with deck-specific render-pass information. */
    std::string makeMapLayerStyleRuleId(uint32_t ruleIndex) const override;
    /** Append one point primitive to the appropriate point buffer. */
    void emitPoint(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Append one polygon primitive to the surface buffers. */
    void emitPolygon(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Append one mesh primitive to the surface buffers. */
    void emitMesh(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Append one GLTF-backed node reference to the deck GLTF buffers. */
    void emitGltfNode(
        uint32_t nodeIndex,
        mapget::Point const& aabbOriginWgs,
        mapget::Point const& aabbSizeWgs,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Append one icon descriptor to the point/icon buffers. */
    void emitIcon(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Append one label descriptor to the label buffers. */
    void emitLabel(
        JsValue const& xyzPos,
        std::string const& text,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Build merged-point payload for point geometries in deck format. */
    JsValue makeMergedPointPointParams(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Build merged-point payload for icon geometries in deck format. */
    JsValue makeMergedPointIconParams(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Build merged-point payload for label geometries in deck format. */
    JsValue makeMergedPointLabelParams(
        JsValue const& xyzPos,
        std::string const& text,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Append one point primitive after choosing world-space vs billboard buffers. */
    void appendPointGeometry(
        mapget::Point const& pointCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Append one polygon or mesh primitive after choosing the correct aggregate buffers. */
    void appendSurfaceGeometry(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Append one path primitive after choosing world-space vs billboard buffers. */
    void addPolyLine(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    /** Report whether the current output mode needs point-like buffers. */
    [[nodiscard]] bool includesPointLikeGeometry() const override;
    /** Report whether the current output mode needs line or surface buffers. */
    [[nodiscard]] bool includesNonPointGeometry() const override;
    /** Append one path and its per-path attributes to the chosen deck path buffer. */
    void appendPathGeometry(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        float width,
        BoundEvalFun& evalFun,
        bool enableDash);
    /** Append arrow shafts and heads for one styled path. */
    void appendArrowGeometry(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        float width,
        BoundEvalFun& evalFun);
    /** Append the arrow head geometry for a single terminal segment. */
    void appendArrowHeadForSegment(
        mapget::Point const& tip,
        mapget::Point const& previous,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        float width,
        BoundEvalFun& evalFun);
    /** Resolve the effective billboard mode for point rendering. */
    [[nodiscard]] static bool resolvePointBillboard(FeatureStyleRule const& rule);
    /** Resolve the effective billboard mode for path rendering. */
    [[nodiscard]] static bool resolvePathBillboard(FeatureStyleRule const& rule);
    /** Resolve the effective billboard mode for icons. */
    [[nodiscard]] static bool resolveIconBillboard(FeatureStyleRule const& rule);
    /** Resolve the effective billboard mode for labels. */
    [[nodiscard]] static bool resolveLabelBillboard(FeatureStyleRule const& rule);
    /** Clamp a normalized float color component into an 8-bit deck buffer value. */
    static std::uint8_t toColorByte(float value);
    /** Report whether low-fi bundle generation is enabled for this render pass. */
    [[nodiscard]] bool lowFiBundleModeEnabled() const;
    /** Report whether geometry should be emitted into the aggregate buffers right now. */
    [[nodiscard]] bool emitToAggregateForCurrentFeatureLod() const;
    /** Return the active low-fi LOD bucket for the feature currently being emitted. */
    [[nodiscard]] uint8_t activeLodBucket() const;
public:
    /** Raw deck buffers for point primitives. */
    struct PointBuffers {
        std::vector<float> positions;
        std::vector<uint8_t> colors;
        std::vector<float> radii;
        std::vector<uint8_t> depthTests;
        std::vector<uint32_t> featureAddresses;
    };
    /** Raw deck buffers for polygon and mesh primitives. */
    struct SurfaceBuffers {
        std::vector<float> surfacePositions;
        std::vector<uint32_t> surfaceStartIndices;
        std::vector<uint8_t> surfaceColors;
        std::vector<uint8_t> depthTests;
        std::vector<uint32_t> surfaceFeatureAddresses;
    };
    /** Raw deck buffers for path-like primitives. */
    struct PathBuffers {
        std::vector<float> positions;
        std::vector<uint32_t> startIndices;
        std::vector<uint8_t> colors;
        std::vector<float> widths;
        std::vector<uint8_t> depthTests;
        std::vector<uint32_t> featureAddresses;
        std::vector<float> dashArray;
    };
    /** Raw deck buffers for GLTF-backed node references. */
    struct GltfBuffers {
        std::vector<uint32_t> nodeIndices;
        std::vector<uint8_t> colors;
        std::vector<uint8_t> depthTests;
        std::vector<uint32_t> featureAddresses;
    };
    /** Complete geometry buffer set for one render bucket. */
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
    };
private:
    /** Check whether any point geometry has been appended. */
    [[nodiscard]] static bool hasGeometry(PointBuffers const& buffers);
    /** Check whether any surface geometry has been appended. */
    [[nodiscard]] static bool hasGeometry(SurfaceBuffers const& buffers);
    /** Check whether any path geometry has been appended. */
    [[nodiscard]] static bool hasGeometry(PathBuffers const& buffers);
    /** Check whether any GLTF node references have been appended. */
    [[nodiscard]] static bool hasGeometry(GltfBuffers const& buffers);
    /** Check whether any geometry of any kind has been appended. */
    [[nodiscard]] static bool hasGeometry(GeometryBuffers const& buffers);
    /** Check whether a specific low-fi LOD bucket contains any geometry. */
    [[nodiscard]] bool hasLowFiGeometryForLod(size_t lod) const;
    /** Return the mutable low-fi buffer set for a specific LOD bucket. */
    GeometryBuffers& lowFiBuffersForLod(size_t lod);
    /** Convert point buffers into the JS object expected by the deck worker. */
    [[nodiscard]] static JsValue pointBuffersToJs(PointBuffers const& buffers);
    /** Convert surface buffers into the JS object expected by the deck worker. */
    [[nodiscard]] static JsValue surfaceBuffersToJs(SurfaceBuffers const& buffers);
    /** Convert path buffers into the JS object expected by the deck worker. */
    [[nodiscard]] static JsValue pathBuffersToJs(PathBuffers const& buffers, bool withDashArrays);
    /** Convert GLTF node buffers into the JS object expected by the deck worker. */
    [[nodiscard]] static JsValue gltfBuffersToJs(GltfBuffers const& buffers);
    /** Convert a full geometry buffer set into the JS object expected by the deck worker. */
    [[nodiscard]] static JsValue geometryBuffersToJs(GeometryBuffers const& buffers);
    /** Return the coordinate origin used for path precision-preserving deck buffers. */
    [[nodiscard]] JsValue coordinateOriginToJs() const;
    /** Materialize all low-fi bundle results for deferred frontend use. */
    [[nodiscard]] JsValue lowFiBundleResultsToJs() const;

    GeometryBuffers aggregateBuffers_;
    std::array<GeometryBuffers, 8> lowFiLodBuffers_;
    uint8_t activeFeatureLod_ = 0;
    mutable bool hasPathCoordinateOriginWgs_ = false;
    mutable mapget::Point pathCoordinateOriginWgs_ = {.0, .0, .0};
};

}  // namespace erdblick
