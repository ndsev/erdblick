#include "visualization-base.h"
#include "geometry.h"
#include "mapget/model/simfilutil.h"
#include "simfil/simfil.h"

#include <algorithm>
#include <charconv>
#include <deque>
#include <iostream>
#include <regex>
#include <type_traits>
#include <unordered_map>

using namespace mapget;

namespace erdblick
{

namespace {
constexpr uint32_t geomTypeBit(mapget::GeomType const& g) {
    return 1u << static_cast<std::underlying_type_t<mapget::GeomType>>(g);
}

struct ParsedHoverAttributeId {
    std::string_view baseFeatureId_;
    uint32_t attributeIndex_ = 0;
    std::optional<uint32_t> validityIndex_;
};

std::optional<uint32_t> parseTrailingUint(std::string_view value) {
    uint32_t parsed = 0;
    auto const* begin = value.data();
    auto const* end = value.data() + value.size();
    auto result = std::from_chars(begin, end, parsed);
    if (result.ec != std::errc() || result.ptr != end) {
        return std::nullopt;
    }
    return parsed;
}

std::string_view stripFeatureIdSuffix(std::string_view featureId) {
    constexpr std::string_view attributeSuffix = ":attribute#";
    constexpr std::string_view relationSuffix = ":relation#";
    auto cut = std::string_view::npos;
    if (auto pos = featureId.find(attributeSuffix); pos != std::string_view::npos) {
        cut = pos;
    }
    if (auto pos = featureId.find(relationSuffix); pos != std::string_view::npos) {
        cut = (cut == std::string_view::npos) ? pos : std::min(cut, pos);
    }
    if (cut == std::string_view::npos) {
        return featureId;
    }
    return featureId.substr(0, cut);
}

std::optional<ParsedHoverAttributeId> parseHoverAttributeId(std::string_view featureId) {
    constexpr std::string_view attributeSuffix = ":attribute#";
    constexpr std::string_view validitySuffix = ":validity#";
    auto const attributePos = featureId.find(attributeSuffix);
    if (attributePos == std::string_view::npos) {
        return std::nullopt;
    }

    auto const attributeValueStart = attributePos + attributeSuffix.size();
    auto const validityPos = featureId.find(validitySuffix, attributeValueStart);
    auto const attributeValueEnd =
        validityPos == std::string_view::npos ? featureId.size() : validityPos;
    auto const attributeIndex =
        parseTrailingUint(featureId.substr(attributeValueStart, attributeValueEnd - attributeValueStart));
    if (!attributeIndex) {
        return std::nullopt;
    }

    ParsedHoverAttributeId result{
        .baseFeatureId_ = featureId.substr(0, attributePos),
        .attributeIndex_ = *attributeIndex
    };
    if (validityPos != std::string_view::npos) {
        result.validityIndex_ =
            parseTrailingUint(featureId.substr(validityPos + validitySuffix.size()));
        if (!result.validityIndex_) {
            return std::nullopt;
        }
    }
    return result;
}

std::string makeExpressionCacheKey(std::string_view expression, bool anyMode, bool autoWildcard) {
    std::string key;
    key.reserve(expression.size() + 3);
    key.push_back(anyMode ? '1' : '0');
    key.push_back(autoWildcard ? '1' : '0');
    key.push_back(':');
    key.append(expression);
    return key;
}

}

bool FeatureLayerVisualizationBase::RelationStyleState::RelationToVisualize::readyToRender() const
{
    return relation_ && sourceFeature_ && targetFeature_ && !rendered_;
}

FeatureLayerVisualizationBase::RelationStyleState::RelationStyleState(
    FeatureStyleRule const& rule,
    model_ptr<Feature> feature,
    FeatureLayerVisualizationBase& visualization)
    : rule_(rule),
      visualization_(visualization)
{
    unexploredFeatures_.emplace_back(std::move(feature));
    populateAndRender();
}

void FeatureLayerVisualizationBase::RelationStyleState::populateAndRender(bool onlyUpdateTwowayFlags)
{
    while (!unexploredFeatures_.empty()) {
        auto next = unexploredFeatures_.front();
        unexploredFeatures_.pop_front();

        next->forEachRelation([&](auto const& relation) {
            addRelation(next, relation, onlyUpdateTwowayFlags);
            return true;
        });
    }

    for (auto& [_, relationList] : relationsBySourceFeatureId_) {
        for (auto& relationToRender : relationList) {
            if (relationToRender.readyToRender()) {
                render(relationToRender);
            }
        }
    }
}

void FeatureLayerVisualizationBase::RelationStyleState::addRelation(
    model_ptr<Feature> const& sourceFeature,
    model_ptr<Relation> const& relation,
    bool onlyUpdateTwowayFlags)
{
    if (auto const& relationType = rule_.relationType()) {
        auto relationName = relation->name();
        if (!std::regex_match(relationName.begin(), relationName.end(), *relationType)) {
            return;
        }
    }

    auto const sourceId = sourceFeature->id()->toString();
    auto const targetRef = relation->target();
    auto const targetRefString = targetRef->toString();
    auto& relationsForSource = relationsBySourceFeatureId_[sourceId];
    for (auto const& existingRelation : relationsForSource) {
        if (existingRelation.relation_
            && existingRelation.relation_->target()->toString() == targetRefString) {
            return;
        }
    }

    auto targetFeature =
        visualization_.tile_->find(targetRef->typeId(), targetRef->keyValuePairs());

    auto relationsForTargetIt = relationsBySourceFeatureId_.end();
    if (targetFeature) {
        auto const targetId = targetFeature->id()->toString();
        relationsForTargetIt = relationsBySourceFeatureId_.find(targetId);
        if (rule_.relationMergeTwoWay() && relationsForTargetIt != relationsBySourceFeatureId_.end()) {
            for (auto& existingRelation : relationsForTargetIt->second) {
                if (existingRelation.targetFeature_
                    && existingRelation.targetFeature_->id()->toString() == sourceId) {
                    existingRelation.twoway_ = true;
                    return;
                }
            }
        }
    }

    if (onlyUpdateTwowayFlags) {
        return;
    }

    auto& newRelation = relationsForSource.emplace_back();
    newRelation.relation_ = relation;
    newRelation.sourceFeature_ = sourceFeature;
    if (targetFeature) {
        newRelation.targetFeature_ = targetFeature;
        if (rule_.relationRecursive()
            && relationsForTargetIt == relationsBySourceFeatureId_.end()) {
            unexploredFeatures_.emplace_back(targetFeature);
        }
        return;
    }
    visualization_.rememberExternalRelationReference(
        *this,
        &newRelation,
        targetRef);
}

std::vector<SelfContainedGeometry> FeatureLayerVisualizationBase::RelationStyleState::relationGeometries(
    model_ptr<MultiValidity> const& validities,
    model_ptr<Feature> const& feature)
{
    std::vector<SelfContainedGeometry> result;
    if (validities) {
        validities->forEach([&](auto&& validity) {
            result.emplace_back(validity.computeGeometry(feature->geomOrNull()));
            return true;
        });
    }
    if (result.empty()) {
        result.emplace_back(feature->firstGeometry());
    }
    return result;
}

void FeatureLayerVisualizationBase::RelationStyleState::render(RelationToVisualize& relationToRender)
{
    auto const& relation = static_cast<mapget::Relation const&>(*relationToRender.relation_);
    auto const& source = static_cast<mapget::Feature const&>(*relationToRender.sourceFeature_);
    auto const& target = static_cast<mapget::Feature const&>(*relationToRender.targetFeature_);

    auto relationContext =
        simfil::model_ptr<simfil::OverlayNode>::make(simfil::Value::field(relation));
    visualization_.addOptionsToSimfilContext(relationContext);
    relationContext->set(
        visualization_.internalStringPoolCopy_->emplace("$source").value(),
        simfil::Value::field(source));
    relationContext->set(
        visualization_.internalStringPoolCopy_->emplace("$target").value(),
        simfil::Value::field(target));
    relationContext->set(
        visualization_.internalStringPoolCopy_->emplace("$twoway").value(),
        simfil::Value(relationToRender.twoway_));

    auto boundEvalFun = BoundEvalFun{
        relationContext,
        [this, &relationContext](auto&& expression)
        {
            return visualization_.evaluateExpression(expression, *relationContext, false, false);
        }};

    auto const sourceGeometries =
        relationGeometries(relationToRender.relation_->sourceValidityOrNull(), relationToRender.sourceFeature_);
    auto const targetGeometries =
        relationGeometries(relationToRender.relation_->targetValidityOrNull(), relationToRender.targetFeature_);
    auto offsetBase = glm::dmat3x3(1.0);
    if (!sourceGeometries.empty() && !sourceGeometries.front().points_.empty()) {
        offsetBase = localWgs84UnitCoordinateSystem(sourceGeometries.front());
    }
    auto const relationOffset = offsetBase * rule_.offset();

    auto const sourceId = relationToRender.sourceFeature_->id()->toString();
    auto const targetId = relationToRender.targetFeature_->id()->toString();

    if (!sourceGeometries.empty()
        && !targetGeometries.empty()
        && !sourceGeometries.front().points_.empty()
        && !targetGeometries.front().points_.empty()) {
        auto const sourceCenter = geometryCenter(sourceGeometries.front());
        auto const targetCenter = geometryCenter(targetGeometries.front());
        auto const liftedSource = Point{
            sourceCenter.x,
            sourceCenter.y,
            sourceCenter.z + rule_.relationLineHeightOffset()};
        auto const liftedTarget = Point{
            targetCenter.x,
            targetCenter.y,
            targetCenter.z + rule_.relationLineHeightOffset()};

        if (rule_.width() > 0.0f) {
            visualization_.addLine(
                liftedSource,
                liftedTarget,
                FeatureLayerVisualizationBase::kUnselectableFeatureId,
                rule_,
                boundEvalFun,
                relationOffset);
        }
        if (auto lineEndMarkerStyle = rule_.relationLineEndMarkerStyle()) {
            if (visualizedFeatureParts_.emplace(sourceId + "-line-end-marker").second) {
                visualization_.addLine(
                    sourceCenter,
                    liftedSource,
                    FeatureLayerVisualizationBase::kUnselectableFeatureId,
                    *lineEndMarkerStyle,
                    boundEvalFun,
                    offsetBase * lineEndMarkerStyle->offset());
            }
            if (visualizedFeatureParts_.emplace(targetId + "-line-end-marker").second) {
                visualization_.addLine(
                    targetCenter,
                    liftedTarget,
                    FeatureLayerVisualizationBase::kUnselectableFeatureId,
                    *lineEndMarkerStyle,
                    boundEvalFun,
                    offsetBase * lineEndMarkerStyle->offset());
            }
        }
    }

    if (auto sourceStyle = rule_.relationSourceStyle();
        sourceStyle && visualizedFeatureParts_.emplace(sourceId).second) {
        for (auto const& sourceGeometry : sourceGeometries) {
            if (sourceGeometry.points_.empty()) {
                continue;
            }
            visualization_.addGeometry(
                sourceGeometry,
                std::nullopt,
                FeatureLayerVisualizationBase::kUnselectableFeatureId,
                *sourceStyle,
                "",
                boundEvalFun,
                offsetBase * sourceStyle->offset());
        }
    }

    if (auto targetStyle = rule_.relationTargetStyle();
        targetStyle && visualizedFeatureParts_.emplace(targetId).second) {
        for (auto const& targetGeometry : targetGeometries) {
            if (targetGeometry.points_.empty()) {
                continue;
            }
            visualization_.addGeometry(
                targetGeometry,
                std::nullopt,
                FeatureLayerVisualizationBase::kUnselectableFeatureId,
                *targetStyle,
                "",
                boundEvalFun,
                offsetBase * targetStyle->offset());
        }
    }

    relationToRender.rendered_ = true;
}

FeatureLayerVisualizationBase::FeatureLayerVisualizationBase(
    int viewIndex,
    std::string const& mapTileKey,
    const FeatureLayerStyle& style,
    NativeJsValue const& rawOptionValues,
    FeatureStyleRule::HighlightMode const& highlightMode,
    FeatureStyleRule::Fidelity fidelity,
    int highFidelityStage,
    int maxLowFiLod,
    GeometryOutputMode geometryOutputMode,
    NativeJsValue const& rawFeatureIdSubset,
    NativeJsValue const& rawFeatureMergeService)
    : viewIndex_(viewIndex),
      style_(style),
      highlightMode_(highlightMode),
      fidelity_(fidelity),
      highFidelityStage_(std::max(0, highFidelityStage)),
      maxLowFiLod_(std::clamp(maxLowFiLod, -1, 7)),
      geometryOutputMode_(geometryOutputMode),
      featureMergeService_(rawFeatureMergeService)
{
    (void) mapTileKey;
    externalRelationReferences_ = JsValue::List();
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
        auto featureId = featureIdSubset.at(i).as<std::string>();
        featureIdSubset_.insert(featureId);
        featureIdBaseSubset_.insert(std::string(stripFeatureIdSuffix(featureId)));
        if (auto parsedHoverAttributeId = parseHoverAttributeId(featureId)) {
            auto& hoveredAttributeSubset =
                hoveredAttributeSubsetsByFeatureId_[std::string(parsedHoverAttributeId->baseFeatureId_)];
            if (parsedHoverAttributeId->validityIndex_) {
                hoveredAttributeSubset
                    .hoveredValidityIndicesByAttribute_[parsedHoverAttributeId->attributeIndex_]
                    .insert(*parsedHoverAttributeId->validityIndex_);
            }
            else {
                hoveredAttributeSubset.hoveredAttributeIndices_.insert(parsedHoverAttributeId->attributeIndex_);
            }
        }
    }
}

