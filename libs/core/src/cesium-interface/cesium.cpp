#include "cesium-interface/cesium.h"

namespace erdblick
{

CesiumLib::CesiumLib() :
    ArcType("ArcType"),
    BoundingSphere("BoundingSphere"),
    Color("Color"),
    ColorGeometryInstanceAttribute("ColorGeometryInstanceAttribute"),
    ComponentDatatype("ComponentDatatype"),
    Geometry("Geometry"),
    GeometryAttribute("GeometryAttribute"),
    GeometryInstance("GeometryInstance"),
    GroundPolylineGeometry("GroundPolylineGeometry"),
    GroundPolylinePrimitive("GroundPolylinePrimitive"),
    GroundPrimitive("GroundPrimitive"),
    Material("Material"),
    NearFarScalar("NearFarScalar"),
    PerInstanceColorAppearance("PerInstanceColorAppearance"),
    PointPrimitiveCollection("PointPrimitiveCollection"),
    PolygonGeometry("PolygonGeometry"),
    PolygonHierarchy("PolygonHierarchy"),
    PolylineColorAppearance("PolylineColorAppearance"),
    PolylineGeometry("PolylineGeometry"),
    PolylineMaterialAppearance("PolylineMaterialAppearance"),
    Primitive("Primitive"),
    PrimitiveCollection("PrimitiveCollection"),
    PrimitiveType("PrimitiveType"),
    Label("Label"),
    LabelCollection("LabelCollection"),
    BillboardCollection("BillboardCollection"),
    HorizontalOrigin("HorizontalOrigin"),
    VerticalOrigin("VerticalOrigin"),
    LabelStyle("LabelStyle"),
    Cartesian2("Cartesian2"),
    Cartesian3("Cartesian3")
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
