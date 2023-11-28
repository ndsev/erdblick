#pragma once

#include "cesium-interface/cesium.h"
#include "simfil/model/model.h"
#include "mapget/model/featurelayer.h"
#include "../rule.h"

namespace erdblick
{

struct CesiumPointPrimitiveCollection
{
    CesiumPointPrimitiveCollection();

    /**
     * Add points to the collection.
     * Left to do:
     *  - add IDs to the points,
     *  - apply styling.
     */
    void visualizePoints(
        mapget::model_ptr<mapget::Geometry> const& geom,
        FeatureStyleRule const& style,
        uint32_t id);

    /**
     * Add an individual point to the collection
     * (used by visualizePoints).
     */
    void visualizePoint(
        const JsValue& position,
        FeatureStyleRule const& style,
        uint32_t id);

    /**
     * Construct a JS Primitive from the provided Geometry instances.
     */
    [[nodiscard]] NativeJsValue toJsObject() const;

    /**
     * Check if any geometry has been added to the primitive.
     */
    bool empty() const;

private:
    /** Number of points in this collection. */
    size_t numGeometryInstances_ = 0;
    /** Wrapped point primitive object from Cesium */
    JsValue pointPrimitiveCollection_;
};

}