FeatureLayerVisualizationBase::~FeatureLayerVisualizationBase() = default;

NativeJsValue FeatureLayerVisualizationBase::externalRelationReferences() const
{
    return *externalRelationReferences_;
}

void FeatureLayerVisualizationBase::processResolvedExternalReferences(
    NativeJsValue const& resolvedReferences)
{
    #ifdef EMSCRIPTEN
    auto resolvedReferenceLists = JsValue(resolvedReferences);
    auto const numResolutionLists = resolvedReferenceLists.size();
    #else
    auto const numResolutionLists = resolvedReferences.size();
    #endif
    if (numResolutionLists != externalRelationVisualizations_.size()) {
        std::cout << "Unexpected number of resolutions!" << std::endl;
        return;
    }

    std::set<RelationStyleState*> updatedRelationStates;
    for (uint32_t index = 0; index < numResolutionLists; ++index) {
        #ifdef EMSCRIPTEN
        auto resolutionList = resolvedReferenceLists.at(static_cast<uint32_t>(index));
        if (resolutionList.size() == 0) {
            continue;
        }

        auto firstResolution = resolutionList.at(0);
        auto const typeId = firstResolution["typeId"].as<std::string>();
        auto const featureId = firstResolution["featureId"].toKeyValuePairs();
        #else
        auto const& resolutionList = resolvedReferences[index];
        if (!resolutionList.is_array() || resolutionList.empty()) {
            continue;
        }

        auto const& firstResolution = resolutionList[0];
        auto const typeId = firstResolution["typeId"].get<std::string>();
        auto const featureId = JsValue(firstResolution["featureId"]).toKeyValuePairs();
        #endif

        mapget::model_ptr<mapget::Feature> targetFeature;
        for (auto const& tile : allTiles_) {
            targetFeature = tile->find(typeId, featureId);
            if (targetFeature) {
                break;
            }
        }
        if (!targetFeature) {
            std::cout << "Resolved target feature was not found in aux tiles!" << std::endl;
            continue;
        }

        auto const& pendingRelation = externalRelationVisualizations_[index];
        if (!pendingRelation.state) {
            continue;
        }
        auto* relationToRender = pendingRelation.relationToRender;
        if (!relationToRender || !relationToRender->relation_ || relationToRender->targetFeature_) {
            continue;
        }
        relationToRender->targetFeature_ = targetFeature;
        if (pendingRelation.state->rule_.relationMergeTwoWay()) {
            pendingRelation.state->unexploredFeatures_.emplace_back(targetFeature);
        }
        updatedRelationStates.insert(pendingRelation.state);
    }

    for (auto* relationState : updatedRelationStates) {
        relationState->populateAndRender(true);
    }
}

