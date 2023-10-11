#pragma once

#include "object.h"

namespace erdblick
{

/** Imports of Cesium classes from the global Cesium Javascript namespace. */
struct CesiumLib
{
    CesiumClass Primitive;
    CesiumClass PrimitiveCollection;
    CesiumClass GeometryInstance;
    CesiumClass PolylineGeometry;

    CesiumClass Material;
    CesiumClass PolylineMaterialAppearance;
    CesiumClass Color;

    [[nodiscard]] JsValue MaterialFromType(std::string const& type, JsValue const& options);

private:
    friend CesiumLib& Cesium();
    CesiumLib();
};

/** Singleton accessor. */
CesiumLib& Cesium();

}
