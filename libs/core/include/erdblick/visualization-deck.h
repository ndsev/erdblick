#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "buffer.h"
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
    void setLowFiOutputLod(int lod);
    void availableLowFiLodsRaw(SharedUint8Array& out) const;
    void addTileFeatureLayer(TileFeatureLayer const& tile);

    void pointPositionsRaw(SharedUint8Array& out) const;
    void pointColorsRaw(SharedUint8Array& out) const;
    void pointRadiiRaw(SharedUint8Array& out) const;
    void pointFeatureIdsRaw(SharedUint8Array& out) const;

    void pathPositionsRaw(SharedUint8Array& out) const;
    void pathStartIndicesRaw(SharedUint8Array& out) const;
    void pathColorsRaw(SharedUint8Array& out) const;
    void pathWidthsRaw(SharedUint8Array& out) const;
    void pathFeatureIdsRaw(SharedUint8Array& out) const;
    void pathDashArrayRaw(SharedUint8Array& out) const;
    void pathDashOffsetsRaw(SharedUint8Array& out) const;
    void pathCoordinateOriginRaw(SharedUint8Array& out) const;
    void arrowPositionsRaw(SharedUint8Array& out) const;
    void arrowStartIndicesRaw(SharedUint8Array& out) const;
    void arrowColorsRaw(SharedUint8Array& out) const;
    void arrowWidthsRaw(SharedUint8Array& out) const;
    void arrowFeatureIdsRaw(SharedUint8Array& out) const;
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
    static std::uint8_t toColorByte(float value);
    [[nodiscard]] bool lowFiBundleModeEnabled() const;
    [[nodiscard]] bool emitToAggregateForCurrentFeatureLod() const;
    [[nodiscard]] uint8_t activeLodBucket() const;
    struct GeometryBuffers {
        std::vector<float> pointPositions;
        std::vector<uint8_t> pointColors;
        std::vector<float> pointRadii;
        std::vector<uint32_t> pointFeatureIds;
        std::vector<float> pathPositions;
        std::vector<uint32_t> pathStartIndices;
        std::vector<uint8_t> pathColors;
        std::vector<float> pathWidths;
        std::vector<uint32_t> pathFeatureIds;
        std::vector<float> pathDashArray;
        std::vector<float> pathDashOffsets;
        std::vector<float> arrowPositions;
        std::vector<uint32_t> arrowStartIndices;
        std::vector<uint8_t> arrowColors;
        std::vector<float> arrowWidths;
        std::vector<uint32_t> arrowFeatureIds;
    };
    [[nodiscard]] static bool hasGeometry(GeometryBuffers const& buffers);
    [[nodiscard]] const GeometryBuffers* selectedLowFiBuffers() const;
    [[nodiscard]] bool hasLowFiGeometryForLod(size_t lod) const;
    GeometryBuffers& lowFiBuffersForLod(size_t lod);

    GeometryBuffers aggregateBuffers_;
    std::array<GeometryBuffers, 8> lowFiLodBuffers_;
    uint8_t activeFeatureLod_ = 0;
    int selectedLowFiOutputLod_ = -1;
    mutable bool hasPathCoordinateOriginWgs_ = false;
    mutable mapget::Point pathCoordinateOriginWgs_ = {.0, .0, .0};
};

}  // namespace erdblick
