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
    ~DeckFeatureLayerVisualization() override;

    [[nodiscard]] uint32_t abiVersion() const;
    void setGeometryOutputMode(int mode);
    [[nodiscard]] int geometryOutputMode() const;
    void addTileFeatureLayer(TileFeatureLayer const& tile);
    [[nodiscard]] NativeJsValue renderResult() const;
    [[nodiscard]] NativeJsValue mergedPointFeatures() const;
    [[nodiscard]] NativeJsValue externalRelationReferences() const;
    void processResolvedExternalReferences(NativeJsValue const& resolvedReferences);

private:
    mapget::Point projectWgsPoint(
        mapget::Point const& wgsPoint,
        glm::dvec3 const& wgsOffset) const override;
    void onFeatureForRendering(mapget::Feature const& feature) override;
    [[nodiscard]] bool bypassLowFiMaxLodFilter() const override;
    std::string makeMapLayerStyleRuleId(uint32_t ruleIndex) const override;
    void emitPoint(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    void emitPolygon(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    void emitMesh(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    void emitIcon(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    JsValue makeMergedPointPointParams(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    JsValue makeMergedPointIconParams(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    JsValue makeMergedPointLabelParams(
        JsValue const& xyzPos,
        std::string const& text,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    void appendPointGeometry(
        mapget::Point const& pointCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    void appendSurfaceGeometry(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    void addPolyLine(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    [[nodiscard]] bool includesPointLikeGeometry() const override;
    [[nodiscard]] bool includesNonPointGeometry() const override;
    void appendPathGeometry(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        float width,
        BoundEvalFun& evalFun,
        bool enableDash);
    void appendArrowGeometry(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        float width,
        BoundEvalFun& evalFun);
    void appendArrowHeadForSegment(
        mapget::Point const& tip,
        mapget::Point const& previous,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        float width,
        BoundEvalFun& evalFun);
    [[nodiscard]] static bool resolvePointBillboard(FeatureStyleRule const& rule);
    [[nodiscard]] static bool resolvePathBillboard(FeatureStyleRule const& rule);
    [[nodiscard]] static bool resolveIconBillboard(FeatureStyleRule const& rule);
    [[nodiscard]] static bool resolveLabelBillboard(FeatureStyleRule const& rule);
    static std::uint8_t toColorByte(float value);
    [[nodiscard]] bool lowFiBundleModeEnabled() const;
    [[nodiscard]] bool emitToAggregateForCurrentFeatureLod() const;
    [[nodiscard]] uint8_t activeLodBucket() const;
public:
    struct PointBuffers {
        std::vector<float> positions;
        std::vector<uint8_t> colors;
        std::vector<float> radii;
        std::vector<uint32_t> featureIds;
    };
    struct SurfaceBuffers {
        std::vector<float> surfacePositions;
        std::vector<uint32_t> surfaceStartIndices;
        std::vector<uint8_t> surfaceColors;
        std::vector<uint32_t> surfaceFeatureIds;
    };
    struct PathBuffers {
        std::vector<float> positions;
        std::vector<uint32_t> startIndices;
        std::vector<uint8_t> colors;
        std::vector<float> widths;
        std::vector<uint32_t> featureIds;
        std::vector<float> dashArray;
    };
    struct GeometryBuffers {
        PointBuffers pointWorld;
        PointBuffers pointBillboard;
        SurfaceBuffers surfaces;
        PathBuffers pathWorld;
        PathBuffers pathBillboard;
        PathBuffers arrowWorld;
        PathBuffers arrowBillboard;
    };
private:
    [[nodiscard]] static bool hasGeometry(PointBuffers const& buffers);
    [[nodiscard]] static bool hasGeometry(SurfaceBuffers const& buffers);
    [[nodiscard]] static bool hasGeometry(PathBuffers const& buffers);
    [[nodiscard]] static bool hasGeometry(GeometryBuffers const& buffers);
    [[nodiscard]] bool hasLowFiGeometryForLod(size_t lod) const;
    GeometryBuffers& lowFiBuffersForLod(size_t lod);
    [[nodiscard]] static JsValue pointBuffersToJs(PointBuffers const& buffers);
    [[nodiscard]] static JsValue surfaceBuffersToJs(SurfaceBuffers const& buffers);
    [[nodiscard]] static JsValue pathBuffersToJs(PathBuffers const& buffers, bool withDashArrays);
    [[nodiscard]] static JsValue geometryBuffersToJs(GeometryBuffers const& buffers);
    [[nodiscard]] JsValue coordinateOriginToJs() const;
    [[nodiscard]] JsValue lowFiBundleResultsToJs() const;

    GeometryBuffers aggregateBuffers_;
    std::array<GeometryBuffers, 8> lowFiLodBuffers_;
    uint8_t activeFeatureLod_ = 0;
    mutable bool hasPathCoordinateOriginWgs_ = false;
    mutable mapget::Point pathCoordinateOriginWgs_ = {.0, .0, .0};
};

}  // namespace erdblick
