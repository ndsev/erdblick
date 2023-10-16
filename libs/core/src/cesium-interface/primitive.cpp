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

void CesiumPrimitive::addLine(JsValue const& pointList, FeatureStyleRule const& style, uint32_t id)
{
    auto polyline = Cesium().PolylineGeometry.New(*JsValue::newDict({
        {"positions", pointList},
        {"width", JsValue(style.width())},
        {"arcType", Cesium().ArcType["NONE"]}
    }));
    auto const& color = style.color();
    auto geometryInstance = Cesium().GeometryInstance.New(*JsValue::newDict({
        {"geometry", polyline},
        {"attributes", JsValue::newDict({
            {"color", Cesium().ColorGeometryInstanceAttribute.New(
                color.r, color.g, color.b, color.a)}})},
        {"id", JsValue(id)}
    }));
    geometryInstances_.push(geometryInstance);
}

NativeJsValue CesiumPrimitive::toJsObject()
{
    auto result = Cesium().Primitive.New(*JsValue::newDict(
        {
            {"geometryInstances", geometryInstances_},
            {"appearance", appearance_},
            {"releaseGeometryInstances", JsValue(true)}
        }));
    return *result;
}

}
