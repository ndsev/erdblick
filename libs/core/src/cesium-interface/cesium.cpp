#include "cesium-interface/cesium.h"

namespace erdblick
{

CesiumLib::CesiumLib() :
    ArcType("ArcType"),
    Color("Color"),
    ColorGeometryInstanceAttribute("ColorGeometryInstanceAttribute"),
    GeometryInstance("GeometryInstance"),
    Material("Material"),
    PolylineColorAppearance("PolylineColorAppearance"),
    PolylineGeometry("PolylineGeometry"),
    PolylineMaterialAppearance("PolylineMaterialAppearance"),
    Primitive("Primitive"),
    PrimitiveCollection("PrimitiveCollection")
{
}

CesiumLib& Cesium()
{
    static thread_local CesiumLib cesiumLibrary;
    return cesiumLibrary;
}

JsValue CesiumLib::MaterialFromType(std::string const& type, const JsValue& options)
{
    return JsValue(Material.call<NativeJsValue>("fromType", type, *options));
}

JsValue CesiumLib::ColorAttributeFromColor(const JsValue& color)
{
    return JsValue(ColorGeometryInstanceAttribute.call<NativeJsValue>("fromColor", *color));
}

}
