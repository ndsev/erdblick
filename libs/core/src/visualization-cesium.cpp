#include "visualization-cesium.h"
#include "cesium-interface/point-conversion.h"
#include "geometry.h"

#include <algorithm>
#include <iostream>
#include <limits>

using namespace mapget;

namespace erdblick
{


namespace {
uint32_t fvec4ToInt(glm::fvec4 const& v) {
    return (
        (static_cast<uint32_t>(v.r * 255) << 24) | (static_cast<uint32_t>(v.g * 255) << 16) |
        (static_cast<uint32_t>(v.b * 255) << 8) | static_cast<uint32_t>(v.a * 255));
}

constexpr uint32_t kUnselectableFeatureId = std::numeric_limits<uint32_t>::max();
}

CesiumFeatureLayerVisualization::CesiumFeatureLayerVisualization(
    int viewIndex,
    std::string const& mapTileKey,
    const FeatureLayerStyle& style,
    NativeJsValue const& rawOptionValues,
    NativeJsValue const& rawFeatureMergeService,
    FeatureStyleRule::HighlightMode const& highlightMode,
    NativeJsValue const& rawFeatureIdSubset)
    : FeatureLayerVisualizationBase(
          viewIndex,
          mapTileKey,
          style,
          rawOptionValues,
          highlightMode,
          rawFeatureIdSubset,
          rawFeatureMergeService),
      coloredLines_(CesiumPrimitive::withPolylineColorAppearance(false)),
      coloredNontrivialMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(false, false)),
      coloredTrivialMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(true)),
      coloredGroundLines_(CesiumPrimitive::withPolylineColorAppearance(true)),
      coloredGroundMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(true, true)),
      externalRelationReferences_(JsValue::List())
{
}

CesiumFeatureLayerVisualization::~CesiumFeatureLayerVisualization() = default;

void CesiumFeatureLayerVisualization::addTileFeatureLayer(TileFeatureLayer const& tile)
{
    auto const isFirstTile = !tile_;
    FeatureLayerVisualizationBase::addTileFeatureLayer(tile);
    if (!isFirstTile) {
        return;
    }
    for (auto&& rule : style_.rules()) {
        if (rule.mode() != highlightMode_ || !rule.pointMergeGridCellSize()) {
            continue;
        }
        mergedPointsPerStyleRuleId_.emplace(
            makeMapLayerStyleRuleId(rule.index()),
            std::map<std::string, std::pair<std::unordered_set<uint32_t>, std::optional<JsValue>>>());
    }
}

void CesiumFeatureLayerVisualization::run()
{
    FeatureLayerVisualizationBase::run();
}

mapget::Point CesiumFeatureLayerVisualization::projectWgsPoint(
    mapget::Point const& wgsPoint,
    glm::dvec3 const& wgsOffset) const
{
    return wgsToCartesian<mapget::Point>(wgsPoint, wgsOffset);
}

std::string CesiumFeatureLayerVisualization::makeMapLayerStyleRuleId(uint32_t ruleIndex) const
{
    return fmt::format(
        "{}:{}:{}:{}:{}:{}",
        viewIndex_,
        tile_->mapId(),
        tile_->layerInfo()->layerId_,
        style_.name(),
        static_cast<uint32_t>(highlightMode_),
        ruleIndex);
}

NativeJsValue CesiumFeatureLayerVisualization::primitiveCollection() const
{
    if (!featuresAdded_)
        return {};
    auto collection = Cesium().PrimitiveCollection.New();
    if (!coloredLines_.empty())
        collection.call<void>("add", coloredLines_.toJsObject());
    if (!dashLines_.empty())
        for (const auto &dashLinePair : dashLines_) {
            collection.call<void>("add", dashLinePair.second.toJsObject());
        }
    if (!arrowLines_.empty())
        for (const auto &darrowLinePair : arrowLines_) {
            collection.call<void>("add", darrowLinePair.second.toJsObject());
        }
    if (!coloredNontrivialMeshes_.empty())
        collection.call<void>("add", coloredNontrivialMeshes_.toJsObject());
    if (!coloredTrivialMeshes_.empty())
        collection.call<void>("add", coloredTrivialMeshes_.toJsObject());
    if (!coloredGroundLines_.empty())
        collection.call<void>("add", coloredGroundLines_.toJsObject());
    if (!dashGroundLines_.empty())
        for (const auto &dashGroundLinePair : dashGroundLines_) {
            collection.call<void>("add", dashGroundLinePair.second.toJsObject());
        }
    if (!arrowGroundLines_.empty())
        for (const auto &arrowGroundLinePair : arrowGroundLines_) {
            collection.call<void>("add", arrowGroundLinePair.second.toJsObject());
        }
    if (!coloredGroundMeshes_.empty())
        collection.call<void>("add", coloredGroundMeshes_.toJsObject());
    if (!coloredPoints_.empty())
        collection.call<void>("add", coloredPoints_.toJsObject());
    if (!labelCollection_.empty())
        collection.call<void>("add", labelCollection_.toJsObject());
    if (!billboardCollection_.empty())
        collection.call<void>("add", billboardCollection_.toJsObject());
    return *collection;
}

