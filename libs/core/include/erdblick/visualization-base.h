#pragma once

#include <functional>
#include <cstdint>
#include <deque>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "layer.h"
#include "simfil/environment.h"
#include "simfil/expression.h"
#include "simfil/overlay.h"
#include "style.h"

namespace erdblick
{

/**
 * Renderer-agnostic feature/style traversal shared by the different visualization backends.
 *
 * The base class owns style evaluation, fidelity/stage filtering, relation handling,
 * and point-merge bookkeeping. Derived classes only need to project coordinates and
 * translate emitted primitives into their backend-specific buffer format.
 */
class FeatureLayerVisualizationBase
{
public:
    /** Restricts which geometry kinds derived visualizations should emit. */
    enum class GeometryOutputMode : uint8_t {
        All = 0,
        PointsOnly = 1,
        NonPointsOnly = 2,
    };

    /** Capture shared visualization state before any features are traversed. */
    FeatureLayerVisualizationBase(
        int viewIndex,
        std::string const& mapTileKey,
        const FeatureLayerStyle& style,
        NativeJsValue const& rawOptionValues,
        FeatureStyleRule::HighlightMode const& highlightMode,
        FeatureStyleRule::Fidelity fidelity,
        int highFidelityStage,
        int maxLowFiLod,
        GeometryOutputMode geometryOutputMode = GeometryOutputMode::All,
        NativeJsValue const& rawFeatureIdSubset = {},
        NativeJsValue const& rawFeatureMergeService = {});
    /** Release cached evaluation state and deferred relation bookkeeping. */
    virtual ~FeatureLayerVisualizationBase();
    /** Add one parsed tile to the visualization input set. */
    void addTileFeatureLayer(TileFeatureLayer const& tile);
    /** Execute the style sheet against all queued tiles and emit renderer-specific geometry. */
    virtual void run();
    /** Return unresolved cross-tile relation references for frontend-assisted resolution. */
    [[nodiscard]] NativeJsValue externalRelationReferences() const;
    /** Feed resolved external relation targets back into pending relation visualizations. */
    void processResolvedExternalReferences(NativeJsValue const& resolvedReferences);
    /** Return structured runtime style evaluation issues collected during rendering. */
    [[nodiscard]] NativeJsValue runtimeStyleIssues() const;

protected:
    /**
     * Per-rule state used while collecting and rendering relation visualizations.
     *
     * Relation rendering is two-phase: discovery first, rendering once enough
     * source/target information has been gathered.
     */
    struct RelationStyleState {
        /** Geometry fragment chosen for relation rendering after fidelity/stage selection. */
        struct ResolvedGeometry {
            mapget::SelfContainedGeometry geometry_;
            std::optional<uint32_t> stage_;
        };

        /** One concrete relation instance waiting to be rendered. */
        struct RelationToVisualize {
            mapget::model_ptr<mapget::Relation> relation_;
            mapget::model_ptr<mapget::Feature> sourceFeature_;
            mapget::model_ptr<mapget::Feature> targetFeature_;
            bool twoway_ = false;
            bool rendered_ = false;

            /** Report whether all required source/target references are available. */
            [[nodiscard]] bool readyToRender() const;
        };

        /** Initialize relation traversal for one rule and seed feature. */
        RelationStyleState(
            FeatureStyleRule const& rule,
            mapget::model_ptr<mapget::Feature> feature,
            FeatureLayerVisualizationBase& visualization);

        /** Continue exploring queued relations and render those that are ready. */
        void populateAndRender(bool onlyUpdateTwowayFlags = false);
        /** Register one discovered relation on a source feature. */
        void addRelation(
            mapget::model_ptr<mapget::Feature> const& sourceFeature,
            mapget::model_ptr<mapget::Relation> const& relation,
            bool onlyUpdateTwowayFlags = false);
        /** Resolve the geometry fragments that should represent a relation validity. */
        static std::vector<ResolvedGeometry> relationGeometries(
            mapget::model_ptr<mapget::MultiValidity> const& validities,
            mapget::model_ptr<mapget::Feature> const& feature,
            std::optional<uint32_t> preferredGeometryStage);
        /** Emit one relation once all dependencies have been resolved. */
        void render(RelationToVisualize& relationToRender);

