#include "cesium-interface/cesium.h"

namespace erdblick
{

CesiumLib::CesiumLib() :
    Primitive("Primitive"),
    PrimitiveCollection("PrimitiveCollection"),
    GeometryInstance("GeometryInstance"),
    PolylineGeometry("PolylineGeometry"),

    Material("Material"),
    PolylineMaterialAppearance("PolylineMaterialAppearance"),
    Color("Color")
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

}