bool FeatureLayerVisualizationBase::includesPointLikeGeometry() const
{
    return geometryOutputMode_ != GeometryOutputMode::NonPointsOnly;
}

bool FeatureLayerVisualizationBase::includesNonPointGeometry() const
{
    return geometryOutputMode_ != GeometryOutputMode::PointsOnly;
}

std::string FeatureLayerVisualizationBase::makeMapLayerStyleRuleId(uint32_t ruleIndex) const
{
    (void) ruleIndex;
    return {};
}

void FeatureLayerVisualizationBase::onRelationStyle(
    model_ptr<Feature>& feature,
    BoundEvalFun& evalFun,
    FeatureStyleRule const& rule,
    std::string const& mapLayerStyleRuleId)
{
    (void) evalFun;
    (void) mapLayerStyleRuleId;
    relationStyleStates_.emplace_back(rule, feature, *this);
}

void FeatureLayerVisualizationBase::onFeatureForRendering(mapget::Feature const& feature)
{
    (void) feature;
}

bool FeatureLayerVisualizationBase::bypassLowFiMaxLodFilter() const
{
    return false;
}

void FeatureLayerVisualizationBase::emitPolygon(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) vertsCartesian;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
}

void FeatureLayerVisualizationBase::emitMesh(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) vertsCartesian;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
}