NativeJsValue CesiumFeatureLayerVisualization::mergedPointFeatures() const
{
    auto result = JsValue::Dict();
    for (auto const& [mapLayerStyleRuleId, primitives] : mergedPointsPerStyleRuleId_) {
        auto pointList = JsValue::List();
        for (auto const& [_, featureIdsAndPoint] : primitives) {
            if (auto const& pt = featureIdsAndPoint.second) {
                pointList.push(*pt);
            }
        }
        result.set(mapLayerStyleRuleId, pointList);
    }
    return *result;
}

NativeJsValue CesiumFeatureLayerVisualization::externalReferences()
{
    return *externalRelationReferences_;
}

void CesiumFeatureLayerVisualization::processResolvedExternalReferences(
    const NativeJsValue& extRefsResolvedNative)
{
    JsValue extRefsResolved(extRefsResolvedNative);
    auto numResolutionLists = extRefsResolved.size();

    if (numResolutionLists != externalRelationVisualizations_.size()) {
        std::cout << "Unexpected number of resolutions!" << std::endl;
        return;
    }

    std::set<RecursiveRelationVisualizationState*> updatedRelationVisuState;

    for (auto i = 0; i < numResolutionLists; ++i) {
        // Parse the first entry in the resolutionList
        auto resolutionList = extRefsResolved.at(i);
        if (resolutionList.size() == 0)
            continue;

        auto firstResolution = resolutionList.at(0);
        auto typeId = firstResolution["typeId"].as<std::string>();
        auto featureIdParts = firstResolution["featureId"];

        // Find the target feature in any of the available tiles.
        mapget::model_ptr<mapget::Feature> targetFeature;
        for (auto const& tile : allTiles_) {
            targetFeature = tile->find(typeId, featureIdParts.toKeyValuePairs());
            if (targetFeature)
                break;
        }
        if (!targetFeature) {
            std::cout << "Resolved target feature was not found in aux tiles!" << std::endl;
            continue;
        }

        // Annotate the relation visu with the resolved feature.
        auto [relationVisuParent, relationVisu] = externalRelationVisualizations_[i];
        relationVisu->targetFeature_ = targetFeature;
        if (relationVisuParent->rule_.relationMergeTwoWay()) {
            relationVisuParent->unexploredRelations_.emplace_back(targetFeature);
        }
        updatedRelationVisuState.insert(relationVisuParent);
    }

    // Re-process/render all changed relation visualization state.
    for (auto visuState : updatedRelationVisuState) {
        visuState->populateAndRender(true);
    }
}
CesiumPrimitive& CesiumFeatureLayerVisualization::getPrimitiveForDashMaterial(
    const FeatureStyleRule& rule,
    BoundEvalFun& evalFun)
{
    const auto resolvedColor = rule.color(evalFun);
    const auto colorKey = fvec4ToInt(resolvedColor);
    const auto gapColorKey = fvec4ToInt(rule.gapColor());
    const auto key = std::tuple<uint32_t, uint32_t, uint32_t, uint32_t>{colorKey, gapColorKey, rule.dashLength(), rule.dashPattern()};
    auto& dashMap = rule.flat() ? dashGroundLines_ : dashLines_;
    auto iter = dashMap.find(key);
    if (iter != dashMap.end()) {
        return iter->second;
    }
    return dashMap
        .emplace(
            key,
            CesiumPrimitive::withPolylineDashMaterialAppearance(rule, rule.flat(), resolvedColor))
        .first->second;
}

