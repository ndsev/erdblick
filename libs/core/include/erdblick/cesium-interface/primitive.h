#pragma once

#include "object.h"
#include "mapget/model/tileid.h"
#include "../rule.h"

namespace erdblick
{

/**
 * C++ Interface for the Cesium Primitive class. See
 * https://cesium.com/learn/cesiumjs/ref-doc/Primitive.html
 *
 * The actual Cesium primitive is constructed after all geometry
 * has been added, by calling `toJsObject`. This is, because
 * the JS primitive constructor already expects all geometry to be ready.
 */
struct CesiumPrimitive
{
    /**
     * Create a primitive which uses the PolylineColorAppearance.
     * See https://cesium.com/learn/cesiumjs/ref-doc/PolylineColorAppearance.html
     */
    static CesiumPrimitive withPolylineColorAppearance(bool clampToGround = false);

    /**
     * Create a primitive which uses the PerInstanceColorAppearance.
     * See https://cesium.com/learn/cesiumjs/ref-doc/PerInstanceColorAppearance.html
     *
     * The parameter flatAndSynchronous must be set to true for primitives
     * which contain basic triangle meshes. In the future, we can also have
     * smoothly shaded triangle meshes by calling Cesium.GeometryPipeline.computeNormal
     * and Cesium.GeometryPipeline.compressVertices on the mesh geometry.
     */
    static CesiumPrimitive withPerInstanceColorAppearance(bool flatAndSynchronous = false, bool clampToGround = false);

    /**
     * Add a 3D polyline to the primitive. The provided vertices
     * must be a JS list of Point objects in Cesium cartesian coordinates.
     *
     * Note: In order to visualize the line correctly, the primitive
     * must have been constructed using withPolylineColorAppearance.
     */
    void addPolyLine(JsValue const& vertices, FeatureStyleRule const& style, uint32_t id);

    /**
     * Add a 3D polygon to the primitive. The provided vertices
     * must be a JS list of Point objects in Cesium cartesian coordinates.
     *
     * Note: In order to visualize the polygon correctly, the primitive
     * must have been constructed using withPerInstanceColorAppearance.
     */
    void addPolygon(JsValue const& vertices, FeatureStyleRule const& style, uint32_t id);

    /**
     * Add a 3D triangle mesh to the primitive. The provided vertices
     * must be a JS Float64Array like [x0,y0,z0,x1,y1,z2...]. This is unlike other functions
     * here which need a JS list of Point objects, due to Cesium internals.
     *
     * Note: In order to visualize the triangles correctly, the primitive
     * must have been constructed using withPerInstanceColorAppearance(true).
     */
    void addTriangles(JsValue const& float64Array, FeatureStyleRule const& style, uint32_t id);

    /**
     * Constructs a JS Primitive from the provided Geometry instances.
     */
    [[nodiscard]] NativeJsValue toJsObject() const;

    /**
     * Check if any geometry has been added to the primitive.
     */
    [[nodiscard]] bool empty() const;

private:
    /**
     * Add a Cesium GeometryInstance which wraps a Cesium Geometry,
     * and add it to this primitive's geometryInstances_ collection.
     */
    void addGeometryInstance(const FeatureStyleRule& style, uint32_t id, const JsValue& geom);

    /** Number of entries in geometryInstances_. */
    size_t numGeometryInstances_ = 0;

    /** geometryInstances option for the Primitive JS Object ctor. */
    JsValue geometryInstances_ = JsValue::List();

    /** appearance option for the Primitive JS Object ctor. */
    JsValue appearance_;

    /** Flag which enables the direct triangle display required for addTriangles. */
    bool flatAndSynchronous_ = false;

    /** Flags to clamp geometries to ground. */
    bool clampToGround_ = false;
    bool polyLinePrimitive_ = false;
};

}