void FeatureLayerVisualizationBase::emitPoint(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) xyzPos;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
}

void FeatureLayerVisualizationBase::emitIcon(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) xyzPos;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
}

void FeatureLayerVisualizationBase::emitLabel(
    JsValue const& xyzPos,
    std::string const& text,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) xyzPos;
    (void) text;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
}

void FeatureLayerVisualizationBase::emitSolidPolyLine(
    JsValue const& jsVerts,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) jsVerts;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
}

void FeatureLayerVisualizationBase::emitDashedPolyLine(
    JsValue const& jsVerts,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) jsVerts;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
}

void FeatureLayerVisualizationBase::emitArrowPolyLine(
    JsValue const& jsVerts,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) jsVerts;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
}

JsValue FeatureLayerVisualizationBase::makeMergedPointPointParams(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) xyzPos;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
    return JsValue::Undefined();
}

JsValue FeatureLayerVisualizationBase::makeMergedPointIconParams(
    JsValue const& xyzPos,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) xyzPos;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
    return JsValue::Undefined();
}

JsValue FeatureLayerVisualizationBase::makeMergedPointLabelParams(
    JsValue const& xyzPos,
    std::string const& text,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    (void) xyzPos;
    (void) text;
    (void) rule;
    (void) tileFeatureId;
    (void) evalFun;
    return JsValue::Undefined();
}

void FeatureLayerVisualizationBase::addTileFeatureLayer(TileFeatureLayer const& tile)
{
    if (!tile_) {
        tile_ = tile.model_;
        internalStringPoolCopy_ = std::make_shared<simfil::StringPool>(*tile.model_->strings());
    }

    // Ensure that the added aux tile and the primary tile use the same field name encoding.
    tile.model_->setStrings(internalStringPoolCopy_);
    allTiles_.emplace_back(tile.model_);
}

void FeatureLayerVisualizationBase::run()
{
    if (!tile_) {
        return;
    }

    relationStyleStates_.clear();
    externalRelationReferences_ = JsValue::List();
    externalRelationVisualizations_.clear();

    auto processFeature = [this](mapget::model_ptr<mapget::Feature>& feature)
    {
        if (fidelity_ == FeatureStyleRule::LowFidelity
            && maxLowFiLod_ >= 0
            && !bypassLowFiMaxLodFilter()) {
            if (static_cast<int>(feature->lod()) > maxLowFiLod_) {
                return;
            }
        }
        onFeatureForRendering(static_cast<mapget::Feature const&>(*feature));
        auto const& constFeature = static_cast<mapget::Feature const&>(*feature);
        std::optional<simfil::model_ptr<simfil::OverlayNode>> evaluationContext;
        auto ensureEvaluationContext = [this, &constFeature, &evaluationContext]()
            -> simfil::model_ptr<simfil::OverlayNode>&
        {
            if (!evaluationContext.has_value()) {
                evaluationContext =
                    simfil::model_ptr<simfil::OverlayNode>::make(simfil::Value::field(constFeature));
                addOptionsToSimfilContext(*evaluationContext);
            }
            return *evaluationContext;
        };
        auto boundEvalFun = BoundEvalFun{
            simfil::model_ptr<simfil::OverlayNode>::make(simfil::Value::null()),
            {}
        };
        boundEvalFun.eval_ = [this, &ensureEvaluationContext, &boundEvalFun](auto&& str)
        {
            if (auto constantValue = evaluateConstantExpression(str, false, false)) {
                return std::move(*constantValue);
            }
            auto& context = ensureEvaluationContext();
            boundEvalFun.context_ = context;
            return evaluateExpression(str, *context, false, false);
        };

        auto const& candidateRuleIndices =
            style_.candidateRuleIndices(highlightMode_, fidelity_, constFeature.typeId());
        uint32_t featureGeomMask = 0;
        bool needsFeatureGeomMask = false;
        for (auto ruleIndex : candidateRuleIndices) {
            if (style_.rules()[ruleIndex].aspect() == FeatureStyleRule::Feature) {
                needsFeatureGeomMask = true;
                break;
            }
        }
        if (needsFeatureGeomMask) {
            if (auto geom = feature->geomOrNull()) {
                geom->forEachGeometry([&featureGeomMask](auto&& geomEntry) {
                    featureGeomMask |= geomTypeBit(geomEntry->geomType());
                    return true;
                });
            }
        }
        for (auto ruleIndex : candidateRuleIndices) {
            auto const& rule = style_.rules()[ruleIndex];
            if (rule.aspect() == FeatureStyleRule::Feature) {
                if ((featureGeomMask & rule.geometryTypesMask()) == 0) {
                    continue;
                }
            }
            auto mapLayerStyleRuleId = makeMapLayerStyleRuleId(rule.index());
            if (auto* matchingSubRule = rule.match(*feature, boundEvalFun)) {
                if (matchingSubRule->pointMergeGridCellSize()) {
                    boundEvalFun.context_ = ensureEvaluationContext();
                }
                addFeature(feature, boundEvalFun, *matchingSubRule, mapLayerStyleRuleId);
                featuresAdded_ = true;
            }
        }
    };

    if (featureIdBaseSubset_.empty()) {
        for (auto&& feature : *tile_) {
            processFeature(feature);
        }
        return;
    }

    for (auto const& featureId : featureIdBaseSubset_) {
        if (auto feature = tile_->find(featureId)) {
            processFeature(feature);
        }
    }
}


