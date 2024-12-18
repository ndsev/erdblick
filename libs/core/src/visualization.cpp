#include "visualization.h"
#include "cesium-interface/point-conversion.h"
#include "cesium-interface/primitive.h"
#include "geometry.h"

#include <iostream>

#include "cesium-interface/billboards.h"

using namespace mapget;

namespace erdblick
{

namespace {
uint32_t fvec4ToInt(glm::fvec4 const& v) {
    return (
        (static_cast<uint32_t>(v.r * 255) << 24) | (static_cast<uint32_t>(v.g * 255) << 16) |
        (static_cast<uint32_t>(v.b * 255) << 8) | static_cast<uint32_t>(v.a * 255));
}
}

FeatureLayerVisualization::FeatureLayerVisualization(
    std::string const& mapTileKey,
    const FeatureLayerStyle& style,
    NativeJsValue const& rawOptionValues,
    NativeJsValue const& rawFeatureMergeService,
    FeatureStyleRule::HighlightMode const& highlightMode,
    NativeJsValue const& rawFeatureIdSubset)
    : mapTileKey_(mapTileKey),
      coloredLines_(CesiumPrimitive::withPolylineColorAppearance(false)),
      coloredNontrivialMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(false, false)),
      coloredTrivialMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(true)),
      coloredGroundLines_(CesiumPrimitive::withPolylineColorAppearance(true)),
      coloredGroundMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(true, true)),
      featureMergeService_(rawFeatureMergeService),
      style_(style),
      highlightMode_(highlightMode),
      externalRelationReferences_(JsValue::List())
{
    // Convert option values dict to simfil values.
    auto optionValues = JsValue(rawOptionValues);
    for (auto const& option : style.options()) {
        auto stringValue = JsValue(option.defaultValue_).toString();
        simfil::Value simfilValue = simfil::Value::make(false);
        if (optionValues.has(option.id_)) {
            stringValue = optionValues[option.id_].toString();
        }
        option.convertValue(stringValue, [&simfilValue](auto&& v){
            simfilValue = simfil::Value::make(v);
        });
        optionValues_.emplace(option.id_, std::move(simfilValue));
    }

    // Convert feature ID subset.
    auto featureIdSubset = JsValue(rawFeatureIdSubset);
    for (auto i = 0; i < featureIdSubset.size(); ++i) {
        featureIdSubset_.insert(featureIdSubset.at(i).as<std::string>());
    }
}

FeatureLayerVisualization::~FeatureLayerVisualization() = default;

void FeatureLayerVisualization::addTileFeatureLayer(TileFeatureLayer const& tile)
{
    if (!tile_) {
        tile_ = tile.model_;
        internalStringPoolCopy_ = std::make_shared<simfil::StringPool>(*tile.model_->strings());

        // Pre-create empty merged point feature visualization lists.
        for (auto&& rule : style_.rules()) {
            if (rule.mode() != highlightMode_ || !rule.pointMergeGridCellSize()) {
                continue;
            }
            mergedPointsPerStyleRuleId_.emplace(
                getMapLayerStyleRuleId(rule.index()),
                std::map<std::string, std::pair<std::unordered_set<std::string>, std::optional<JsValue>>>());
        }
    }


    // Ensure that the added aux tile and the primary tile use the same
    // field name encoding. So we transcode the aux tile into the same dict.
    // However, the transcoding process changes the dictionary, as it might
    // add unknown field names. This would fork the dict state from the remote
    // node dict, which leads to undefined behavior. So we work on a copy of it.
    tile.model_->setStrings(internalStringPoolCopy_);
    allTiles_.emplace_back(tile.model_);
}

void FeatureLayerVisualization::run()
{
    for (auto&& feature : *tile_) {
        auto const& constFeature = static_cast<mapget::Feature const&>(*feature);
        simfil::OverlayNode evaluationContext(simfil::Value::field(constFeature));
        addOptionsToSimfilContext(evaluationContext);
        auto boundEvalFun = BoundEvalFun{
            evaluationContext,
            [this, &evaluationContext](auto&& str)
            {
                return evaluateExpression(str, evaluationContext);
            }};

        for (auto&& rule : style_.rules()) {
            if (rule.mode() != highlightMode_) {
                continue;
            }
            auto mapLayerStyleRuleId = getMapLayerStyleRuleId(rule.index());
            if (auto* matchingSubRule = rule.match(*feature, boundEvalFun)) {
                addFeature(feature, boundEvalFun, *matchingSubRule, mapLayerStyleRuleId);
                featuresAdded_ = true;
            }
        }
    }
}

