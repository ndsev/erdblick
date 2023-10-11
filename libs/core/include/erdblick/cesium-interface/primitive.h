#pragma once

#include "object.h"
#include "mapget/model/tileid.h"

namespace erdblick
{

/**
 * C++ Interface for the Cesium Primitive class. See
 * https://cesium.com/learn/cesiumjs/ref-doc/Primitive.html
 *
 * The actual Cesium primitive is constructed after all geometry
 * has been added, by calling `toJsObject`.
 */
struct CesiumPrimitive
{
    /**
     * Create a primitive which uses the PolylineColorAppearance.
     * See https://cesium.com/learn/cesiumjs/ref-doc/PolylineColorAppearance.html
     */
    static CesiumPrimitive withPolylineColorAppearance();

    /**
     * Add a 3D polyline to the primitive. The provided coordinates
     * must already be transformed to Cesium cartesian coordinates.
     */
    void addLine(JsValue const& pointList, JsValue const& color);

    /**
     * Constructs a JS Primitive from the provided Geometry instances.
     */
    NativeJsValue toJsObject();

private:
    /** geometryInstances option for the Primitive JS Object ctor. */
    JsValue geometryInstances_ = JsValue::newList();

    /** appearance option for the Primitive JS Object ctor. */
    JsValue appearance_;
};

}
