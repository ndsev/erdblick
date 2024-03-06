#include "visualization.h"
#include "cesium-interface/point-conversion.h"
#include "cesium-interface/primitive.h"
#include "geometry.h"

#include <iostream>

using namespace mapget;

namespace erdblick
{

FeatureLayerVisualization::FeatureLayerVisualization(
    const FeatureLayerStyle& style,
    uint32_t highlightFeatureIndex)
    : coloredLines_(CesiumPrimitive::withPolylineColorAppearance(false)),
      coloredNontrivialMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(false, false)),
      coloredTrivialMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(true)),
      coloredGroundLines_(CesiumPrimitive::withPolylineColorAppearance(true)),
      coloredGroundMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(true, true)),
      style_(style),
      highlightFeatureIndex_(highlightFeatureIndex)
{
}


void FeatureLayerVisualization::addTileFeatureLayer(
    std::shared_ptr<mapget::TileFeatureLayer> tile)
{
    if (!tile_)
        tile_ = std::move(tile);
    allTiles_.emplace_back(tile_);
}

void FeatureLayerVisualization::run()
{
    uint32_t featureId = 0;
    for (auto&& feature : *tile_) {
        if (highlightFeatureIndex_ != UnselectableId) {
            if (featureId != highlightFeatureIndex_) {
                ++featureId;
                continue;
            }
        }

        for (auto&& rule : style_.rules()) {
            if (highlightFeatureIndex_ != UnselectableId) {
                if (rule.mode() != FeatureStyleRule::Highlight)
                    continue;
            }

            if (auto* matchingSubRule = rule.match(*feature)) {
                addFeature(feature, featureId, *matchingSubRule);
                featuresAdded_ = true;
            }
        }
        ++featureId;
    }
}

NativeJsValue FeatureLayerVisualization::primitiveCollection() const
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
    return *collection;
}

NativeJsValue FeatureLayerVisualization::externalReferences()
{
    return *externalRelationReferences_;
}

