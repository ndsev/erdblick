#pragma once

#include "object.h"

namespace erdblick
{

/** Imports of Cesium classes from the global Cesium Javascript namespace. */
struct CesiumLib
{
    CesiumClass ArcType;
    CesiumClass Color;
    CesiumClass ColorGeometryInstanceAttribute;
    CesiumClass GeometryInstance;
    CesiumClass Material;
    CesiumClass PolylineColorAppearance;
    CesiumClass PolylineGeometry;
    CesiumClass PolylineMaterialAppearance;
    CesiumClass Primitive;
    CesiumClass PrimitiveCollection;

    [[nodiscard]] JsValue MaterialFromType(std::string const& type, JsValue const& options);
    [[nodiscard]] JsValue ColorAttributeFromColor(JsValue const& color);

private:
    friend CesiumLib& Cesium();
    CesiumLib();
};

/** Singleton accessor. */
CesiumLib& Cesium();

}