void FeatureLayerVisualizationBase::addFeature(
    model_ptr<Feature>& feature,
    BoundEvalFun& evalFun,
    FeatureStyleRule const& rule,
    std::string const& mapLayerStyleRuleId)
{
    std::optional<std::string> featureId;
    auto resolveFeatureId = [&]() -> std::string const& {
        if (!featureId) {
            featureId = feature->id()->toString();
        }
        return *featureId;
    };
    if (!featureIdBaseSubset_.empty() && !featureIdBaseSubset_.contains(resolveFeatureId())) {
        return;
    }

    auto offset = glm::dvec3{.0, .0, .0};
    auto const& ruleOffset = rule.offset();
    if (ruleOffset.x != .0 || ruleOffset.y != .0 || ruleOffset.z != .0) {
        offset = localWgs84UnitCoordinateSystem(feature->firstGeometry()) * ruleOffset;
    }

    switch(rule.aspect()) {
    case FeatureStyleRule::Feature: {
        if (auto geom = feature->geomOrNull()) {
            geom->forEachGeometry(
                [this, featureAddress = static_cast<uint32_t>(feature->addr().index()),
                 &rule, &mapLayerStyleRuleId, &evalFun, &offset](auto&& geom)
                {
                    addGeometry(geom, featureAddress, rule, mapLayerStyleRuleId, evalFun, offset);
                    return true;
                });
        }
        break;
    }
    case FeatureStyleRule::Relation: {
        onRelationStyle(feature, evalFun, rule, mapLayerStyleRuleId);
        break;
    }
    case FeatureStyleRule::Attribute: {
        auto attrLayers = feature->attributeLayersOrNull();
        if (!attrLayers) {
            break;
        }

        auto const hoverAttributeSubsetActive =
            !featureIdBaseSubset_.empty() &&
            highlightMode_ == FeatureStyleRule::HoverHighlight;
        std::string featureIdForAttributes;
        if (hoverAttributeSubsetActive) {
            featureIdForAttributes = resolveFeatureId();
        }

        uint32_t offsetFactor = 0;
        attrLayers->forEachLayer([&, this](auto&& layerName, auto&& layer){
            if (auto const& attrLayerTypeRegex = rule.attributeLayerType()) {
                if (!std::regex_match(layerName.begin(), layerName.end(), *attrLayerTypeRegex)) {
                    return true;
                }
            }
            layer->forEachAttribute([&, this](auto&& attr){
                auto const attributeIndex = static_cast<uint32_t>(attr->addr().index());
                std::unordered_set<uint32_t> const* hoveredValidityIndices = nullptr;
                if (hoverAttributeSubsetActive) {
                    auto const hoveredAttributeSubset =
                        hoveredAttributeSubsetsByFeatureId_.find(featureIdForAttributes);
                    if (hoveredAttributeSubset == hoveredAttributeSubsetsByFeatureId_.end()) {
                        return true;
                    }
                    auto const fullAttributeHovered =
                        hoveredAttributeSubset->second.hoveredAttributeIndices_.contains(attributeIndex);
                    auto const hoveredValiditySet =
                        hoveredAttributeSubset->second.hoveredValidityIndicesByAttribute_.find(attributeIndex);
                    if (!fullAttributeHovered) {
                        if (hoveredValiditySet ==
                            hoveredAttributeSubset->second.hoveredValidityIndicesByAttribute_.end()) {
                            return true;
                        }
                        hoveredValidityIndices = &hoveredValiditySet->second;
                    }
                }
                addAttribute(
                    feature,
                    layerName,
                    attr,
                    static_cast<uint32_t>(feature->addr().index()),
                    rule,
                    mapLayerStyleRuleId,
                    offsetFactor,
                    offset,
                    hoveredValidityIndices);
                return true;
            });
            return true;
        });
        break;
    }
    }
}

void FeatureLayerVisualizationBase::addGeometry(
    model_ptr<Geometry> const& geom,
    uint32_t tileFeatureId,
    FeatureStyleRule const& rule,
    std::string const& mapLayerStyleRuleId,
    BoundEvalFun& evalFun,
    glm::dvec3 const& offset)
{
    if (!geom) {
        return;
    }
    addGeometry(
        geom->toSelfContained(),
        geom->model().stage(),
        tileFeatureId,
        rule,
        mapLayerStyleRuleId,
        evalFun,
        offset);
}