std::string FeatureLayerVisualization::getMapLayerStyleRuleId(uint32_t ruleIndex) const
{
    return fmt::format(
        "{}:{}:{}:{}:{}",
        tile_->mapId(),
        tile_->layerInfo()->layerId_,
        style_.name(),
        static_cast<uint32_t>(highlightMode_),
        ruleIndex);
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
    if (!labelCollection_.empty())
        collection.call<void>("add", labelCollection_.toJsObject());
    if (!billboardCollection_.empty())
        collection.call<void>("add", billboardCollection_.toJsObject());
    return *collection;
}

NativeJsValue FeatureLayerVisualization::mergedPointFeatures() const
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

void FeatureLayerVisualization::addFeature(
    model_ptr<Feature>& feature,
    BoundEvalFun& evalFun,
    FeatureStyleRule const& rule,
    std::string const& mapLayerStyleRuleId)
{
    auto featureId = feature->id()->toString();
    if (!featureIdSubset_.empty()) {
        bool isAllowed = false;
        for (auto const& allowedFeatureId : featureIdSubset_) {
            // The featureId may also refer to an attribute,
            // in this case :attribute#<NUMBER> is appended to the string.
            if (allowedFeatureId == featureId || allowedFeatureId.starts_with(featureId + ':')) {
                isAllowed = true;
                break;
            }
        }
        if (!isAllowed) {
            return;
        }
    }

    auto offset = localWgs84UnitCoordinateSystem(feature->firstGeometry()) * rule.offset();

    switch(rule.aspect()) {
    case FeatureStyleRule::Feature: {
        feature->geom()->forEachGeometry(
            [this, featureId, &rule, &mapLayerStyleRuleId, &evalFun, &offset](auto&& geom)
            {
                if (rule.supports(geom->geomType(), geom->name()))
                    addGeometry(geom, featureId, rule, mapLayerStyleRuleId, evalFun, offset);
                return true;
            });
        break;
    }
    case FeatureStyleRule::Relation: {
        relationStyleState_.emplace_back(rule, feature, *this);
        break;
    }
    case FeatureStyleRule::Attribute: {
        // Use const-version of the attribute layers, so the feature does not
        // lazily initialize its attribute layer list.
        auto attrLayers = feature->attributeLayersOrNull();
        if (!attrLayers)
            break;

        uint32_t offsetFactor = 0;
        uint32_t attrIndex = 0;
        attrLayers->forEachLayer([&, this](auto&& layerName, auto&& layer){
            // Check if the attribute layer name is accepted for the rule.
            if (auto const& attrLayerTypeRegex = rule.attributeLayerType()) {
                if (!std::regex_match(layerName.begin(), layerName.end(), *attrLayerTypeRegex)) {
                    attrIndex += layer->size();
                    return true;
                }
            }
            // Iterate over all the layer's attributes.
            layer->forEachAttribute([&, this](auto&& attr){
                if (!featureIdSubset_.empty() && highlightMode_ == FeatureStyleRule::HoverHighlight) {
                     if (!featureIdSubset_.contains(fmt::format("{}:attribute#{}", featureId, attrIndex))) {
                         attrIndex++;
                         return true;
                     }
                }
                attrIndex++;
                addAttribute(
                    feature,
                    layerName,
                    attr,
                    featureId, // TODO: Rethink, how an attribute link may be encoded in the id.
                    rule,
                    mapLayerStyleRuleId,
                    offsetFactor,
                    offset);
                return true;
            });
            return true;
        });
        break;
    }
    }
}