void FeatureLayerVisualization::processResolvedExternalReferences(
    const NativeJsValue& extRefsResolvedNative)
{
    JsValue extRefsResolved(extRefsResolvedNative);
    auto numResolutionLists = extRefsResolved.size();

    if (numResolutionLists != externalRelationVisualizations_.size()) {
        throw std::runtime_error("Unexpected number of resolutions.");
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
        auto numFeatureIdParts = featureIdParts.size();
        mapget::KeyValuePairs featureIdPartsVec;
        for (auto kvIndex = 0; i < numFeatureIdParts; i += 2) {
            auto key = featureIdParts.at(kvIndex).as<std::string>();
            auto value = featureIdParts.at(kvIndex + 1);
            if (value.type() == JsValue::Type::Number) {
                featureIdPartsVec.emplace_back(key, value.as<int64_t>());
            }
            else if (value.type() == JsValue::Type::String) {
                featureIdPartsVec.emplace_back(key, value.as<std::string>());
            }
        }

        // Find the target feature in any of the available tiles.
        mapget::model_ptr<mapget::Feature> targetFeature;
        for (auto const& tile : allTiles_) {
            targetFeature = tile->find(typeId, featureIdPartsVec);
            if (targetFeature)
                break;
        }
        if (!targetFeature)
            continue;

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

void FeatureLayerVisualization::addFeature(
    model_ptr<Feature>& feature,
    uint32_t id,
    FeatureStyleRule const& rule)
{
    if (rule.aspect() == FeatureStyleRule::Feature) {
        feature->geom()->forEachGeometry(
            [this, id, &rule](auto&& geom)
            {
                if (rule.supports(geom->geomType()))
                    addGeometry(geom, id, rule);
                return true;
            });
    }
    else if (rule.aspect() == FeatureStyleRule::Relation) {
        relationStyleState_.emplace_back(rule, feature, *this);
    }
}

void FeatureLayerVisualization::addGeometry(
    model_ptr<Geometry> const& geom,
    uint32_t id,
    FeatureStyleRule const& rule)
{
    std::vector<mapget::Point> vertsCartesian;
    vertsCartesian.reserve(geom->numPoints());
    geom->forEachPoint(
        [&vertsCartesian](auto&& vertex)
        {
            vertsCartesian.emplace_back(wgsToCartesian<Point>(vertex));
            return true;
        });

    switch (geom->geomType()) {
    case Geometry::GeomType::Polygon:
        if (vertsCartesian.size() >= 3) {
            auto jsVerts = encodeVerticesAsList(vertsCartesian);
            if (rule.flat())
                coloredGroundMeshes_.addPolygon(jsVerts, rule, id);
            else
                coloredNontrivialMeshes_.addPolygon(jsVerts, rule, id);
        }
        break;
    case Geometry::GeomType::Line:
        addPolyLine(vertsCartesian, rule, id);
        break;
    case Geometry::GeomType::Mesh:
        if (vertsCartesian.size() >= 3) {
            auto jsVerts = encodeVerticesAsFloat64Array(vertsCartesian);
            coloredTrivialMeshes_.addTriangles(jsVerts, rule, id);
        }
        break;
    case Geometry::GeomType::Points:
        for (auto const& pt : vertsCartesian) {
            coloredPoints_.addPoint(JsValue(pt), rule, id);
        }
        break;
    }
}

JsValue
FeatureLayerVisualization::encodeVerticesAsList(std::vector<mapget::Point> const& pointsCartesian)
{
    auto jsPoints = JsValue::List();
    for (auto const& pt : pointsCartesian) {
        jsPoints.push(JsValue(pt));
    }
    return jsPoints;
}

std::pair<JsValue, JsValue>
FeatureLayerVisualization::encodeVerticesAsReversedSplitList(std::vector<mapget::Point> const& pointsCartesian)
{
    if (pointsCartesian.empty() || pointsCartesian.size() < 2)
        return {};

    auto jsPointsFirstHalf = JsValue::List();
    auto jsPointsSecondHalf = JsValue::List();

    if (pointsCartesian.size() == 2) {
        const auto x = (pointsCartesian.at(0).x + pointsCartesian.at(1).x) / 2;
        const auto y = (pointsCartesian.at(0).y + pointsCartesian.at(1).y) / 2;
        const auto z = (pointsCartesian.at(0).z + pointsCartesian.at(1).z) / 2;
        mapget::Point midpoint{x, y, z};
        jsPointsFirstHalf.push(JsValue(midpoint));
        jsPointsFirstHalf.push(JsValue(pointsCartesian.at(0)));
        jsPointsSecondHalf.push(JsValue(midpoint));
        jsPointsSecondHalf.push(JsValue(pointsCartesian.at(1)));
        return std::make_pair(jsPointsFirstHalf, jsPointsSecondHalf);
    }

    auto midpointIndex = pointsCartesian.size() / 2;
    for (auto i = midpointIndex; i >= 0; --i) {
        jsPointsFirstHalf.push(JsValue(pointsCartesian[i]));
    }
    for (auto i = midpointIndex; i < pointsCartesian.size(); ++i) {
        jsPointsSecondHalf.push(JsValue(pointsCartesian[i]));
    }
    return std::make_pair(jsPointsFirstHalf, jsPointsSecondHalf);
}

JsValue
FeatureLayerVisualization::encodeVerticesAsFloat64Array(std::vector<mapget::Point> const& pointsCartesian)
{
    std::vector<double> cartesianCoords;
    cartesianCoords.reserve(pointsCartesian.size() * 3);
    for (auto const& p : pointsCartesian) {
        cartesianCoords.emplace_back(p.x);
        cartesianCoords.emplace_back(p.y);
        cartesianCoords.emplace_back(p.z);
    }
    return JsValue::Float64Array(cartesianCoords);
}

CesiumPrimitive& FeatureLayerVisualization::getPrimitiveForDashMaterial(const FeatureStyleRule &rule) {
    const auto key = std::tuple<std::string, std::string, uint32_t, uint32_t>{rule.colorString(), rule.gapColorString(), rule.dashLength(), rule.dashPattern()};
    auto& dashMap = rule.flat() ? dashGroundLines_ : dashLines_;
    auto iter = dashMap.find(key);
    if (iter != dashMap.end()) {
        return iter->second;
    }
    return dashMap.emplace(key, CesiumPrimitive::withPolylineDashMaterialAppearance(rule, rule.flat())).first->second;
}

CesiumPrimitive& FeatureLayerVisualization::getPrimitiveForArrowMaterial(const FeatureStyleRule &rule) {
    const std::string key = rule.colorString();
    auto& arrowMap = rule.flat() ? arrowGroundLines_ : arrowLines_;
    auto iter = arrowMap.find(key);
    if (iter != arrowMap.end()) {
        return iter->second;
    }
    return arrowMap.emplace(key, CesiumPrimitive::withPolylineArrowMaterialAppearance(rule, rule.flat())).first->second;
}

void erdblick::FeatureLayerVisualization::addLine(
    const Point& wgsA,
    const Point& wgsB,
    uint32_t id,
    const erdblick::FeatureStyleRule& rule)
{
    addPolyLine({wgsToCartesian<mapget::Point>(wgsA), wgsToCartesian<mapget::Point>(wgsB)}, rule, id);
}

void FeatureLayerVisualization::addPolyLine(std::vector<mapget::Point> const& vertsCartesian, const FeatureStyleRule& rule, uint32_t id)
{
    if (rule.hasArrow() && rule.hasDoubleArrow()) {
        auto jsVertsPair = encodeVerticesAsReversedSplitList(vertsCartesian);
        getPrimitiveForArrowMaterial(rule).addPolyLine(jsVertsPair.first, rule, id);
        getPrimitiveForArrowMaterial(rule).addPolyLine(jsVertsPair.second, rule, id);
        return;
    }

    auto jsVerts = encodeVerticesAsList(vertsCartesian);
    if (rule.hasArrow()) {
        getPrimitiveForArrowMaterial(rule).addPolyLine(jsVerts, rule, id);
    }
    else if (rule.isDashed()) {
        getPrimitiveForDashMaterial(rule).addPolyLine(jsVerts, rule, id);
    }
    else if (rule.flat()) {
        coloredGroundLines_.addPolyLine(jsVerts, rule, id);
    }
    else {
        coloredLines_.addPolyLine(jsVerts, rule, id);
    }
}

RecursiveRelationVisualizationState::RecursiveRelationVisualizationState(
    const FeatureStyleRule& rule,
    mapget::model_ptr<mapget::Feature> f,
    FeatureLayerVisualization& visu)
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
                // Check if the relation type name is accepted for the rule.
                if (auto const& relTypeRegex = rule_.relationType()) {
                    auto relationTypeId = relation->name();
                    if (!std::regex_match(relationTypeId.begin(), relationTypeId.end(), *relTypeRegex)) {
                        return true;
                    }
                }

                // Resolve target feature.
                auto targetRef = relation->target();
                auto targetFeature =
                    visu_.tile_->find(targetRef->typeId(), targetRef->keyValuePairs());

                // Check if the target feature already has a reference to me.
                auto relationsForTargetIt =
                    relationsByFeatureAddr_.find({&targetFeature->model(), targetFeature->addr().value_});
                if (rule_.relationMergeTwoWay()) {
                    if (relationsForTargetIt != relationsByFeatureAddr_.end()) {
                        for (auto& relVisu : relationsForTargetIt->second) {
                            if (relVisu.targetFeature_->addr() == nextFeature->addr()) {
                                relVisu.twoway_ = true;
                                return true;
                            }
                        }
                    }
                }
                if (onlyUpdateTwowayFlags)
                    return true;

                // Create new relation-to-visualize.
                auto& relationsForThisFeature =
                    relationsByFeatureAddr_[{&nextFeature->model(), nextFeature->addr().value_}];
                auto& newRelationVisu = relationsForThisFeature.emplace_back();
                newRelationVisu.relation_ = relation;
                newRelationVisu.sourceFeature_ = nextFeature;

                if (targetFeature) {
                    // We got an additional feature to explore. But do it only
                    // if we haven't explored it yet.
                    if (rule_.relationRecursive() &&
                        (relationsForTargetIt != relationsByFeatureAddr_.end()))
                    {
                        unexploredRelations_.emplace_back(targetFeature);
                    }
                }
                else {
                    // Add the relation to externals, if we could not resolve it.
                    // It will be finalized later, via processResolvedExternalRelations().
                    visu_.externalRelationVisualizations_.emplace_back(this, &newRelationVisu);

                    JsValue featureIdParts = JsValue::List();
                    for (auto const& [key, value] : relation->target()->keyValuePairs()) {
                        featureIdParts.push(JsValue(key));
                        std::visit([&featureIdParts](auto&& v){
                            featureIdParts.push(JsValue(v));
                        }, value);
                    }

                    JsValue newExtReferenceToResolve = JsValue::Dict();
                    newExtReferenceToResolve.set("typeId", JsValue(relation->target()->typeId()));
                    newExtReferenceToResolve.set("featureId", featureIdParts);
                    visu_.externalRelationReferences_.push(newExtReferenceToResolve);
                }

                return true;
            });
    }

    // Render completed relation visualisations.
    for (auto& [_, relationVisuList] : relationsByFeatureAddr_) {
        for (auto& relVisu : relationVisuList) {
            if (relVisu.readyToRender()) {
                render(relVisu);
            }
        }
    }
}

