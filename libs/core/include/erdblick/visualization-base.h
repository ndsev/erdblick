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
 * Shared state and initialization logic for frontend-specific visualization adapters.
 */
class FeatureLayerVisualizationBase
{
public:
    enum class GeometryOutputMode : uint8_t {
        All = 0,
        PointsOnly = 1,
        NonPointsOnly = 2,
    };

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
    virtual ~FeatureLayerVisualizationBase();
    void addTileFeatureLayer(TileFeatureLayer const& tile);
    virtual void run();
    [[nodiscard]] NativeJsValue externalRelationReferences() const;
    void processResolvedExternalReferences(NativeJsValue const& resolvedReferences);

protected:
    struct RelationStyleState {
        struct RelationToVisualize {
            mapget::model_ptr<mapget::Relation> relation_;
            mapget::model_ptr<mapget::Feature> sourceFeature_;
            mapget::model_ptr<mapget::Feature> targetFeature_;
            bool twoway_ = false;
            bool rendered_ = false;

            [[nodiscard]] bool readyToRender() const;
        };

        RelationStyleState(
            FeatureStyleRule const& rule,
            mapget::model_ptr<mapget::Feature> feature,
            FeatureLayerVisualizationBase& visualization);

        void populateAndRender(bool onlyUpdateTwowayFlags = false);
        void addRelation(
            mapget::model_ptr<mapget::Feature> const& sourceFeature,
            mapget::model_ptr<mapget::Relation> const& relation,
            bool onlyUpdateTwowayFlags = false);
        static std::vector<mapget::SelfContainedGeometry> relationGeometries(
            mapget::model_ptr<mapget::MultiValidity> const& validities,
            mapget::model_ptr<mapget::Feature> const& feature);
        void render(RelationToVisualize& relationToRender);

        FeatureStyleRule const& rule_;
        FeatureLayerVisualizationBase& visualization_;
        std::deque<mapget::model_ptr<mapget::Feature>> unexploredFeatures_;
        std::unordered_map<std::string, std::deque<RelationToVisualize>> relationsBySourceFeatureId_;
        std::unordered_set<std::string> visualizedFeatureParts_;
    };

    struct PendingExternalRelation {
        RelationStyleState* state = nullptr;
        RelationStyleState::RelationToVisualize* relationToRender = nullptr;
    };

    struct HoveredAttributeSubset {
        std::unordered_set<uint32_t> hoveredAttributeIndices_;
        std::unordered_map<uint32_t, std::unordered_set<uint32_t>> hoveredValidityIndicesByAttribute_;
    };

    static constexpr uint32_t kUnselectableFeatureId = std::numeric_limits<uint32_t>::max();

    virtual mapget::Point projectWgsPoint(
        mapget::Point const& wgsPoint) const = 0;

    virtual std::string makeMapLayerStyleRuleId(uint32_t ruleIndex) const;
    virtual void onRelationStyle(
        mapget::model_ptr<mapget::Feature>& feature,
        BoundEvalFun& evalFun,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId);
    // Called once per feature before style-rule evaluation.
    virtual void onFeatureForRendering(mapget::Feature const& feature);
    // Allows derived classes to bypass the global low-fi max-lod filter.
    [[nodiscard]] virtual bool bypassLowFiMaxLodFilter() const;

    virtual void emitPolygon(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual void emitMesh(
        std::vector<mapget::Point> const& vertsCartesian,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual void emitPoint(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual void emitIcon(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual void emitLabel(
        JsValue const& xyzPos,
        std::string const& text,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual void emitSolidPolyLine(
        JsValue const& jsVerts,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual void emitDashedPolyLine(
        JsValue const& jsVerts,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual void emitArrowPolyLine(
        JsValue const& jsVerts,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual JsValue makeMergedPointPointParams(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual JsValue makeMergedPointIconParams(
        JsValue const& xyzPos,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    virtual JsValue makeMergedPointLabelParams(
        JsValue const& xyzPos,
        std::string const& text,
        FeatureStyleRule const& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);

    void addFeature(
        mapget::model_ptr<mapget::Feature>& feature,
        BoundEvalFun& evalFun,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId);
    void addAttribute(
        mapget::model_ptr<mapget::Feature> const& feature,
        std::string_view const& layer,
        mapget::model_ptr<mapget::Attribute> const& attr,
        uint32_t tileFeatureId,
        const FeatureStyleRule& rule,
        std::string const& mapLayerStyleRuleId,
        uint32_t& offsetFactor,
        std::unordered_set<uint32_t> const* hoveredValidityIndices = nullptr);
    void addGeometry(
        mapget::SelfContainedGeometry const& geom,
        std::optional<uint32_t> geometryStage,
        uint32_t tileFeatureId,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset = {.0, .0, .0});
    void addGeometry(
        mapget::model_ptr<mapget::Geometry> const& geom,
        uint32_t tileFeatureId,
        FeatureStyleRule const& rule,
        std::string const& mapLayerStyleRuleId,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset = {.0, .0, .0});
    void addLine(
        mapget::Point const& wgsA,
        mapget::Point const& wgsB,
        uint32_t tileFeatureId,
        FeatureStyleRule const& rule,
        BoundEvalFun& evalFun,
        glm::dvec3 const& offset,
        double labelPositionHint = 0.5);
    virtual void addPolyLine(
        std::vector<mapget::Point> const& vertsCartesian,
        const FeatureStyleRule& rule,
        uint32_t tileFeatureId,
        BoundEvalFun& evalFun);
    [[nodiscard]] virtual bool includesPointLikeGeometry() const;
    [[nodiscard]] virtual bool includesNonPointGeometry() const;
    void addMergedPointGeometry(
        uint32_t tileFeatureId,
        const std::string& mapLayerStyleRuleId,
        const std::optional<glm::dvec3>& gridCellSize,
        mapget::Point const& pointCartographic,
        const char* geomField,
        BoundEvalFun& evalFun,
        std::function<JsValue(BoundEvalFun&)> const& makeGeomParams);
    simfil::Value evaluateExpression(
        std::string const& expression,
        simfil::ModelNode const& ctx,
        bool anyMode,
        bool autoWildcard);
    std::optional<simfil::Value> evaluateConstantExpression(
        std::string const& expression,
        bool anyMode,
        bool autoWildcard);
    struct CachedExpression {
        simfil::ASTPtr ast_;
        std::optional<simfil::Value> constantValue_;
        bool constantResolved_ = false;
    };
    void ensureEvaluationEnvironment();
    CachedExpression* getOrCompileExpression(
        std::string const& expression,
        bool anyMode,
        bool autoWildcard);
    void resolveCachedConstant(CachedExpression& cached);
    void addOptionsToSimfilContext(simfil::model_ptr<simfil::OverlayNode>& context);
    void rememberExternalRelationReference(
        RelationStyleState& state,
        RelationStyleState::RelationToVisualize* relationToRender,
        mapget::model_ptr<mapget::FeatureId> const& targetRef);
    static JsValue encodeVerticesAsList(std::vector<mapget::Point> const& points);
    static std::pair<JsValue, JsValue> encodeVerticesAsReversedSplitList(std::vector<mapget::Point> const& points);
    static JsValue encodeVerticesAsFloat64Array(std::vector<mapget::Point> const& points);

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
    std::deque<RelationStyleState> relationStyleStates_;
    JsValue externalRelationReferences_;
    std::vector<PendingExternalRelation> externalRelationVisualizations_;
};

}  // namespace erdblick