        FeatureStyleRule const& rule_;
        FeatureLayerVisualizationBase& visualization_;
        std::deque<mapget::model_ptr<mapget::Feature>> unexploredFeatures_;
        std::unordered_map<std::string, std::deque<RelationToVisualize>> relationsBySourceFeatureId_;
        std::unordered_set<std::string> visualizedFeatureParts_;
    };

    /** Deferred cross-tile relation render request waiting for frontend resolution. */
    struct PendingExternalRelation {
        RelationStyleState* state = nullptr;
        RelationStyleState::RelationToVisualize* relationToRender = nullptr;
    };

    /** Hover filter restricting attribute rendering to the subset currently under the cursor. */
    struct HoveredAttributeSubset {
        std::unordered_set<uint32_t> hoveredAttributeIndices_;
        std::unordered_map<uint32_t, std::unordered_set<uint32_t>> hoveredValidityIndicesByAttribute_;
    };

    static constexpr uint32_t kUnselectableFeatureId = std::numeric_limits<uint32_t>::max();

    /** Convert a WGS84 point into the coordinate space expected by the concrete renderer. */
    virtual mapget::Point projectWgsPoint(
        mapget::Point const& wgsPoint) const = 0;

    /** Build the stable frontend id for geometry emitted by one style rule. */
    virtual std::string makeMapLayerStyleRuleId(uint32_t ruleIndex) const;
    /** Entry point for relation-style rules before relation traversal begins. */
    virtual void onRelationStyle(
        mapget::model_ptr<mapget::Feature>& feature,
        BoundEvalFun& evalFun,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId);
    /** Called once per feature before any style-rule evaluation for that feature. */
    virtual void onFeatureForRendering(mapget::Feature const& feature);
    /** Allow derived visualizations to bypass the shared low-fi LOD suppression. */
    [[nodiscard]] virtual bool bypassLowFiMaxLodFilter() const;