void FeatureLayerVisualizationBase::addGeometry(
    SelfContainedGeometry const& geom,
    std::optional<uint32_t> geometryStage,
    uint32_t tileFeatureId,
    FeatureStyleRule const& rule,
    std::string const& mapLayerStyleRuleId,
    BoundEvalFun& evalFun,
    glm::dvec3 const& offset)
{
    auto const resolvedGeometryStage = geometryStage.value_or(0U);
    if (fidelity_ == FeatureStyleRule::LowFidelity) {
        auto const lowFidelityStageMax = highFidelityStage_ > 0U ? highFidelityStage_ - 1U : 0U;
        if (resolvedGeometryStage > lowFidelityStageMax) {
            return;
        }
    } else if (fidelity_ == FeatureStyleRule::HighFidelity) {
        if (resolvedGeometryStage < highFidelityStage_) {
            return;
        }
    }

    if (!rule.supports(geom.geomType_, geometryStage)) {
        return;
    }

    auto const renderFeatureId = rule.selectable() ? tileFeatureId : kUnselectableFeatureId;

    std::vector<mapget::Point> vertsProjected;
    vertsProjected.reserve(geom.points_.size());
    for (auto const& vertCarto : geom.points_) {
        vertsProjected.emplace_back(projectWgsPoint(vertCarto, offset));
    }

    switch (geom.geomType_) {
    case GeomType::Polygon:
        if (includesNonPointGeometry() && vertsProjected.size() >= 3) {
            emitPolygon(vertsProjected, rule, renderFeatureId, evalFun);
        }
        break;
    case GeomType::Line:
        if (includesNonPointGeometry()) {
            addPolyLine(vertsProjected, rule, renderFeatureId, evalFun);
        }
        break;
    case GeomType::Mesh:
        if (includesNonPointGeometry() && vertsProjected.size() >= 3) {
            emitMesh(vertsProjected, rule, renderFeatureId, evalFun);
        }
        break;
    case GeomType::Points:
        if (!includesPointLikeGeometry()) {
            break;
        }
        for (size_t pointIndex = 0; pointIndex < vertsProjected.size(); ++pointIndex) {
            auto const xyzPos = JsValue(vertsProjected[pointIndex]);
            if (auto const& gridCellSize = rule.pointMergeGridCellSize()) {
                addMergedPointGeometry(
                    renderFeatureId,
                    mapLayerStyleRuleId,
                    gridCellSize,
                    geom.points_[pointIndex],
                    "pointParameters",
                    evalFun,
                    [&](auto& augmentedEvalFun)
                    {
                        if (rule.hasIconUrl()) {
                            return makeMergedPointIconParams(
                                xyzPos,
                                rule,
                                renderFeatureId,
                                augmentedEvalFun);
                        }
                        return makeMergedPointPointParams(
                            xyzPos,
                            rule,
                            renderFeatureId,
                            augmentedEvalFun);
                    });
            }
            else if (rule.hasIconUrl()) {
                emitIcon(xyzPos, rule, renderFeatureId, evalFun);
            }
            else {
                emitPoint(xyzPos, rule, renderFeatureId, evalFun);
            }
        }
        break;
    }

    if (rule.hasLabel() && includesPointLikeGeometry()) {
            auto text = rule.labelText(evalFun);
            if (!text.empty()) {
                auto wgsPos = geometryCenter(geom);
                auto xyzPos = JsValue(projectWgsPoint(wgsPos, offset));

            if (auto const& gridCellSize = rule.pointMergeGridCellSize()) {
                addMergedPointGeometry(
                    renderFeatureId,
                    mapLayerStyleRuleId,
                    gridCellSize,
                    wgsPos,
                    "labelParameters",
                    evalFun,
                    [&](auto& augmentedEvalFun)
                    {
                        return makeMergedPointLabelParams(
                            xyzPos,
                            text,
                            rule,
                            renderFeatureId,
                            augmentedEvalFun);
                    });
            }
            else {
                emitLabel(xyzPos, text, rule, renderFeatureId, evalFun);
            }
        }
    }
}

void FeatureLayerVisualizationBase::addMergedPointGeometry(
    uint32_t tileFeatureId,
    const std::string& mapLayerStyleRuleId,
    const std::optional<glm::dvec3>& gridCellSize,
    mapget::Point const& pointCartographic,
    const char* geomField,
    BoundEvalFun& evalFun,
    std::function<JsValue(BoundEvalFun&)> const& makeGeomParams)
{
    auto gridPosition = pointCartographic / *gridCellSize;
    auto gridPositionHash = fmt::format(
        "{}:{}:{}",
        static_cast<int64_t>(glm::floor(gridPosition.x)),
        static_cast<int64_t>(glm::floor(gridPosition.y)),
        static_cast<int64_t>(glm::floor(gridPosition.z)));

    auto& [mergedPointFeatureSet, mergedPointVisu] =
        mergedPointsPerStyleRuleId_[mapLayerStyleRuleId][gridPositionHash];
    auto [_, featureIdIsNew] = mergedPointFeatureSet.emplace(tileFeatureId);

    auto externalMergedPointCount = 0;
    auto featureMergeServiceType = featureMergeService_.type();
    if (featureMergeServiceType != JsValue::Type::Undefined &&
        featureMergeServiceType != JsValue::Type::Null &&
        tile_) {
        try {
            externalMergedPointCount = featureMergeService_.call<int32_t>(
                "count",
                pointCartographic,
                gridPositionHash,
                tile_->tileId().z(),
                mapLayerStyleRuleId);
        } catch (...) {
            externalMergedPointCount = 0;
        }
    }
    auto mergedPointCount =
        externalMergedPointCount + static_cast<int32_t>(mergedPointFeatureSet.size());

    auto mergeCountId = internalStringPoolCopy_->emplace("$mergeCount");
    evalFun.context_->set(mergeCountId.value(), simfil::Value(mergedPointCount));

    if (!mergedPointVisu) {
        mergedPointVisu = JsValue::Dict({
            {"position", JsValue(pointCartographic)},
            {"positionHash", JsValue(gridPositionHash)},
            {geomField, JsValue(makeGeomParams(evalFun))},
            {"featureAddresses", JsValue::List({JsValue(tileFeatureId)})},
        });
    }
    else {
        mergedPointVisu->set(geomField, JsValue(makeGeomParams(evalFun)));
        if (featureIdIsNew) {
            (*mergedPointVisu)["featureAddresses"].push(JsValue(tileFeatureId));
        }
    }
}

