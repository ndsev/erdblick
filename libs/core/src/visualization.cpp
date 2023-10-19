#include "visualization.h"
#include "cesium-interface/point-conversion.h"
#include "cesium-interface/primitive.h"

using namespace mapget;

namespace erdblick {

FeatureLayerVisualization::FeatureLayerVisualization(const FeatureLayerStyle& style, const std::shared_ptr<mapget::TileFeatureLayer>& layer)
    : coloredLines_(CesiumPrimitive::withPolylineColorAppearance()),
      coloredMeshes_(CesiumPrimitive::withPerInstanceColorAppearance())
{
    uint32_t featureId = 0;
    for (auto&& feature : *layer) {
        for (auto&& rule : style.rules()) {
            if (rule.match(*feature)) {
                addFeature(feature, featureId, rule);
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
    if (!coloredMeshes_.empty())
        collection.call<void>("add", coloredMeshes_.toJsObject());
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
            coloredMeshes_.addPolygon(*verts, rule, id);
        }
        break;
    case mapget::Geometry::GeomType::Line:
        if (auto verts = encodeVerticesAsList(geom)) {
            coloredLines_.addPolyLine(*verts, rule, id);
        }
        break;
    case mapget::Geometry::GeomType::Mesh:
        if (auto verts = encodeVerticesAsFloat64Array(geom)) {
            coloredMeshes_.addTriangles(*verts, rule, id);
        }
        break;
    case mapget::Geometry::GeomType::Points:
        // TODO: Implement point support.
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

}  // namespace erdblick