void FeatureLayerVisualization::addGeometry(
    model_ptr<Geometry> const& geom,
    std::string_view id,
    FeatureStyleRule const& rule,
    std::string const& mapLayerStyleRuleId,
    BoundEvalFun& evalFun,
    glm::dvec3 const& offset)
{
    if (!geom) {
        return;
    }
    addGeometry(geom->toSelfContained(), id, rule, mapLayerStyleRuleId, evalFun, offset);
}

void FeatureLayerVisualization::addGeometry(
    SelfContainedGeometry const& geom,
    std::string_view id,
    FeatureStyleRule const& rule,
    std::string const& mapLayerStyleRuleId,
    BoundEvalFun& evalFun,
    glm::dvec3 const& offset)
{
    if (!rule.supports(geom.geomType_))
        return;

    // Combine the ID with the mapTileKey to create an
    // easy link from the geometry back to the feature.
    auto tileFeatureId = JsValue::Undefined();
    if (rule.selectable()) {
        switch (highlightMode_) {
        case FeatureStyleRule::NoHighlight:
            tileFeatureId = makeTileFeatureId(id);
            break;
        case FeatureStyleRule::HoverHighlight:
            tileFeatureId = JsValue("hover-highlight");
            break;
        case FeatureStyleRule::SelectionHighlight:
            tileFeatureId = JsValue("selection-highlight");
            break;
        }
    }

    std::vector<mapget::Point> vertsCartesian;
    vertsCartesian.reserve(geom.points_.size());
    for (auto const& vertCarto : geom.points_) {
        vertsCartesian.emplace_back(wgsToCartesian<Point>(vertCarto, offset));
    }

    switch (geom.geomType_) {
    case GeomType::Polygon:
        if (vertsCartesian.size() >= 3) {
            auto jsVerts = encodeVerticesAsList(vertsCartesian);
            if (rule.flat())
                coloredGroundMeshes_.addPolygon(jsVerts, rule, tileFeatureId, evalFun);
            else
                coloredNontrivialMeshes_.addPolygon(jsVerts, rule, tileFeatureId, evalFun);
        }
        break;
    case GeomType::Line:
        addPolyLine(vertsCartesian, rule, tileFeatureId, evalFun);
        break;
    case GeomType::Mesh:
        if (vertsCartesian.size() >= 3) {
            auto jsVerts = encodeVerticesAsFloat64Array(vertsCartesian);
            coloredTrivialMeshes_.addTriangles(jsVerts, rule, tileFeatureId, evalFun);
        }
        break;
    case GeomType::Points:
        auto pointIndex = 0;
        for (auto const& pt : vertsCartesian) {
            // If a merge-grid cell size is set, then a merged feature representation was requested.
            if (auto const& gridCellSize = rule.pointMergeGridCellSize()) {
                addMergedPointGeometry(
                    id,
                    mapLayerStyleRuleId,
                    gridCellSize,
                    geom.points_[pointIndex],
                    "pointParameters",
                    evalFun,
                    [&](auto& augmentedEvalFun)
                    {
                        if (rule.hasIconUrl())
                            return CesiumBillboardCollection::billboardParams(
                                JsValue(pt),
                                rule,
                                tileFeatureId,
                                augmentedEvalFun);
                        return CesiumPointPrimitiveCollection::pointParams(
                            JsValue(pt),
                            rule,
                            tileFeatureId,
                            augmentedEvalFun);
                    });
            }
            else if (rule.hasIconUrl()) {
                billboardCollection_.addBillboard(JsValue(pt), rule, tileFeatureId, evalFun);
            }
            else {
                coloredPoints_.addPoint(JsValue(pt), rule, tileFeatureId, evalFun);
            }

            ++pointIndex;
        }
        break;
    }

    if (rule.hasLabel()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
            auto wgsPos = geometryCenter(geom);
            auto xyzPos = JsValue(wgsToCartesian<mapget::Point>(wgsPos, offset));

            // If a merge-grid cell size is set, then a merged feature representation was requested.
            if (auto const& gridCellSize = rule.pointMergeGridCellSize()) {
                addMergedPointGeometry(
                    id,
                    mapLayerStyleRuleId,
                    gridCellSize,
                    wgsPos,
                    "labelParameters",
                    evalFun,
                    [&](auto& augmentedEvalFun)
                    {
                        return CesiumLabelCollection::labelParams(
                            xyzPos,
                            text,
                            rule,
                            tileFeatureId,
                            augmentedEvalFun);
                    });
            }
            else
                labelCollection_.addLabel(
                    xyzPos,
                    text,
                    rule,
                    tileFeatureId,
                    evalFun);
        }
    }
}