CesiumPrimitive& CesiumFeatureLayerVisualization::getPrimitiveForArrowMaterial(
    const FeatureStyleRule& rule,
    BoundEvalFun& evalFun)
{
    const auto resolvedColor = rule.color(evalFun);
    const auto colorKey = fvec4ToInt(resolvedColor);
    auto& arrowMap = rule.flat() ? arrowGroundLines_ : arrowLines_;
    auto iter = arrowMap.find(colorKey);
    if (iter != arrowMap.end()) {
        return iter->second;
    }
    return arrowMap
        .emplace(
            colorKey,
            CesiumPrimitive::withPolylineArrowMaterialAppearance(rule, rule.flat(), resolvedColor))
        .first->second;
}

void CesiumFeatureLayerVisualization::onRelationStyle(
    model_ptr<Feature>& feature,
    BoundEvalFun& evalFun,
    FeatureStyleRule const& rule,
    std::string const& mapLayerStyleRuleId)
{
    (void) evalFun;
    (void) mapLayerStyleRuleId;
    relationStyleState_.emplace_back(rule, feature, *this);
}

void CesiumFeatureLayerVisualization::emitPolygon(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    auto jsVerts = encodeVerticesAsList(vertsCartesian);
    if (rule.flat()) {
        coloredGroundMeshes_.addPolygon(jsVerts, rule, tileFeatureId, evalFun);
    } else {
        coloredNontrivialMeshes_.addPolygon(jsVerts, rule, tileFeatureId, evalFun);
    }
}

void CesiumFeatureLayerVisualization::emitMesh(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    auto jsVerts = encodeVerticesAsFloat64Array(vertsCartesian);
    coloredTrivialMeshes_.addTriangles(jsVerts, rule, tileFeatureId, evalFun);
}

void CesiumFeatureLayerVisualization::emitPoint(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    coloredPoints_.addPoint(xyzPos, rule, tileFeatureId, evalFun);
}

void CesiumFeatureLayerVisualization::emitIcon(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    billboardCollection_.addBillboard(xyzPos, rule, tileFeatureId, evalFun);
}

void CesiumFeatureLayerVisualization::emitLabel(
    JsValue const& xyzPos,
    std::string const& text,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    labelCollection_.addLabel(xyzPos, text, rule, tileFeatureId, evalFun);
}