void FeatureLayerVisualizationBase::rememberExternalRelationReference(
    RelationStyleState& state,
    RelationStyleState::RelationToVisualize* relationToRender,
    model_ptr<FeatureId> const& targetRef)
{
    auto pendingRelation = PendingExternalRelation{
        .state = &state,
        .relationToRender = relationToRender
    };
    externalRelationVisualizations_.push_back(pendingRelation);

    auto featureId = JsValue::List();
    for (auto const& [key, value] : targetRef->keyValuePairs()) {
        featureId.push(JsValue(std::string(key)));
        featureId.push(JsValue::fromVariant(value));
    }

    externalRelationReferences_.push(JsValue::Dict({
        {"mapId", JsValue(tile_ ? tile_->mapId() : std::string())},
        {"typeId", JsValue(std::string(targetRef->typeId()))},
        {"featureId", featureId}
    }));
}

void FeatureLayerVisualizationBase::addLine(
    mapget::Point const& wgsA,
    mapget::Point const& wgsB,
    uint32_t tileFeatureId,
    FeatureStyleRule const& rule,
    BoundEvalFun& evalFun,
    glm::dvec3 const& offset,
    double labelPositionHint)
{
    if (!includesNonPointGeometry()) {
        return;
    }
    auto pointA = projectWgsPoint(wgsA, offset);
    auto pointB = projectWgsPoint(wgsB, offset);

    addPolyLine({pointA, pointB}, rule, tileFeatureId, evalFun);

    if (!rule.hasLabel()) {
        return;
    }

    auto text = rule.labelText(evalFun);
    if (text.empty()) {
        return;
    }

    emitLabel(
        JsValue(mapget::Point(pointA + (pointB - pointA) * labelPositionHint)),
        text,
        rule,
        tileFeatureId,
        evalFun);
}

