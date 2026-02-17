#pragma once

#include <cstdint>
#include <deque>
#include <map>
#include <set>
#include <tuple>
#include <vector>

#include "cesium-interface/cesium-billboards.h"
#include "cesium-interface/cesium-labels.h"
#include "cesium-interface/cesium-points.h"
#include "cesium-interface/cesium-primitive.h"
#include "visualization-base.h"

namespace erdblick
{

class CesiumFeatureLayerVisualization;

/**
 * Covers the state for the visualization of a single Relation-Style+Feature
 * combination. For recursive relations, this state may contain references to
 * features in other tiles, which are resolved using the externalReferences()...
 * ->processExternalReferences() communications.
 */
struct RecursiveRelationVisualizationState
{
    RecursiveRelationVisualizationState(
        FeatureStyleRule const& rule,
        mapget::model_ptr<mapget::Feature> f,
        CesiumFeatureLayerVisualization& visu);

    FeatureStyleRule const& rule_;
    CesiumFeatureLayerVisualization& visu_;

    struct RelationToVisualize
    {
        mapget::model_ptr<mapget::Relation> relation_;
        mapget::model_ptr<mapget::Feature> sourceFeature_;
        mapget::model_ptr<mapget::Feature> targetFeature_;
        bool twoway_ = false;
        bool rendered_ = false;

        [[nodiscard]] bool readyToRender() const;
    };

    // Keep track of which features provide which relations.
    std::map<std::string, std::deque<RelationToVisualize>> relationsByFeatureId_;

    // Keep track of features we still want to explore recursively.
    std::deque<mapget::model_ptr<mapget::Feature>> unexploredRelations_;

    // Ensure that sourceStyle, targetStyle and endMarkerStyle
    // are only ever applied once for each feature.
    std::set<std::string> visualizedFeatures_;

    void populateAndRender(bool onlyUpdateTwowayFlags = false);

    void addRelation(
        const mapget::model_ptr<mapget::Feature>& sourceFeature,
        mapget::model_ptr<mapget::Relation> const& relation,
        bool onlyUpdateTwowayFlags);

    void render(RelationToVisualize& r);
};

/**
 * Cesium Primitive Conversion for a TileFeatureLayer using a style.
 */
class CesiumFeatureLayerVisualization : public FeatureLayerVisualizationBase
{
    friend struct RecursiveRelationVisualizationState;

public:
    /**
     * Convert a TileFeatureLayer into Cesium primitives based on the provided style.
     */
    CesiumFeatureLayerVisualization(
        int viewIndex,
        std::string const& mapTileKey,
        const FeatureLayerStyle& style,
        NativeJsValue const& rawOptionValues,
        NativeJsValue const& rawFeatureMergeService,
        FeatureStyleRule::HighlightMode const& highlightMode = FeatureStyleRule::NoHighlight,
        NativeJsValue const& rawFeatureIdSubset = {});

    /**
     * Destructor for memory diagnostics.
     */
    ~CesiumFeatureLayerVisualization();

    /**
     * Add a tile which is considered for visualization. All tiles added after
     * the first one are only considered to resolve external relations.
     */
    void addTileFeatureLayer(TileFeatureLayer const& tile);

    /**
     * Run visualization for the added tile feature layers.
     */
    void run() override;

    /**
     * Returns a list of external references, which must be resolved.
     * The list contains Requests, where each Request object has these fields:
     * - `typeId: <A feature type>`
     * - `featureId: [<ext-id-part-field, ext-id-part-value, ...>]`
     *
     * This is called by visualization.ts, which then runs a /locate
     * call. The result is fed into processResolvedExternalReferences().
     */
    [[nodiscard]] NativeJsValue externalReferences();

    /**
     * Supply a list of resolved external references, corresponding to the
     * externalReferences() list from the above function.
     *
     * Each entry in the list consists of a list of Resolution objects.
     * Resolution list at index i corresponds to Request object at index i (above).
     * Each Resolution object has these fields:
     * - `tileId: <MapTileKey>`
     * - `typeId: <A feature type>`
     * - `featureId: [<id-part-field, id-part-value, ...>]`.
     */
    void processResolvedExternalReferences(NativeJsValue const& extRefsResolvedNative);

    /**
     * Returns all non-empty Cesium primitives which resulted from
     * the given TileFeatureLayer conversion, in one PrimitiveCollection.
     */
    [[nodiscard]] NativeJsValue primitiveCollection() const;

    /**
     * Returns all merged point features as a dict form mapLayerStyleRuleId
     * to MergedPointVisualization primitives.
     */
    [[nodiscard]] NativeJsValue mergedPointFeatures() const;

private:
    mapget::Point projectWgsPoint(
        mapget::Point const& wgsPoint,
        glm::dvec3 const& wgsOffset) const override;

    std::string makeMapLayerStyleRuleId(uint32_t ruleIndex) const override;
    void onRelationStyle(
        mapget::model_ptr<mapget::Feature>& feature,
        BoundEvalFun& evalFun,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId) override;
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
    void emitLabel(
        JsValue const& xyzPos,
        std::string const& text,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    void emitSolidPolyLine(
        JsValue const& jsVerts,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    void emitDashedPolyLine(
        JsValue const& jsVerts,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun) override;
    void emitArrowPolyLine(
        JsValue const& jsVerts,
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

    /**
     * Get an initialised primitive for a particular PolylineDashMaterialAppearance.
     */
    CesiumPrimitive&
    getPrimitiveForDashMaterial(const FeatureStyleRule& rule, BoundEvalFun& evalFun);

    /**
     * Get an initialised primitive for a particular PolylineArrowMaterialAppearance.
     */
    CesiumPrimitive&
    getPrimitiveForArrowMaterial(const FeatureStyleRule& rule, BoundEvalFun& evalFun);

    CesiumPrimitive coloredLines_;
    std::map<std::tuple<uint32_t, uint32_t, uint32_t, uint32_t>, CesiumPrimitive> dashLines_;
    std::map<uint32_t, CesiumPrimitive> arrowLines_;
    CesiumPrimitive coloredNontrivialMeshes_;
    CesiumPrimitive coloredTrivialMeshes_;
    CesiumPrimitive coloredGroundLines_;
    std::map<std::tuple<uint32_t, uint32_t, uint32_t, uint32_t>, CesiumPrimitive> dashGroundLines_;
    std::map<uint32_t, CesiumPrimitive> arrowGroundLines_;
    CesiumPrimitive coloredGroundMeshes_;
    CesiumPointPrimitiveCollection coloredPoints_;
    CesiumLabelCollection labelCollection_;
    CesiumBillboardCollection billboardCollection_;

    /// ===== Relation Processing Members =====

    JsValue externalRelationReferences_;
    std::vector<std::pair<
        RecursiveRelationVisualizationState*,
        RecursiveRelationVisualizationState::RelationToVisualize*>>
        externalRelationVisualizations_;
    std::deque<RecursiveRelationVisualizationState> relationStyleState_;
};

}  // namespace erdblick
