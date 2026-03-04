#pragma once

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
        int maxLowFiLod = -1,
        int geometryOutputMode = static_cast<int>(GeometryOutputMode::All),
        NativeJsValue const& rawFeatureIdSubset = {});
    ~DeckFeatureLayerVisualization() override;

    [[nodiscard]] uint32_t abiVersion() const;
    void setGeometryOutputMode(int mode);
    [[nodiscard]] int geometryOutputMode() const;
    void addTileFeatureLayer(TileFeatureLayer const& tile);

    void pointPositionsRaw(SharedUint8Array& out) const;
    void pointColorsRaw(SharedUint8Array& out) const;
    void pointRadiiRaw(SharedUint8Array& out) const;
    void pointFeatureStartRaw(SharedUint8Array& out) const;
    void pointFeatureIdsRaw(SharedUint8Array& out) const;

    void pathPositionsRaw(SharedUint8Array& out) const;
    void pathStartIndicesRaw(SharedUint8Array& out) const;
    void pathColorsRaw(SharedUint8Array& out) const;
    void pathWidthsRaw(SharedUint8Array& out) const;
    void pathFeatureStartRaw(SharedUint8Array& out) const;
    void pathFeatureIdsRaw(SharedUint8Array& out) const;
    void pathDashArrayRaw(SharedUint8Array& out) const;
    void pathDashOffsetsRaw(SharedUint8Array& out) const;
    void pathCoordinateOriginRaw(SharedUint8Array& out) const;
    void arrowPositionsRaw(SharedUint8Array& out) const;
    void arrowStartIndicesRaw(SharedUint8Array& out) const;
    void arrowColorsRaw(SharedUint8Array& out) const;
    void arrowWidthsRaw(SharedUint8Array& out) const;
    void arrowFeatureStartRaw(SharedUint8Array& out) const;
    void arrowFeatureIdsRaw(SharedUint8Array& out) const;
    [[nodiscard]] NativeJsValue mergedPointFeatures() const;

private:
    mapget::Point projectWgsPoint(
        mapget::Point const& wgsPoint,
        glm::dvec3 const& wgsOffset) const override;
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

    std::vector<float> pointPositionsBuffer_;
    std::vector<uint8_t> pointColorsBuffer_;
    std::vector<float> pointRadiiBuffer_;
    std::vector<uint32_t> pointFeatureStartBuffer_;
    std::vector<uint32_t> pointFeatureIdsBuffer_;
    std::vector<float> pathPositionsBuffer_;
    std::vector<uint32_t> pathStartIndicesBuffer_;
    std::vector<uint8_t> pathColorsBuffer_;
    std::vector<float> pathWidthsBuffer_;
    std::vector<uint32_t> pathFeatureStartBuffer_;
    std::vector<uint32_t> pathFeatureIdsBuffer_;
    std::vector<float> pathDashArrayBuffer_;
    std::vector<float> pathDashOffsetsBuffer_;
    std::vector<float> arrowPositionsBuffer_;
    std::vector<uint32_t> arrowStartIndicesBuffer_;
    std::vector<uint8_t> arrowColorsBuffer_;
    std::vector<float> arrowWidthsBuffer_;
    std::vector<uint32_t> arrowFeatureStartBuffer_;
    std::vector<uint32_t> arrowFeatureIdsBuffer_;
    mutable bool hasPathCoordinateOriginWgs_ = false;
    mutable mapget::Point pathCoordinateOriginWgs_ = {.0, .0, .0};
};

}  // namespace erdblick
