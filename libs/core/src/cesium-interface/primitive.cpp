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

void CesiumPrimitive::addLine(JsValue const& pointList, JsValue const& color)
{
    auto polyline = Cesium().PolylineGeometry.New(*JsValue::newDict({
        {"positions", pointList},
        {"width", JsValue(2.5)},
        {"arcType", Cesium().ArcType["NONE"]}
    }));
    auto geometryInstance = Cesium().GeometryInstance.New(*JsValue::newDict({
        {"geometry", polyline},
        {"attributes", JsValue::newDict({{"color", Cesium().ColorAttributeFromColor(color)}})}
    }));
    geometryInstances_.push(geometryInstance);
}

NativeJsValue CesiumPrimitive::toJsObject()
{
    auto result = Cesium().Primitive.New(*JsValue::newDict(
        {{"geometryInstances", geometryInstances_}, {"appearance", appearance_}}));
    return *result;
}

}
