#include "visualization.h"
#include "cesium-interface/point-conversion.h"
#include "cesium-interface/primitive.h"
#include <iostream>

using namespace mapget;

namespace erdblick {

FeatureLayerVisualization::FeatureLayerVisualization(const FeatureLayerStyle& style, const std::shared_ptr<mapget::TileFeatureLayer>& layer)
    : coloredLines_(CesiumPrimitive::withPolylineColorAppearance(false)),
      coloredNontrivialMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(false, false)),
      coloredTrivialMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(true)),
      coloredGroundLines_(CesiumPrimitive::withPolylineColorAppearance(true)),
      coloredGroundMeshes_(CesiumPrimitive::withPerInstanceColorAppearance(true, true))
      /* coloredPoints_ = default */
{
    uint32_t featureId = 0;
    for (auto&& feature : *layer) {
        for (auto&& rule : style.rules()) {
            if (auto* matchingSubRule = rule.match(*feature)) {
                addFeature(feature, featureId, *matchingSubRule);
                featuresAdded_ = true;
            }
        }
        ++featureId;
    }
}

NativeJsValue FeatureLayerVisualization::primitiveCollection() const {
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

void FeatureLayerVisualization::addFeature(model_ptr<Feature>& feature, uint32_t id, FeatureStyleRule const& rule) {
    feature->geom()->forEachGeometry(
        [this, id, &rule](auto&& geom) {
            if (rule.supports(geom->geomType()))
                addGeometry(geom, id, rule);
            return true;
        });
}

void FeatureLayerVisualization::addGeometry(model_ptr<Geometry> const& geom, uint32_t id, FeatureStyleRule const& rule) {
    switch (geom->geomType()) {
    case mapget::Geometry::GeomType::Polygon:
        if (auto verts = encodeVerticesAsList(geom)) {
            if (rule.flat())
                coloredGroundMeshes_.addPolygon(*verts, rule, id);
            else
                coloredNontrivialMeshes_.addPolygon(*verts, rule, id);
        }
        break;
    case mapget::Geometry::GeomType::Line:
        if (rule.hasArrow() && rule.hasDoubleArrow()) {
            if (auto vertsPair = encodeVerticesAsReversedSplitList(geom)) {
                getPrimitiveForArrowMaterial(rule)->addPolyLine(vertsPair->first, rule, id);
                getPrimitiveForArrowMaterial(rule)->addPolyLine(vertsPair->second, rule, id);
            }
        }
        else {
            if (auto verts = encodeVerticesAsList(geom)) {
                if (rule.flat()) {
                    if (rule.isDashed()) {
                        getPrimitiveForDashMaterial(rule)->addPolyLine(*verts, rule, id);
                    }
                    else if (rule.hasArrow() && !rule.hasDoubleArrow()) {
                        getPrimitiveForArrowMaterial(rule)->addPolyLine(*verts, rule, id);
                    }
                    else {
                        coloredGroundLines_.addPolyLine(*verts, rule, id);
                    }
                }
                else {
                    if (rule.isDashed()) {
                        getPrimitiveForDashMaterial(rule)->addPolyLine(*verts, rule, id);
                    } else if (rule.hasArrow() && !rule.hasDoubleArrow()) {
                        getPrimitiveForArrowMaterial(rule)->addPolyLine(*verts, rule, id);
                    } else {
                        coloredLines_.addPolyLine(*verts, rule, id);
                    }
                }
            }
        }
        break;
    case mapget::Geometry::GeomType::Mesh:
        if (auto verts = encodeVerticesAsFloat64Array(geom)) {
            coloredTrivialMeshes_.addTriangles(*verts, rule, id);
        }
        break;
    case mapget::Geometry::GeomType::Points:
        geom->forEachPoint(
            [this, &rule, &id](auto&& vertex) {
                auto cartesian = JsValue(wgsToCartesian<mapget::Point>(vertex));
                coloredPoints_.addPoint(cartesian, rule, id);
                return true;
            });
        break;
    }
}

std::optional<JsValue> FeatureLayerVisualization::encodeVerticesAsList(model_ptr<Geometry> const& geom) {
    auto jsPoints = JsValue::List();
    uint32_t count = 0;
    geom->forEachPoint(
        [&count, &jsPoints](auto&& vertex) {
            jsPoints.push(JsValue(wgsToCartesian<mapget::Point>(vertex)));
            ++count;
            return true;
        });
    if (!count)
        return {};
    return jsPoints;
}

std::optional<std::pair<JsValue, JsValue>> FeatureLayerVisualization::encodeVerticesAsReversedSplitList(model_ptr<Geometry> const& geom) {
    std::vector<mapget::Point> points;
    uint32_t count = 0;
    geom->forEachPoint(
        [&count, &points](auto&& vertex) {
            points.emplace_back(vertex);
            ++count;
            return true;
        });
    if (!count || count == 1)
        return {};
    auto jsPointsFirstHalf = JsValue::List();
    auto jsPointsSecondfHalf = JsValue::List();
    if (points.size() == 2) {
        const auto x = (points.at(0).x + points.at(1).x) / 2;
        const auto y = (points.at(0).y + points.at(1).y) / 2;
        const auto z = (points.at(0).z + points.at(1).z) / 2;
        mapget::Point midpoint{x, y, z};
        jsPointsFirstHalf.push(JsValue(wgsToCartesian<mapget::Point>(midpoint)));
        jsPointsFirstHalf.push(JsValue(wgsToCartesian<mapget::Point>(points.at(0))));
        jsPointsSecondfHalf.push(JsValue(wgsToCartesian<mapget::Point>(midpoint)));
        jsPointsSecondfHalf.push(JsValue(wgsToCartesian<mapget::Point>(points.at(1))));
        return std::make_pair(jsPointsFirstHalf, jsPointsSecondfHalf);
    }
    auto midpointIndex = points.size() / 2;
    for (auto i = midpointIndex + 1; i-- > 0; ) {
        jsPointsFirstHalf.push(JsValue(wgsToCartesian<mapget::Point>(points[i])));
    }
    for (auto i = midpointIndex; i < points.size(); i++) {
        jsPointsSecondfHalf.push(JsValue(wgsToCartesian<mapget::Point>(points[i])));
    }
    return std::make_pair(jsPointsFirstHalf, jsPointsSecondfHalf);
}

std::optional<JsValue> FeatureLayerVisualization::encodeVerticesAsFloat64Array(model_ptr<Geometry> const& geom) {
    std::vector<double> cartesianCoords;
    geom->forEachPoint(
        [&cartesianCoords](auto&& vertex) {
            auto cartesian = wgsToCartesian<mapget::Point>(vertex);
            cartesianCoords.push_back(cartesian.x);
            cartesianCoords.push_back(cartesian.y);
            cartesianCoords.push_back(cartesian.z);
            return true;
        });
    if (cartesianCoords.empty())
        return {};
    return JsValue::Float64Array(cartesianCoords);
}

CesiumPrimitive* FeatureLayerVisualization::getPrimitiveForDashMaterial(const FeatureStyleRule &rule) {
    const auto key = std::tuple<std::string, std::string, uint32_t, uint32_t>{rule.colorString(), rule.gapColorString(), rule.dashLength(), rule.dashPattern()};
    auto& dashMap = rule.flat() ? dashGroundLines_ : dashLines_;
    auto iter = dashMap.find(key);
    if (iter != dashMap.end()) {
        return &(iter->second);
    }
    return &(dashMap.try_emplace(key, CesiumPrimitive::withPolylineDashMaterialAppearance(rule, rule.flat())).first->second);
}

CesiumPrimitive* FeatureLayerVisualization::getPrimitiveForArrowMaterial(const FeatureStyleRule &rule) {
    const std::string key = rule.colorString();
    auto& arrowMap = rule.flat() ? arrowGroundLines_ : arrowLines_;
    auto iter = arrowMap.find(key);
    if (iter != arrowMap.end()) {
        return &(iter->second);
    }
    return &(arrowMap.try_emplace(key, CesiumPrimitive::withPolylineArrowMaterialAppearance(rule, rule.flat())).first->second);
}

}  // namespace erdblick
