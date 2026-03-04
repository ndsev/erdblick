#include "visualization-base.h"
#include "geometry.h"

#include <algorithm>
#include <charconv>
#include <cctype>
#include <iostream>
#include <regex>
#include <type_traits>

using namespace mapget;

namespace erdblick
{

namespace {
constexpr uint32_t geomTypeBit(mapget::GeomType const& g) {
    return 1u << static_cast<std::underlying_type_t<mapget::GeomType>>(g);
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

std::string_view trimAsciiWhitespace(std::string_view value) {
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front())) != 0) {
        value.remove_prefix(1);
    }
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back())) != 0) {
        value.remove_suffix(1);
    }
    return value;
}

bool isSimpleIdentifier(std::string_view value) {
    if (value.empty()) {
        return false;
    }
    auto isIdentifierHead = [](char c) {
        return std::isalpha(static_cast<unsigned char>(c)) != 0 || c == '_';
    };
    auto isIdentifierChar = [&](char c) {
        return std::isalnum(static_cast<unsigned char>(c)) != 0 || c == '_';
    };
    if (!isIdentifierHead(value.front())) {
        return false;
    }
    for (size_t i = 1; i < value.size(); ++i) {
        if (!isIdentifierChar(value[i])) {
            return false;
        }
    }
    return true;
}

std::optional<std::string_view> parseAnyOptionBoolCheck(std::string_view expression) {
    auto trimmed = trimAsciiWhitespace(expression);
    constexpr std::string_view anyPrefix = "any(";
    if (!trimmed.starts_with(anyPrefix) || !trimmed.ends_with(')')) {
        return std::nullopt;
    }
    auto inner = trimAsciiWhitespace(trimmed.substr(anyPrefix.size(), trimmed.size() - anyPrefix.size() - 1));
    if (!isSimpleIdentifier(inner)) {
        return std::nullopt;
    }
    return inner;
}

std::optional<uint32_t> parseFeatureIndexToken(std::string_view value) {
    auto token = trimAsciiWhitespace(value);
    if (token.empty()) {
        return std::nullopt;
    }
    if (token.front() == '#') {
        token.remove_prefix(1);
    }
    if (token.empty()) {
        return std::nullopt;
    }

    uint32_t parsed = 0;
    auto const* begin = token.data();
    auto const* end = begin + token.size();
    auto [ptr, ec] = std::from_chars(begin, end, parsed);
    if (ec != std::errc{} || ptr != end) {
        return std::nullopt;
    }
    return parsed;
}
}

FeatureLayerVisualizationBase::FeatureLayerVisualizationBase(
    int viewIndex,
    std::string const& mapTileKey,
    const FeatureLayerStyle& style,
    NativeJsValue const& rawOptionValues,
    FeatureStyleRule::HighlightMode const& highlightMode,
    FeatureStyleRule::Fidelity fidelity,
    int maxLowFiLod,
    GeometryOutputMode geometryOutputMode,
    NativeJsValue const& rawFeatureIdSubset,
    NativeJsValue const& rawFeatureMergeService)
    : viewIndex_(viewIndex),
      style_(style),
      highlightMode_(highlightMode),
      fidelity_(fidelity),
      maxLowFiLod_(std::clamp(maxLowFiLod, -1, 7)),
      geometryOutputMode_(geometryOutputMode),
      featureMergeService_(rawFeatureMergeService)
{
    (void) mapTileKey;
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
        auto featureToken = stripFeatureIdSuffix(featureId);
        if (auto featureIndex = parseFeatureIndexToken(featureToken)) {
            featureIndexSubset_.insert(*featureIndex);
            continue;
        }
        featureIdBaseSubset_.insert(std::string(featureToken));
    }
}

FeatureLayerVisualizationBase::~FeatureLayerVisualizationBase() = default;

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
    (void) feature;
    (void) evalFun;
    (void) rule;
    (void) mapLayerStyleRuleId;
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

    auto processFeature = [this](mapget::model_ptr<mapget::Feature>& feature)
    {
        if (fidelity_ == FeatureStyleRule::LowFidelity && maxLowFiLod_ >= 0) {
            if (static_cast<int>(feature->lod()) > maxLowFiLod_) {
                return;
            }
        }
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
            if (auto optionName = parseAnyOptionBoolCheck(str)) {
                auto optionIt = optionValues_.find(std::string(*optionName));
                if (optionIt != optionValues_.end() && optionIt->second.isa(simfil::ValueType::Bool)) {
                    return optionIt->second;
                }
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

    if (featureIdBaseSubset_.empty() || !featureIndexSubset_.empty()) {
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
    auto featureIndex = static_cast<uint32_t>(feature->addr().index());
    std::optional<std::string> featureId;
    auto resolveFeatureId = [&]() -> std::string const& {
        if (!featureId) {
            featureId = feature->id()->toString();
        }
        return *featureId;
    };
    if (!featureIdBaseSubset_.empty() || !featureIndexSubset_.empty()) {
        auto const indexMatches = featureIndexSubset_.contains(featureIndex);
        bool idMatches = false;
        if (!featureIdBaseSubset_.empty()) {
            idMatches = featureIdBaseSubset_.contains(resolveFeatureId());
        }
        if (!indexMatches && !idMatches) {
            return;
        }
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
                [this, featureIndex, &rule, &mapLayerStyleRuleId, &evalFun, &offset](auto&& geom)
                {
                    addGeometry(geom, featureIndex, rule, mapLayerStyleRuleId, evalFun, offset);
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
                if (hoverAttributeSubsetActive) {
                     auto const attributeIndex = static_cast<uint32_t>(attr->addr().index());
                     if (!featureIdSubset_.contains(
                            fmt::format("{}:attribute#{}", featureIdForAttributes, attributeIndex))) {
                         return true;
                     }
                }
                addAttribute(
                    feature,
                    layerName,
                    attr,
                    featureIndex,
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
            {"featureIds", JsValue::List({JsValue(tileFeatureId)})},
        });
    }
    else {
        mergedPointVisu->set(geomField, JsValue(makeGeomParams(evalFun)));
        if (featureIdIsNew) {
            (*mergedPointVisu)["featureIds"].push(JsValue(tileFeatureId));
        }
    }
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

simfil::Value FeatureLayerVisualizationBase::evaluateExpression(
    std::string const& expression,
    simfil::ModelNode const& ctx,
    bool anyMode,
    bool autoWildcard) const
{
    if (auto optionName = parseAnyOptionBoolCheck(expression)) {
        auto optionIt = optionValues_.find(std::string(*optionName));
        if (optionIt != optionValues_.end() && optionIt->second.isa(simfil::ValueType::Bool)) {
            return optionIt->second;
        }
    }

    try
    {
        auto results = tile_->evaluate(expression, ctx, anyMode, autoWildcard);
        if (!results) {
            std::cout << "Error evaluating " << expression << ": " << results.error().message
                      << std::endl;
        }

        if (!results->values.empty()) {
            return std::move(results->values[0]);
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
        multiValidity->forEach([&, this](auto&& validity)
        {
            addGeometry(
                validity.computeGeometry(feature->geomOrNull()),
                std::nullopt,
                tileFeatureId,
                rule,
                mapLayerStyleRuleId,
                boundEvalFun,
                offset * static_cast<double>(offsetFactor));
            return true;
        });
    }
    else {
        auto geom = feature->firstGeometry();
        addGeometry(
            geom,
            std::nullopt,
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