void FeatureLayerVisualizationBase::addPolyLine(
    std::vector<mapget::Point> const& vertsCartesian,
    FeatureStyleRule const& rule,
    uint32_t tileFeatureId,
    BoundEvalFun& evalFun)
{
    if (vertsCartesian.size() < 2) {
        return;
    }

    auto arrowType = rule.arrow(evalFun);
    if (arrowType == FeatureStyleRule::DoubleArrow) {
        auto jsVertsPair = encodeVerticesAsReversedSplitList(vertsCartesian);
        emitArrowPolyLine(jsVertsPair.first, rule, tileFeatureId, evalFun);
        emitArrowPolyLine(jsVertsPair.second, rule, tileFeatureId, evalFun);
        return;
    }

    auto jsVerts = encodeVerticesAsList(vertsCartesian);
    if (arrowType == FeatureStyleRule::ForwardArrow) {
        emitArrowPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
    else if (arrowType == FeatureStyleRule::BackwardArrow) {
        jsVerts.call<void>("reverse");
        emitArrowPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
    else if (rule.isDashed()) {
        emitDashedPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
    else {
        emitSolidPolyLine(jsVerts, rule, tileFeatureId, evalFun);
    }
}

void FeatureLayerVisualizationBase::ensureEvaluationEnvironment()
{
    if (evalEnvironment_) {
        return;
    }
    if (!internalStringPoolCopy_) {
        return;
    }

    evalEnvironment_ = mapget::makeEnvironment(internalStringPoolCopy_);
    for (auto const& [key, value] : optionValues_) {
        evalEnvironment_->constants.insert_or_assign(key, value);
    }
}

FeatureLayerVisualizationBase::CachedExpression*
FeatureLayerVisualizationBase::getOrCompileExpression(
    std::string const& expression,
    bool anyMode,
    bool autoWildcard)
{
    ensureEvaluationEnvironment();
    if (!evalEnvironment_) {
        return nullptr;
    }

    auto cacheKey = makeExpressionCacheKey(expression, anyMode, autoWildcard);
    auto [iter, inserted] = expressionCache_.try_emplace(std::move(cacheKey));
    if (!inserted) {
        return &iter->second;
    }

    auto ast = simfil::compile(*evalEnvironment_, expression, anyMode, autoWildcard);
    if (!ast) {
        std::cout << "Error compiling " << expression << ": " << ast.error().message
                  << std::endl;
        expressionCache_.erase(iter);
        return nullptr;
    }
    iter->second.ast_ = std::move(*ast);
    return &iter->second;
}

void FeatureLayerVisualizationBase::resolveCachedConstant(CachedExpression& cached)
{
    if (cached.constantResolved_) {
        return;
    }
    cached.constantResolved_ = true;

    if (!cached.ast_ || !cached.ast_->expr().constant() || !tile_ || !evalEnvironment_) {
        return;
    }

    auto rootResult = tile_->root(0);
    if (!rootResult) {
        return;
    }

    auto results = simfil::eval(*evalEnvironment_, *cached.ast_, **rootResult, nullptr);
    if (!results) {
        std::cout << "Error evaluating constant expression " << cached.ast_->query()
                  << ": " << results.error().message << std::endl;
        return;
    }
    if (!results->empty()) {
        cached.constantValue_ = std::move((*results)[0]);
    }
}

std::optional<simfil::Value> FeatureLayerVisualizationBase::evaluateConstantExpression(
    std::string const& expression,
    bool anyMode,
    bool autoWildcard)
{
    auto* cached = getOrCompileExpression(expression, anyMode, autoWildcard);
    if (!cached) {
        return std::nullopt;
    }
    resolveCachedConstant(*cached);
    if (cached->constantValue_.has_value()) {
        return cached->constantValue_;
    }
    return std::nullopt;
}

simfil::Value FeatureLayerVisualizationBase::evaluateExpression(
    std::string const& expression,
    simfil::ModelNode const& ctx,
    bool anyMode,
    bool autoWildcard)
{
    auto* cached = getOrCompileExpression(expression, anyMode, autoWildcard);
    if (!cached || !cached->ast_ || !evalEnvironment_) {
        return simfil::Value::null();
    }
    resolveCachedConstant(*cached);
    if (cached->constantValue_.has_value()) {
        return *cached->constantValue_;
    }

    try
    {
        auto results = simfil::eval(*evalEnvironment_, *cached->ast_, ctx, nullptr);
        if (!results) {
            std::cout << "Error evaluating " << expression << ": " << results.error().message
                      << std::endl;
            return simfil::Value::null();
        }

        if (!results->empty()) {
            return std::move((*results)[0]);
        }
    }
    catch (std::exception const& e) {
        std::cout << "Error evaluating " << expression << ": " << e.what() << std::endl;
        return simfil::Value::null();
    }

    std::cout << "Expression " << expression << " returned nothing." << std::endl;
    return simfil::Value::null();
}

void FeatureLayerVisualizationBase::addAttribute(
    model_ptr<Feature> const& feature,
    std::string_view const& layer,
    model_ptr<Attribute> const& attr,
    uint32_t tileFeatureId,
    FeatureStyleRule const& rule,
    std::string const& mapLayerStyleRuleId,
    uint32_t& offsetFactor,
    glm::dvec3 const& offset,
    std::unordered_set<uint32_t> const* hoveredValidityIndices)
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

    auto attrEvaluationContext =
        simfil::model_ptr<simfil::OverlayNode>::make(simfil::Value::field(constAttr));
    addOptionsToSimfilContext(attrEvaluationContext);

    // Assemble simfil evaluation context.
    auto nameId = internalStringPoolCopy_->emplace("$name");
    attrEvaluationContext->set(nameId.value(), simfil::Value(attr->name()));
    auto featureId = internalStringPoolCopy_->emplace("$feature");
    attrEvaluationContext->set(featureId.value(), simfil::Value::field(constFeature));
    auto layerId = internalStringPoolCopy_->emplace("$layer");
    attrEvaluationContext->set(layerId.value(), simfil::Value(layer));

    // Function which can evaluate a simfil expression in the attribute context.
    auto boundEvalFun = BoundEvalFun{
        attrEvaluationContext,
        [this, &attrEvaluationContext](auto&& str)
        {
            return evaluateExpression(str, *attrEvaluationContext, false, false);
        }};

    // Bump visual offset factor for next visualized attribute.
    ++offsetFactor;

    // Check if the attribute's values match the attribute filter for the rule.
    if (auto const& attrFilter = rule.attributeFilter()) {
        if (!attrFilter->empty()) {
            auto result = boundEvalFun.eval_(*attrFilter);
            if ((result.isa(simfil::ValueType::Bool) &&
                 !result.template as<simfil::ValueType::Bool>()) ||
                result.isa(simfil::ValueType::Undef) || result.isa(simfil::ValueType::Null)) {
                return;
            }
        }
    }

    // Draw validity geometry.
    if (auto multiValidity = attr->validityOrNull()) {
        uint32_t validityIndex = 0;
        multiValidity->forEach([&, this](auto&& validity)
        {
            if (hoveredValidityIndices && !hoveredValidityIndices->contains(validityIndex)) {
                ++validityIndex;
                return true;
            }
            addGeometry(
                validity.computeGeometry(feature->geomOrNull()),
                attr->model().stage(),
                tileFeatureId,
                rule,
                mapLayerStyleRuleId,
                boundEvalFun,
                offset * static_cast<double>(offsetFactor));
            ++validityIndex;
            return true;
        });
    }
    else {
        if (hoveredValidityIndices && !hoveredValidityIndices->contains(0U)) {
            return;
        }
        auto geom = feature->firstGeometry();
        addGeometry(
            geom,
            attr->model().stage(),
            tileFeatureId,
            rule,
            mapLayerStyleRuleId,
            boundEvalFun,
            offset * static_cast<double>(offsetFactor));
    }
}

void FeatureLayerVisualizationBase::addOptionsToSimfilContext(
    simfil::model_ptr<simfil::OverlayNode>& context)
{
    for (auto const& [key, value] : optionValues_) {
        auto keyId = internalStringPoolCopy_->emplace(key);
        context->set(keyId.value(), value);
    }
}

JsValue
FeatureLayerVisualizationBase::encodeVerticesAsList(std::vector<mapget::Point> const& pointsCartesian)
{
    auto jsPoints = JsValue::List();
    for (auto const& pt : pointsCartesian) {
        jsPoints.push(JsValue(pt));
    }
    return jsPoints;
}

std::pair<JsValue, JsValue>
FeatureLayerVisualizationBase::encodeVerticesAsReversedSplitList(std::vector<mapget::Point> const& pointsCartesian)
{
    if (pointsCartesian.empty() || pointsCartesian.size() < 2) {
        return {};
    }

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
    for (size_t i = static_cast<size_t>(midpointIndex); i < pointsCartesian.size(); ++i) {
        jsPointsSecondHalf.push(JsValue(pointsCartesian[i]));
    }
    return std::make_pair(jsPointsFirstHalf, jsPointsSecondHalf);
}

JsValue
FeatureLayerVisualizationBase::encodeVerticesAsFloat64Array(std::vector<mapget::Point> const& pointsCartesian)
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

}  // namespace erdblick
