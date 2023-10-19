#include "cesium-interface/primitive.h"
#include "cesium-interface/cesium.h"
#include "cesium-interface/point-conversion.h"

namespace erdblick
{

CesiumPrimitive CesiumPrimitive::withPolylineColorAppearance()
{
    CesiumPrimitive result;
    result.appearance_ = Cesium().PolylineColorAppearance.New();
    return result;
}

CesiumPrimitive CesiumPrimitive::withPerInstanceColorAppearance()
{
    CesiumPrimitive result;
    result.appearance_ = Cesium().PerInstanceColorAppearance.New();
    return result;
}

void CesiumPrimitive::addPolyLine(
    JsValue const& vertices,
    FeatureStyleRule const& style,
    uint32_t id)
{
    auto polyline = Cesium().PolylineGeometry.New({
        {"positions", vertices},
        {"width", JsValue(style.width())},
        {"arcType", Cesium().ArcType["NONE"]}
    });
    addGeometryInstance(style, id, polyline);
}

void CesiumPrimitive::addPolygon(
    const JsValue& vertices,
    const FeatureStyleRule& style,
    uint32_t id)
{
    auto polygon = Cesium().PolygonGeometry.New({
        {"polygonHierarchy", Cesium().PolygonHierarchy.New(*vertices)},
        {"arcType", Cesium().ArcType["GEODESIC"]},
        {"perPositionHeight", JsValue(true)}
    });
    addGeometryInstance(style, id, polygon);
}

void CesiumPrimitive::addTriangles(
    const JsValue& float64Array,
    const FeatureStyleRule& style,
    uint32_t id)
{
    auto geometry = Cesium().Geometry.New({
        {"attributes", JsValue::Dict({
            {"position", Cesium().GeometryAttribute.New({
                {"componentDatatype", Cesium().ComponentDatatype["DOUBLE"]},
                {"componentsPerAttribute", JsValue(3)},
                {"values", float64Array}
            })}
        })}
    });
    addGeometryInstance(style, id, geometry);
}

void CesiumPrimitive::addGeometryInstance(
    const FeatureStyleRule& style,
    uint32_t id,
    const JsValue& geom)
{
    auto const& color = style.color();
    auto geometryInstance = Cesium().GeometryInstance.New({
        {"geometry", geom},
        {"attributes",
         JsValue::Dict(
             {{"color",
               Cesium().ColorGeometryInstanceAttribute.New(color.r, color.g, color.b, color.a)}})},
        {"id", JsValue(id)}
    });
    ++numGeometryInstances_;
    geometryInstances_.push(geometryInstance);
}

NativeJsValue CesiumPrimitive::toJsObject() const
{
    auto result = Cesium().Primitive.New(*JsValue::Dict(
        {{"geometryInstances", geometryInstances_},
         {"appearance", appearance_},
         {"releaseGeometryInstances", JsValue(true)}}));
    return *result;
}

bool CesiumPrimitive::empty() const
{
    return numGeometryInstances_ == 0;
}

}