void FeatureLayerVisualization::addMergedPointGeometry(
    const std::string_view& id,
    const std::string& mapLayerStyleRuleId,
    const std::optional<glm::dvec3>& gridCellSize,
    mapget::Point const& pointCartographic,
    const char* geomField,
    BoundEvalFun& evalFun,
    std::function<JsValue(BoundEvalFun&)> const& makeGeomParams)
{
    // Convert the cartographic point to an integer representation, based
    // on the grid cell size set in the style sheet.
    auto gridPosition = pointCartographic / *gridCellSize;
    auto gridPositionHash = fmt::format(
        "{}:{}:{}",
        static_cast<int64_t>(glm::floor(gridPosition.x)),
        static_cast<int64_t>(glm::floor(gridPosition.y)),
        static_cast<int64_t>(glm::floor(gridPosition.z)));

    // Add the $mergeCount variable to the evaluation context.
    // This variable indicates, how many features from other tiles have already been added
    // for the given grid position. We must sum both existing points in the point merge service
    // from other tiles, and existing points from this tile.
    auto& [mergedPointFeatureSet, mergedPointVisu] =
        mergedPointsPerStyleRuleId_[mapLayerStyleRuleId][gridPositionHash];
    auto [_, featureIdIsNew] = mergedPointFeatureSet.emplace(id);
    auto mergedPointCount = featureMergeService_.call<int32_t>(
        "count",
        pointCartographic,
        gridPositionHash,
        tile_->tileId().z(),
        mapLayerStyleRuleId) + static_cast<int32_t>(mergedPointFeatureSet.size());
    evalFun.context_.set(
        internalStringPoolCopy_->emplace("$mergeCount"),
        simfil::Value(mergedPointCount));

    // Add a MergedPointVisualization to the list.
    if (!mergedPointVisu) {
        mergedPointVisu = JsValue::Dict({
            {"position", JsValue(pointCartographic)},
            {"positionHash", JsValue(gridPositionHash)},
            {geomField, JsValue(makeGeomParams(evalFun))},
            {"featureIds", JsValue::List({makeTileFeatureId(id)})},
        });
    }
    else {
        mergedPointVisu->set(geomField, JsValue(makeGeomParams(evalFun)));
        if (featureIdIsNew) {
            (*mergedPointVisu)["featureIds"].push(makeTileFeatureId(id));
        }
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

    auto midpointIndex = static_cast<int32_t>(pointsCartesian.size() / 2);
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

CesiumPrimitive& FeatureLayerVisualization::getPrimitiveForDashMaterial(
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

CesiumPrimitive& FeatureLayerVisualization::getPrimitiveForArrowMaterial(
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

void erdblick::FeatureLayerVisualization::addLine(
    const Point& wgsA,
    const Point& wgsB,
    std::string_view const& id,
    const erdblick::FeatureStyleRule& rule,
    BoundEvalFun& evalFun,
    glm::dvec3 const& offset,
    double labelPositionHint)
{
    auto cartA = wgsToCartesian<glm::dvec3>(wgsA, offset);
    auto cartB = wgsToCartesian<glm::dvec3>(wgsB, offset);

    // Combine the ID with the mapTileKey to create an
    // easy link from the geometry back to the feature.
    auto tileFeatureId = makeTileFeatureId(id);

    addPolyLine(
        {cartA, cartB},
        rule,
        tileFeatureId,
        evalFun);

    if (rule.hasLabel()) {
        auto text = rule.labelText(evalFun);
        if (!text.empty()) {
            labelCollection_.addLabel(
                JsValue(mapget::Point(cartA + (cartB - cartA) * labelPositionHint)),
                text,
                rule,
                tileFeatureId,
                evalFun);
        }
    }
}

void FeatureLayerVisualization::addPolyLine(
    std::vector<mapget::Point> const& vertsCartesian,
    const FeatureStyleRule& rule,
    JsValue const& tileFeatureId,
    BoundEvalFun& evalFun)
{
    if (vertsCartesian.size() < 2)
        return;

    auto arrowType = rule.arrow(evalFun);

    if (arrowType == FeatureStyleRule::DoubleArrow) {
        auto jsVertsPair = encodeVerticesAsReversedSplitList(vertsCartesian);
        auto& primitive = getPrimitiveForArrowMaterial(rule, evalFun);
        primitive.addPolyLine(jsVertsPair.first, rule, tileFeatureId, evalFun);
        primitive.addPolyLine(jsVertsPair.second, rule, tileFeatureId, evalFun);
        return;
    }

    auto jsVerts = encodeVerticesAsList(vertsCartesian);
    if (arrowType == FeatureStyleRule::ForwardArrow) {
        getPrimitiveForArrowMaterial(rule, evalFun).addPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
    else if (arrowType == FeatureStyleRule::BackwardArrow) {
        jsVerts.call<void>("reverse");
        getPrimitiveForArrowMaterial(rule, evalFun).addPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
    else if (rule.isDashed()) {
        getPrimitiveForDashMaterial(rule, evalFun).addPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
    else if (rule.flat()) {
        coloredGroundLines_.addPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
    else {
        coloredLines_.addPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
}

simfil::Value FeatureLayerVisualization::evaluateExpression(
    const std::string& expression,
    const simfil::ModelNode& ctx) const
{
    try
    {
        auto results = tile_->evaluate(expression, ctx);
        if (!results.empty()) {
            return std::move(results[0]);
        }
    }
    catch (std::exception const& e) {
        std::cout << "Error evaluating " << expression << ": " << e.what() << std::endl;
        return simfil::Value::null();
    }

    std::cout << "Expression " << expression << " returned nothing." << std::endl;
    return simfil::Value::null();
}

void FeatureLayerVisualization::addAttribute(
    model_ptr<Feature> const& feature,
    std::string_view const& layer,
    model_ptr<Attribute> const& attr,
    std::string_view const& id,
    const FeatureStyleRule& rule,
    std::string const& mapLayerStyleRuleId,
    uint32_t& offsetFactor,
    glm::dvec3 const& offset)
{
    // Check if the attribute type name is accepted for the rule.
    if (auto const& attrTypeRegex = rule.attributeType()) {
        auto attributeTypeId = attr->name();
        if (!std::regex_match(attributeTypeId.begin(), attributeTypeId.end(), *attrTypeRegex)) {
            return;
        }
    }

    // Check if the attribute validity is accepted for the rule.
    if (auto const& validityGeomRequired = rule.attributeValidityGeometry()) {
        if (*validityGeomRequired != (attr->validityOrNull() && attr->validityOrNull()->size())) {
            return;
        }
    }

    // Create simfil evaluation context for the rule.
    auto const& constAttr = static_cast<mapget::Attribute const&>(*attr);
    auto const& constFeature = static_cast<mapget::Feature const&>(*feature);

    simfil::OverlayNode attrEvaluationContext(simfil::Value::field(constAttr));
    addOptionsToSimfilContext(attrEvaluationContext);

    // Assemble simfil evaluation context.
    attrEvaluationContext
        .set(
        internalStringPoolCopy_->emplace("$name"),
        simfil::Value(attr->name()));
    attrEvaluationContext
        .set(
        internalStringPoolCopy_->emplace("$feature"),
        simfil::Value::field(constFeature));
    attrEvaluationContext
        .set(
        internalStringPoolCopy_->emplace("$layer"),
        simfil::Value(layer));


    // Function which can evaluate a simfil expression in the attribute context.
    auto boundEvalFun = BoundEvalFun{
        attrEvaluationContext,
        [this, &attrEvaluationContext](auto&& str)
        {
            return evaluateExpression(str, attrEvaluationContext);
        }};

    // Bump visual offset factor for next visualized attribute.
    ++offsetFactor;

    // Check if the attribute's values match the attribute filter for the rule.
    if (auto const& attrFilter = rule.attributeFilter()) {
        if (!attrFilter->empty()) {
            auto result = boundEvalFun.eval_(*attrFilter);
            if ((result.isa(simfil::ValueType::Bool) && !result.template as<simfil::ValueType::Bool>()) ||
                result.isa(simfil::ValueType::Undef) || result.isa(simfil::ValueType::Null)) {
                return;
            }
        }
    }

    // Draw validity geometry.
    if (auto multiValidity = attr->validityOrNull()) {
        multiValidity->forEach([&, this](auto&& validity)
        {
            addGeometry(
                validity.computeGeometry(feature->geomOrNull()),
                id,
                rule,
                mapLayerStyleRuleId,
                boundEvalFun,
                offset * static_cast<double>(offsetFactor));
            return true;
        });
    }
    else {
        addGeometry(
            feature->firstGeometry(),
            id,
            rule,
            mapLayerStyleRuleId,
            boundEvalFun,
            offset * static_cast<double>(offsetFactor));
    }
}

void FeatureLayerVisualization::addOptionsToSimfilContext(simfil::OverlayNode& context)
{
    for (auto const& [key, value] : optionValues_) {
        context.set(internalStringPoolCopy_->emplace(key), value);
    }
}

JsValue FeatureLayerVisualization::makeTileFeatureId(const std::string_view& featureId) const
{
    return JsValue::Dict({
        {"mapTileKey", mapTileKey_},
        {"featureId", JsValue(std::string(featureId))}
    });
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

    simfil::OverlayNode relationEvaluationContext(simfil::Value::field(constRelation));
    visu_.addOptionsToSimfilContext(relationEvaluationContext);

    // Assemble simfil evaluation context.
    relationEvaluationContext.set(
        visu_.internalStringPoolCopy_->emplace("$source"),
        simfil::Value::field(constSource));
    relationEvaluationContext.set(
        visu_.internalStringPoolCopy_->emplace("$target"),
        simfil::Value::field(constTarget));
    relationEvaluationContext.set(
        visu_.internalStringPoolCopy_->emplace("$twoway"),
        simfil::Value(r.twoway_));

    // Function which can evaluate a simfil expression in the relation context.
    auto boundEvalFun = BoundEvalFun{
        relationEvaluationContext,
        [this, &relationEvaluationContext](auto&& str)
        {
            return visu_.evaluateExpression(str, relationEvaluationContext);
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
    auto targetGeoms = convertMultiValidityWithFallback(r.relation_->sourceValidityOrNull(), r.sourceFeature_);;

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
            visu_.addLine(p1hi, p2hi, UnselectableId, rule_, boundEvalFun, offset);
        }
        if (rule_.relationLineEndMarkerStyle()) {
            if (visualizedFeatures_.emplace(sourceId + "-endmarker").second)
                visu_.addLine(
                    p1lo,
                    p1hi,
                    UnselectableId,
                    *rule_.relationLineEndMarkerStyle(),
                    boundEvalFun,
                    offsetBase * rule_.relationLineEndMarkerStyle()->offset());
            if (visualizedFeatures_.emplace(targetId + "-endmarker").second)
                visu_.addLine(
                    p2lo,
                    p2hi,
                    UnselectableId,
                    *rule_.relationLineEndMarkerStyle(),
                    boundEvalFun,
                    offsetBase * rule_.relationLineEndMarkerStyle()->offset());
        }
    }

    // Run source geometry visualization.
    if (visualizedFeatures_.emplace(sourceId).second) {
        if (auto sourceRule = rule_.relationSourceStyle()) {
            for (auto const& sourceGeom : sourceGeoms) {
                if (sourceGeom.points_.empty()) continue;
                    visu_.addGeometry(sourceGeom, UnselectableId, *sourceRule, "", boundEvalFun, offsetBase * sourceRule->offset());
            }
        }
    }

    // Run target geometry visualization.
    if (visualizedFeatures_.emplace(targetId).second) {
        if (auto targetRule = rule_.relationTargetStyle()) {
            for (auto const& targetGeom : targetGeoms) {
                if (targetGeom.points_.empty()) continue;
                    visu_.addGeometry(targetGeom, UnselectableId, *targetRule, "", boundEvalFun, offsetBase * targetRule->offset());
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