    /** Emit one polygon in renderer-specific form. */
    virtual void emitPolygon(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Emit one mesh or triangle surface in renderer-specific form. */
    virtual void emitMesh(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Emit one AABB in renderer-specific form. */
    virtual void emitAabb(
        mapget::Point const& originWgs,
        mapget::Point const& sizeWgs,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Emit one GLTF-backed node reference in renderer-specific form. */
    virtual void emitGltfNode(
        uint32_t nodeIndex,
        mapget::Point const& aabbOriginWgs,
        mapget::Point const& aabbSizeWgs,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Emit one point in renderer-specific form. */
    virtual void emitPoint(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Emit one icon anchor in renderer-specific form. */
    virtual void emitIcon(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Emit one label in renderer-specific form. */
    virtual void emitLabel(
        JsValue const& xyzPos,
        std::string const& text,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Emit one solid polyline in renderer-specific form. */
    virtual void emitSolidPolyLine(
        JsValue const& jsVerts,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Emit one dashed polyline in renderer-specific form. */
    virtual void emitDashedPolyLine(
        JsValue const& jsVerts,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Emit one arrow polyline in renderer-specific form. */
    virtual void emitArrowPolyLine(
        JsValue const& jsVerts,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Build the merge-service payload for a point geometry. */
    virtual JsValue makeMergedPointPointParams(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Build the merge-service payload for an icon geometry. */
    virtual JsValue makeMergedPointIconParams(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Build the merge-service payload for a label geometry. */
    virtual JsValue makeMergedPointLabelParams(
        JsValue const& xyzPos,
        std::string const& text,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);

    /** Evaluate one feature-style rule against a whole feature. */
    void addFeature(
        mapget::model_ptr<mapget::Feature>& feature,
        BoundEvalFun& evalFun,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId);
    /** Evaluate one attribute-style rule against a matched attribute instance. */
    void addAttribute(
        mapget::model_ptr<mapget::Feature> const& feature,
        std::string_view const& layer,
        mapget::model_ptr<mapget::Attribute> const& attr,
        uint32_t tileFeatureId,
        const FeatureStyleRule& rule,
        std::string const& mapLayerStyleRuleId,
        uint32_t& offsetSlot,
        std::unordered_set<uint32_t> const* hoveredValidityIndices = nullptr);
    /** Emit an already materialized geometry if it passes all render filters. */
    bool addGeometry(
        mapget::SelfContainedGeometry const& geom,
        std::optional<uint32_t> geometryStage,
        uint32_t tileFeatureId,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset = {.0, .0, .0});
    /** Resolve and emit a geometry model node if it passes all render filters. */
    bool addGeometry(
        mapget::model_ptr<mapget::Geometry> const& geom,
        uint32_t tileFeatureId,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset = {.0, .0, .0});
    /** Expand one WGS84 AABB into a mesh-style render primitive. */
    bool addAabbGeometry(
        mapget::Point const& originWgs,
        mapget::Point const& sizeWgs,
        std::optional<uint32_t> geometryStage,
        uint32_t tileFeatureId,
        FeatureStyleRule const& rule,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset = {.0, .0, .0});
    /** Emit one GLTF node reference if it passes all current render filters. */
    bool addGltfNodeGeometry(
        uint32_t nodeIndex,
        mapget::Point const& aabbOriginWgs,
        mapget::Point const& aabbSizeWgs,
        std::optional<uint32_t> geometryStage,
        uint32_t tileFeatureId,
        FeatureStyleRule const& rule,
        BoundEvalFun& evalFun);
    /** Emit a synthetic two-point line with consistent label placement hints. */
    void addLine(
        mapget::Point const& wgsA,
        mapget::Point const& wgsB,
        uint32_t tileFeatureId,
        FeatureStyleRule const& rule,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset,
        double labelPositionHint = 0.5);
    /** Emit a polyline after renderer-independent point projection and rule filtering. */
    virtual void addPolyLine(
        std::vector<mapget::Point> const& vertsCartesian,
        const FeatureStyleRule& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    /** Report whether this visualization wants point-like geometry for the current pass. */
    [[nodiscard]] virtual bool includesPointLikeGeometry() const;
    /** Report whether this visualization wants line or surface geometry for the current pass. */
    [[nodiscard]] virtual bool includesNonPointGeometry() const;
    /** Route point-like geometry either to merged-point aggregation or direct emission. */
    void addMergedPointGeometry(
        uint32_t tileFeatureId,
        const std::string& mapLayerStyleRuleId,
        const std::optional<glm::dvec3>& gridCellSize,
        mapget::Point const& pointCartographic,
        const char* geomField,
        BoundEvalFun& evalFun,
        std::function<JsValue(BoundEvalFun&)> const& makeGeomParams);
    /** Evaluate a simfil expression against one context node. */
    simfil::Value evaluateExpression(
        std::string const& expression,
        simfil::ModelNode const& ctx,
        bool anyMode,
        bool autoWildcard);
    /** Evaluate an expression once and cache the result if it is constant. */
    std::optional<simfil::Value> evaluateConstantExpression(
        std::string const& expression,
        bool anyMode,
        bool autoWildcard);
    /** Cached parsed simfil expression and its optional constant-folded result. */
    struct CachedExpression {
        simfil::ASTPtr ast_;
        std::optional<simfil::Value> constantValue_;
        bool constantResolved_ = false;
    };
    /** Lazily construct the shared simfil evaluation environment. */
    void ensureEvaluationEnvironment();
    /** Look up or compile an expression in the per-visualization cache. */
    CachedExpression* getOrCompileExpression(
        std::string const& expression,
        bool anyMode,
        bool autoWildcard);
    /** Resolve and memoize the constant value of a cached expression, if any. */
    void resolveCachedConstant(CachedExpression& cached);
    /** Record one bounded runtime style evaluation issue. */
    void recordRuntimeStyleIssue(
        std::string property,
        std::string expression,
        std::string message,
        std::optional<uint32_t> ruleIndex = std::nullopt,
        std::string impact = "property-fallback");
    /** Inject current option values into the simfil overlay context. */
    void addOptionsToSimfilContext(simfil::model_ptr<simfil::OverlayNode>& context);
    /** Remember a relation target that lives in another tile for frontend-assisted resolution. */
    void rememberExternalRelationReference(
        RelationStyleState& state,
        RelationStyleState::RelationToVisualize* relationToRender,
        mapget::model_ptr<mapget::FeatureId> const& targetRef);
    /** Encode projected vertices as a JS list of `[x, y, z]` triples. */
    static JsValue encodeVerticesAsList(std::vector<mapget::Point> const& points);
    /** Encode vertices both in forward and reversed order for arrow and transition rendering. */
    static std::pair<JsValue, JsValue> encodeVerticesAsReversedSplitList(std::vector<mapget::Point> const& points);
    /** Encode projected vertices as a packed Float64Array-backed payload. */
    static JsValue encodeVerticesAsFloat64Array(std::vector<mapget::Point> const& points);
    /** Choose the preferred geometry stage for the current fidelity and optional rule override. */
    [[nodiscard]] std::optional<uint32_t> preferredGeometryStageForCurrentFidelity(
        std::optional<uint32_t> stageOverride = std::nullopt) const;
    /** Check geometry-output, fidelity, and stage filters before emission. */
    [[nodiscard]] bool geometryPassesRenderFilters(
        mapget::GeomType geomType,
        std::optional<uint32_t> geometryStage,
        FeatureStyleRule const& rule) const;
    /** Combine base offset and per-slot increment for stacked rendering. */
    [[nodiscard]] static glm::dvec3 effectiveOffsetForSlot(
        FeatureStyleRule const& rule,
        uint32_t offsetSlot);

    bool featuresAdded_ = false;
    int viewIndex_;
    FeatureLayerStyle const& style_;
    std::set<std::string> featureIdSubset_;
    std::set<std::string> featureIdBaseSubset_;
    std::unordered_map<std::string, HoveredAttributeSubset> hoveredAttributeSubsetsByFeatureId_;
    std::map<std::string, simfil::Value> optionValues_;
    FeatureStyleRule::HighlightMode highlightMode_;
    FeatureStyleRule::Fidelity fidelity_;
    uint32_t highFidelityStage_ = 0;
    int maxLowFiLod_ = -1;
    GeometryOutputMode geometryOutputMode_ = GeometryOutputMode::All;
    JsValue featureMergeService_;
    std::map<std::string,
        std::map<std::string,
            std::pair<std::unordered_set<uint32_t>, std::optional<JsValue>>>> mergedPointsPerStyleRuleId_;
    mapget::TileFeatureLayer::Ptr tile_;
    std::vector<mapget::TileFeatureLayer::Ptr> allTiles_;
    std::shared_ptr<simfil::StringPool> internalStringPoolCopy_;
    std::unique_ptr<simfil::Environment> evalEnvironment_;
    std::map<std::string, CachedExpression, std::less<>> expressionCache_;
    std::unordered_map<uint32_t, uint32_t> featureOffsetSlotsByRuleIndex_;
    std::deque<RelationStyleState> relationStyleStates_;
    JsValue externalRelationReferences_;
    std::vector<PendingExternalRelation> externalRelationVisualizations_;
    std::vector<StyleValidationIssue> runtimeStyleIssues_;
};

}  // namespace erdblick
