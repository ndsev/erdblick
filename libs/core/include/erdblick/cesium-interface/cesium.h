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
    CesiumClass GroundPolylineGeometry;
    CesiumClass GroundPolylinePrimitive;
    CesiumClass GroundPrimitive;
    CesiumClass Material;
    CesiumClass NearFarScalar;
    CesiumClass PerInstanceColorAppearance;
    CesiumClass PointPrimitiveCollection;
    CesiumClass PolygonGeometry;
    CesiumClass PolygonHierarchy;
    CesiumClass PolylineColorAppearance;
    CesiumClass PolylineGeometry;
    CesiumClass PolylineMaterialAppearance;
    CesiumClass Primitive;
    CesiumClass PrimitiveCollection;
    CesiumClass PrimitiveType;
    CesiumClass Label;
    CesiumClass LabelCollection;
    CesiumClass HorizontalOrigin;
    CesiumClass VerticalOrigin;
    CesiumClass LabelStyle;
    CesiumClass Cartesian2;

    [[nodiscard]] JsValue MaterialFromType(std::string const& type, JsValue const& options);

private:
    friend CesiumLib& Cesium();
    CesiumLib();
};

/** Singleton accessor. */
CesiumLib& Cesium();

}
