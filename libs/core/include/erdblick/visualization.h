#pragma once

#include <map>
#include <vector>
#include "cesium-interface/point-conversion.h"
#include "cesium-interface/points.h"
#include "cesium-interface/primitive.h"
#include "style.h"
#include "simfil/overlay.h"

namespace erdblick
{

class FeatureLayerVisualization;

/**
 * Feature ID which is used when the rendered representation is not
 * supposed to be selectable.
 */
static constexpr uint32_t UnselectableId = 0xffffffff;

/**
 * Covers the state for the visualization of a single Relation-Style+Feature
 * combination. For recursive relations, this state may contain references to
 * features in other tiles, which are resolved using the externalReferences()...
 * ->processExternalReferences() communications.
 */
struct RecursiveRelationVisualizationState
{
    RecursiveRelationVisualizationState(
        FeatureStyleRule const* rule,
        mapget::model_ptr<mapget::Feature> f,
        FeatureLayerVisualization& visu);

    FeatureStyleRule const* rule_;
    FeatureLayerVisualization& visu_;

    struct RelationToVisualize
    {
        mapget::model_ptr<mapget::Relation> relation_;
        mapget::model_ptr<mapget::Feature> sourceFeature_;
        mapget::model_ptr<mapget::Feature> targetFeature_;
        bool twoway_ = false;
    };

    std::vector<RelationToVisualize*> externalRelationReferenceNodes_;
    std::map<std::string, std::deque<RelationToVisualize>> relationNodesPerFeatureId_;
    std::deque<mapget::model_ptr<mapget::Feature>> unexploredRelations_;

    void populateRelationsToVisualize();

    void render(RelationToVisualize const& r);
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
     * @param style The style to apply to the features in the layer.
     * @param layer A shared pointer to the TileFeatureLayer that needs to be visualized.
     */
     FeatureLayerVisualization(
        const FeatureLayerStyle& style,
        const std::vector<std::shared_ptr<mapget::TileFeatureLayer>>& layers,
        uint32_t highlightFeatureIndex = UnselectableId);

    /**
     * Returns a list of external references, which must be resolved.
     * The list contains tuples, where each tuple contains a pair of
     * (1) A feature type.
     * (2) A list of string-value pairs (Feature ID parts)
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
     * Each Resolution object has `tileId: <MapTileKey>` and `featureId: [<id-part-field, id-part-value, ...>]` fields.
     */
    void processResolvedExternalReferences(NativeJsValue const& extRefsResolvedNative);

    /**
     * Returns all non-empty Cesium primitives which resulted from
     * the given TileFeatureLayer conversion, in one PrimitiveCollection.
     */
    [[nodiscard]] NativeJsValue primitiveCollection() const;

private:
    /**
     * Add all geometry of some feature which is compatible with the given rule.
     */
    void addFeature(mapget::model_ptr<mapget::Feature>& feature, uint32_t id, FeatureStyleRule const& rule);

    /**
     * Add some geometry. The Cesium conversion will be dispatched,
     * based on the geometry type and the style rule instructions.
     */
    void addGeometry(mapget::model_ptr<mapget::Geometry> const& geom, uint32_t id, FeatureStyleRule const& rule);

    /**
     * Get the line primitive which supports this style based on the
     * arrow/dash/flat options which are set in the style.
     */
    CesiumPrimitive& getLinePrimitive(FeatureStyleRule const& rule);

    /**
     * Add a line which connects two points to the visualization.
     */
    void addLine(mapget::Point const& a, mapget::Point const& b, uint32_t id, FeatureStyleRule const& rule);

    /**
     * Get some WGS84 points as a list of Cesium Cartesian points.
     */
    static std::optional<JsValue> encodeVerticesAsList(mapget::model_ptr<mapget::Geometry> const& geom);

    /**
     * Get some WGS84 points as two lists (first half reversed) of Cesium Cartesian points.
     * Applicable for double arrows.
     */
    static std::optional<std::pair<JsValue, JsValue>> encodeVerticesAsReversedSplitList(mapget::model_ptr<mapget::Geometry> const& geom);

    /**
     * Get some WGS84 points as a float64 buffer of Cesium Cartesian points.
     */
    static std::optional<JsValue> encodeVerticesAsFloat64Array(mapget::model_ptr<mapget::Geometry> const& geom);

    /**
     * Get an initialised primitive for a particular PolylineDashMaterialAppearance.
     */
    CesiumPrimitive* getPrimitiveForDashMaterial(const FeatureStyleRule &rule);

    /**
     * Get an initialised primitive for a particular PolylineArrowMaterialAppearance.
     */
    CesiumPrimitive* getPrimitiveForArrowMaterial(const FeatureStyleRule &rule);

    /// =========== Generic Members ===========

    bool featuresAdded_ = false;
    CesiumPrimitive coloredLines_;
    std::map<std::tuple<std::string, std::string, uint32_t, uint32_t>, CesiumPrimitive> dashLines_;
    std::map<std::string, CesiumPrimitive> arrowLines_;
    CesiumPrimitive coloredNontrivialMeshes_;
    CesiumPrimitive coloredTrivialMeshes_;
    CesiumPrimitive coloredGroundLines_;
    std::map<std::tuple<std::string, std::string, uint32_t, uint32_t>, CesiumPrimitive> dashGroundLines_;
    std::map<std::string, CesiumPrimitive> arrowGroundLines_;
    CesiumPrimitive coloredGroundMeshes_;
    CesiumPointPrimitiveCollection coloredPoints_;

    mapget::TileFeatureLayer::Ptr tile_;
    std::vector<std::shared_ptr<mapget::TileFeatureLayer>> allTiles_;
    uint32_t highlightFeatureIndex_ = 0;

    /// ===== Relation Processing Members =====

    JsValue externalRelationReferences_;
    std::vector<std::pair<RecursiveRelationVisualizationState const*, uint32_t>> relationStyleStateForExtRef_;
    std::deque<RecursiveRelationVisualizationState> relationStyleStateForRule_;
};

}  // namespace erdblick
