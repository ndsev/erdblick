#pragma once

#include <map>
#include <vector>
#include <unordered_set>
#include "cesium-interface/point-conversion.h"
#include "cesium-interface/points.h"
#include "cesium-interface/primitive.h"
#include "cesium-interface/labels.h"
#include "cesium-interface/billboards.h"
#include "style.h"
#include "simfil/overlay.h"
#include "layer.h"

namespace erdblick
{

class FeatureLayerVisualization;

/**
 * Feature ID which is used when the rendered representation is not
 * supposed to be selectable.
 */
static std::string UnselectableId;

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
        FeatureLayerVisualization& visu);

    FeatureStyleRule const& rule_;
    FeatureLayerVisualization& visu_;

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

    void populateAndRender(bool onlyUpdateTwowayFlags=false);

    void addRelation(
        const mapget::model_ptr<mapget::Feature>& sourceFeature,
        mapget::model_ptr<mapget::Relation> const& relation,
        bool onlyUpdateTwowayFlags);

    void render(RelationToVisualize& r);
};

/**
 * Cesium Primitive Conversion for a TileFeatureLayer using a style.
 */
class FeatureLayerVisualization
{
    friend struct RecursiveRelationVisualizationState;

public:
    /**
     * Convert a TileFeatureLayer into Cesium primitives based on the provided style.
     */
     FeatureLayerVisualization(
        std::string const& mapTileKey,
        const FeatureLayerStyle& style,
        NativeJsValue const& rawOptionValues,
        NativeJsValue const& rawFeatureMergeService,
        FeatureStyleRule::HighlightMode const& highlightMode = FeatureStyleRule::NoHighlight,
        NativeJsValue const& rawFeatureIdSubset = {});

     /**
      * Destructor for memory diagnostics.
      */
     ~FeatureLayerVisualization();

    /**
     * Add a tile which is considered for visualization. All tiles added after
     * the first one are only considered to resolve external relations.
     */
    void addTileFeatureLayer(TileFeatureLayer const& tile);

    /**
     * Run visualization for the added tile feature layers.
     */
    void run();

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
    /**
     * Add all geometry of some feature which is compatible with the given rule.
     */
    void addFeature(
        mapget::model_ptr<mapget::Feature>& feature,
        BoundEvalFun& evalFun,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId);

    /**
     * Visualize an attribute.
     */
    void addAttribute(
        mapget::model_ptr<mapget::Feature> const& feature,
        std::string_view const& layer,
        mapget::model_ptr<mapget::Attribute> const& attr,
        std::string_view const& id,
        const FeatureStyleRule& rule,
        std::string const& mapLayerStyleRuleId,
        uint32_t& offsetFactor,
        glm::dvec3 const& offset);

    /**
     * Add some geometry. The Cesium conversion will be dispatched,
     * based on the geometry type and the style rule instructions.
     */
    void addGeometry(
        mapget::SelfContainedGeometry const& geom,
        std::optional<std::string_view> geometryName,
        std::string_view id,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset = {.0, .0, .0});
    void addGeometry(
        mapget::model_ptr<mapget::Geometry> const& geom,
        std::string_view id,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset = {.0, .0, .0});

    /**
     * Add a line which connects two points to the visualization.
     * Note: labelPositionHint can be used to move a potential label
     *  to the front (0) or center (0.5, default) or back (1) of the line.
     */
    void addLine(
        mapget::Point const& wgsA,
        mapget::Point const& wgsB,
        std::string_view const& id,
        FeatureStyleRule const& rule,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset,
        double labelPositionHint=0.5);

    /**
     * Add a polyline which has at least two shape-points.
     */
    void addPolyLine(
        std::vector<mapget::Point> const& vertsCartesian,
        const FeatureStyleRule& rule,
        JsValue const& id,
        BoundEvalFun& evalFun);

    /**
     * Add a merged point feature.
     */
    void addMergedPointGeometry(
        const std::string_view& id,
        const std::string& mapLayerStyleRuleId,
        const std::optional<glm::dvec3>& gridCellSize,
        mapget::Point const& pointCartographic,
        const char* geomField,
        BoundEvalFun& evalFun,
        std::function<JsValue(BoundEvalFun&)> const& makeGeomParams);

    /**
     * Get some cartesian points as a list of Cesium Cartesian points.
     */
    static JsValue encodeVerticesAsList(std::vector<mapget::Point> const& points);

    /**
     * Get some cartesian points as two lists (first half reversed) of Cesium Cartesian points.
     * Applicable for double arrows.
     */
    static std::pair<JsValue, JsValue> encodeVerticesAsReversedSplitList(std::vector<mapget::Point> const& points);

    /**
     * Get some cartesian points as a float64 buffer of Cesium Cartesian points.
     */
    static JsValue encodeVerticesAsFloat64Array(std::vector<mapget::Point> const& points);

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

    /**
     * Simfil expression evaluation function for the tile which this visualization belongs to.
     */
    simfil::Value evaluateExpression(std::string const& expression, simfil::ModelNode const& ctx, bool anyMode, bool autoWildcard) const;

    /**
     * Insert style option variables into the given OverlayNode.
     */
    void addOptionsToSimfilContext(simfil::OverlayNode& context);

    /**
     * Create a feature primitive ID struct from the mapTileKey_ and the given feature ID.
     */
    JsValue makeTileFeatureId(std::string_view const& featureId) const;

    /**
     * Get a unique identifier for the map+layer+style+rule-id+highlight-mode.
     * In combination with a tile id, this uniquely identifiers a merged corner tile.
     */
    std::string getMapLayerStyleRuleId(uint32_t ruleIndex) const;

    /// =========== Generic Members ===========

    JsValue mapTileKey_;
    bool featuresAdded_ = false;
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

    // Map from map-layer-style-rule-id to map from grid-position-hash
    // to pair of feature-id-set and MergedPointVisualization.
    std::map<std::string,
        std::map<std::string,
            std::pair<std::unordered_set<std::string>, std::optional<JsValue>>>> mergedPointsPerStyleRuleId_;
    JsValue featureMergeService_;

    FeatureLayerStyle const& style_;
    mapget::TileFeatureLayer::Ptr tile_;
    std::vector<mapget::TileFeatureLayer::Ptr> allTiles_;
    std::set<std::string> featureIdSubset_;
    std::shared_ptr<simfil::StringPool> internalStringPoolCopy_;
    std::map<std::string, simfil::Value> optionValues_;
    FeatureStyleRule::HighlightMode highlightMode_;

    /// ===== Relation Processing Members =====

    JsValue externalRelationReferences_;
    std::vector<std::pair<
        RecursiveRelationVisualizationState*,
        RecursiveRelationVisualizationState::RelationToVisualize*>>
        externalRelationVisualizations_;
    std::deque<RecursiveRelationVisualizationState> relationStyleState_;

    std::vector<FeatureStyleRule> labelStyles{};
};

}  // namespace erdblick