void CesiumFeatureLayerVisualization::emitSolidPolyLine(
    JsValue const& jsVerts,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    if (rule.flat()) {
        coloredGroundLines_.addPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    } else {
        coloredLines_.addPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
}

void CesiumFeatureLayerVisualization::emitDashedPolyLine(
    JsValue const& jsVerts,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    getPrimitiveForDashMaterial(rule, evalFun).addPolyLine(jsVerts, rule, tileFeatureId, evalFun);
}

void CesiumFeatureLayerVisualization::emitArrowPolyLine(
    JsValue const& jsVerts,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    getPrimitiveForArrowMaterial(rule, evalFun).addPolyLine(jsVerts, rule, tileFeatureId, evalFun);
}

JsValue CesiumFeatureLayerVisualization::makeMergedPointPointParams(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    return CesiumPointPrimitiveCollection::pointParams(xyzPos, rule, tileFeatureId, evalFun);
}

JsValue CesiumFeatureLayerVisualization::makeMergedPointIconParams(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    return CesiumBillboardCollection::billboardParams(xyzPos, rule, tileFeatureId, evalFun);
}

JsValue CesiumFeatureLayerVisualization::makeMergedPointLabelParams(
    JsValue const& xyzPos,
    std::string const& text,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    return CesiumLabelCollection::labelParams(xyzPos, text, rule, tileFeatureId, evalFun);
}

RecursiveRelationVisualizationState::RecursiveRelationVisualizationState(
    const FeatureStyleRule& rule,
    mapget::model_ptr<mapget::Feature> f,
    CesiumFeatureLayerVisualization& visu)
    : rule_(rule), visu_(visu)
{
    unexploredRelations_.emplace_back(std::move(f));
    populateAndRender();
}

void RecursiveRelationVisualizationState::populateAndRender(bool onlyUpdateTwowayFlags)
{
    while (!unexploredRelations_.empty()) {
        auto nextFeature = unexploredRelations_.front();
        unexploredRelations_.pop_front();

        nextFeature->forEachRelation(
            [&](auto const& relation)
            {
                addRelation(nextFeature, relation, onlyUpdateTwowayFlags);
                return true;
            });
    }

    // Render completed relation visualisations.
    for (auto& [_, relationVisuList] : relationsByFeatureId_) {
        for (auto& relVisu : relationVisuList) {
            if (relVisu.readyToRender()) {
                render(relVisu);
            }
        }
    }
}

void RecursiveRelationVisualizationState::addRelation(const model_ptr<Feature>& sourceFeature, const model_ptr<Relation>& relation, bool onlyUpdateTwowayFlags)
{
    // Check if the relation type name is accepted for the rule.
    if (auto const& relTypeRegex = rule_.relationType()) {
        auto relationTypeId = relation->name();
        if (!std::regex_match(relationTypeId.begin(), relationTypeId.end(), *relTypeRegex)) {
            return;
        }
    }

    // Check if this relation was already added.
    auto targetRef = relation->target();
    auto& relationsForThisFeature = relationsByFeatureId_[sourceFeature->id()->toString()];
    for (auto& existingRelVisu : relationsForThisFeature) {
        if (existingRelVisu.relation_->target()->toString() == targetRef->toString()) {
            return;
        }
    }

    // Resolve target feature.
    auto targetFeature =
        visu_.tile_->find(targetRef->typeId(), targetRef->keyValuePairs());

    // Check if the target feature already has a reference to me.
    auto relationsForTargetIt = relationsByFeatureId_.end();
    if (targetFeature) {
        relationsForTargetIt = relationsByFeatureId_.find(targetFeature->id()->toString());
        if (rule_.relationMergeTwoWay() && relationsForTargetIt != relationsByFeatureId_.end()) {
            for (auto& relVisu : relationsForTargetIt->second) {
                if (relVisu.targetFeature_ && relVisu.targetFeature_->id()->toString() == sourceFeature->id()->toString()) {
                    relVisu.twoway_ = true;
                    return;
                }
            }
        }
    }
    if (onlyUpdateTwowayFlags)
        return;

    // Create new relation-to-visualize.
    auto& newRelationVisu = relationsForThisFeature.emplace_back();
    newRelationVisu.relation_ = relation;
    newRelationVisu.sourceFeature_ = sourceFeature;

    if (targetFeature) {
        newRelationVisu.targetFeature_ = targetFeature;
        // We got an additional feature to explore. But do it only
        // if we haven't explored it yet.
        if (rule_.relationRecursive() && relationsForTargetIt == relationsByFeatureId_.end()) {
            unexploredRelations_.emplace_back(targetFeature);
        }
    }
    else {
        // Add the relation to externals, if we could not resolve it.
        // It will be finalized later, via processResolvedExternalRelations().
        visu_.externalRelationVisualizations_.emplace_back(this, &newRelationVisu);

        JsValue featureIdParts = JsValue::List();
        for (auto const& [key, value] : relation->target()->keyValuePairs()) {
            featureIdParts.push(JsValue(std::string(key)));
            featureIdParts.push(JsValue::fromVariant(value));
        }

        JsValue newExtReferenceToResolve = JsValue::Dict();
        newExtReferenceToResolve.set("mapId", JsValue(visu_.tile_->mapId()));
        newExtReferenceToResolve.set("typeId", JsValue(std::string(relation->target()->typeId())));
        newExtReferenceToResolve.set("featureId", featureIdParts);
        visu_.externalRelationReferences_.push(newExtReferenceToResolve);
    }
}

void RecursiveRelationVisualizationState::render(
    RecursiveRelationVisualizationState::RelationToVisualize& r)
{
    // Create simfil evaluation context for the rule.
    auto const& constRelation = static_cast<mapget::Relation const&>(*r.relation_);
    auto const& constSource = static_cast<mapget::Feature const&>(*r.sourceFeature_);
    auto const& constTarget = static_cast<mapget::Feature const&>(*r.targetFeature_);

    auto relationEvaluationContext = simfil::model_ptr<simfil::OverlayNode>::make(simfil::Value::field(constRelation));
    visu_.addOptionsToSimfilContext(relationEvaluationContext);

    // Assemble simfil evaluation context.
    {
        auto sourceId = visu_.internalStringPoolCopy_->emplace("$source");
        relationEvaluationContext->set(sourceId.value(), simfil::Value::field(constSource));
        auto targetId = visu_.internalStringPoolCopy_->emplace("$target");
        relationEvaluationContext->set(targetId.value(), simfil::Value::field(constTarget));
        auto twowayId = visu_.internalStringPoolCopy_->emplace("$twoway");
        relationEvaluationContext->set(twowayId.value(), simfil::Value(r.twoway_));
    }

    // Function which can evaluate a simfil expression in the relation context.
    auto boundEvalFun = BoundEvalFun{
        relationEvaluationContext,
        [this, &relationEvaluationContext](auto&& str)
        {
            return visu_.evaluateExpression(str, *relationEvaluationContext, false, false);
        }};

    // Obtain source/target geometries.
    auto convertMultiValidityWithFallback = [](model_ptr<MultiValidity> const& vv, model_ptr<Feature> const& feature) {
        std::vector<SelfContainedGeometry> result;
        if (vv) {
            vv->forEach([&result, &feature](auto&& v)
            {
                result.emplace_back(v.computeGeometry(feature->geomOrNull()));
                return true;
            });
        }
        if (result.empty()) {
            result = {feature->firstGeometry()};
        }
        return result;
    };
    auto sourceGeoms = convertMultiValidityWithFallback(r.relation_->sourceValidityOrNull(), r.sourceFeature_);
    auto targetGeoms = convertMultiValidityWithFallback(r.relation_->targetValidityOrNull(), r.targetFeature_);;

    // Get offset base vector.
    auto offsetBase = localWgs84UnitCoordinateSystem(sourceGeoms[0]);
    auto offset = offsetBase * rule_.offset();

    // Ensure that sourceStyle, targetStyle and endMarkerStyle
    // are only ever applied once for each feature.
    auto sourceId = r.sourceFeature_->id()->toString();
    auto targetId = r.targetFeature_->id()->toString();

    // Create line geometry which connects source and target feature.
    if (!sourceGeoms[0].points_.empty() && !targetGeoms[0].points_.empty())
    {
        auto p1lo = geometryCenter(sourceGeoms[0]);
        auto p2lo = geometryCenter(targetGeoms[0]);
        auto p1hi = Point{p1lo.x, p1lo.y, p1lo.z + rule_.relationLineHeightOffset()};
        auto p2hi = Point{p2lo.x, p2lo.y, p2lo.z + rule_.relationLineHeightOffset()};

        if (rule_.width() > 0) {
            visu_.addLine(
                p1hi,
                p2hi,
                kUnselectableFeatureId,
                rule_,
                boundEvalFun,
                offset);
        }
        if (rule_.relationLineEndMarkerStyle()) {
            if (visualizedFeatures_.emplace(sourceId + "-endmarker").second) {
                visu_.addLine(
                    p1lo,
                    p1hi,
                    kUnselectableFeatureId,
                    *rule_.relationLineEndMarkerStyle(),
                    boundEvalFun,
                    offsetBase * rule_.relationLineEndMarkerStyle()->offset());
            }
            if (visualizedFeatures_.emplace(targetId + "-endmarker").second) {
                visu_.addLine(
                    p2lo,
                    p2hi,
                    kUnselectableFeatureId,
                    *rule_.relationLineEndMarkerStyle(),
                    boundEvalFun,
                    offsetBase * rule_.relationLineEndMarkerStyle()->offset());
            }
        }
    }

    // Run source geometry visualization.
    if (visualizedFeatures_.emplace(sourceId).second) {
        if (auto sourceRule = rule_.relationSourceStyle()) {
            for (auto const& sourceGeom : sourceGeoms) {
                if (sourceGeom.points_.empty()) continue;
                    visu_.addGeometry(
                        sourceGeom,
                        std::nullopt,
                        kUnselectableFeatureId,
                        *sourceRule,
                        "",
                        boundEvalFun,
                        offsetBase * sourceRule->offset());
            }
        }
    }

    // Run target geometry visualization.
    if (visualizedFeatures_.emplace(targetId).second) {
        if (auto targetRule = rule_.relationTargetStyle()) {
            for (auto const& targetGeom : targetGeoms) {
                if (targetGeom.points_.empty()) continue;
                    visu_.addGeometry(
                        targetGeom,
                        std::nullopt,
                        kUnselectableFeatureId,
                        *targetRule,
                        "",
                        boundEvalFun,
                        offsetBase * targetRule->offset());
            }
        }
    }

    r.rendered_ = true;
}

bool RecursiveRelationVisualizationState::RelationToVisualize::readyToRender() const
{
    return relation_ && sourceFeature_ && targetFeature_ && !rendered_;
}

}  // namespace erdblick