void RecursiveRelationVisualizationState::render(
    RecursiveRelationVisualizationState::RelationToVisualize& r)
{
    // Create simfil evaluation context for the rule.
    simfil::OverlayNode relationEvaluationContext(*r.relation_);

    // Assemble simfil evaluation context.
    // TODO: There is bug here: If the target feature comes
    //  from a different node, it must be translated into the
    //  same field namespace for simfil to work. The best way
    //  to do that would be to add a feature copy ctor to simfil,
    //  then we can do this:
    // if (targetFeature->model().nodeId() != feature->model().nodeId()) {
    //     targetFeature = feature->model().newFeature(*targetFeature);
    // }
    relationEvaluationContext.set(
        visu_.tile_->fieldNames()->emplace("$source"),
        simfil::Value::field(*r.sourceFeature_));
    relationEvaluationContext.set(
        visu_.tile_->fieldNames()->emplace("$target"),
        simfil::Value::field(*r.targetFeature_));
    relationEvaluationContext.set(
        visu_.tile_->fieldNames()->emplace("$twoway"),
        simfil::Value(r.twoway_));

    // Obtain source/target geometries.
    auto sourceGeom = r.relation_->hasSourceValidity() ?
        r.relation_->sourceValidity() :
        r.sourceFeature_->firstGeometry();
    auto targetGeom = r.relation_->hasTargetValidity() ?
        r.relation_->targetValidity() :
        r.targetFeature_->firstGeometry();

    // Create line geometry which connects source and target feature.
    if (sourceGeom && targetGeom)
    {
        auto p1lo = geometryCenter(sourceGeom);
        auto p2lo = geometryCenter(targetGeom);
        auto p1hi = Point{p1lo.x, p1lo.y, p1lo.z + rule_.relationLineHeightOffset()};
        auto p2hi = Point{p2lo.x, p2lo.y, p2lo.z + rule_.relationLineHeightOffset()};

        if (rule_.width() > 0) {
            visu_.addLine(p1hi, p2hi, UnselectableId, rule_);
        }
        if (rule_.relationLineEndMarkerStyle()) {
            visu_.addLine(p1lo, p1hi, UnselectableId, *rule_.relationLineEndMarkerStyle());
            visu_.addLine(p2lo, p2hi, UnselectableId, *rule_.relationLineEndMarkerStyle());
        }
    }

    // Run source geometry visualization.
    if (auto sourceRule = rule_.relationSourceStyle()) {
        visu_.addGeometry(sourceGeom, UnselectableId, *sourceRule);
    }

    // Run target geometry visualization.
    if (auto targetRule = rule_.relationSourceStyle()) {
        visu_.addGeometry(targetGeom, UnselectableId, *targetRule);
    }

    r.rendered_ = true;
}

bool RecursiveRelationVisualizationState::RelationToVisualize::readyToRender() const
{
    return relation_ && sourceFeature_ && targetFeature_ && !rendered_;
}

}  // namespace erdblick
