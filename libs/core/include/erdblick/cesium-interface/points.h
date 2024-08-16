#pragma once

#include "cesium.h"
#include "simfil/model/model.h"
#include "mapget/model/featurelayer.h"
#include "../rule.h"

namespace erdblick
{

struct CesiumPointPrimitiveCollection
{
    CesiumPointPrimitiveCollection();

    /**
     * Add an individual point to the collection
     */
    void addPoint(
        const JsValue& position,
        FeatureStyleRule const& style,
        std::string_view const& id,
        BoundEvalFun const& evalFun);

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