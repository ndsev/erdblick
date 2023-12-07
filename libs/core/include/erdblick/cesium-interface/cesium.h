#pragma once

#include "object.h"

namespace erdblick
{

/** Imports of Cesium classes from the global Cesium Javascript namespace. */
struct CesiumLib
{
    CesiumClass ArcType;
    CesiumClass BoundingSphere;
    CesiumClass Color;
    CesiumClass ColorGeometryInstanceAttribute;
    CesiumClass ComponentDatatype;
    CesiumClass Geometry;
    CesiumClass GeometryAttribute;
    CesiumClass GeometryInstance;
    CesiumClass Material;
    CesiumClass PerInstanceColorAppearance;
    CesiumClass PolygonGeometry;
    CesiumClass PolygonHierarchy;
    CesiumClass PolylineColorAppearance;
    CesiumClass PolylineGeometry;
    CesiumClass PolylineMaterialAppearance;
    CesiumClass Primitive;
    CesiumClass PrimitiveCollection;
    CesiumClass PrimitiveType;
    CesiumClass GroundPolylineGeometry;
    CesiumClass GroundPolylinePrimitive;
    CesiumClass GroundPrimitive;

    [[nodiscard]] JsValue MaterialFromType(std::string const& type, JsValue const& options);

private:
    friend CesiumLib& Cesium();
    CesiumLib();
};

/** Singleton accessor. */
CesiumLib& Cesium();

}
