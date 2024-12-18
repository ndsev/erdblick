#pragma once

#include "cesium.h"
#include "simfil/model/model.h"
#include "mapget/model/featurelayer.h"
#include "../rule.h"
#include "points.h"

namespace erdblick
{

struct CesiumBillboardCollection
{
    CesiumBillboardCollection();

    /**
     * Add an individual billboard to the collection.
     */
    void addBillboard(
        const JsValue& position,
        FeatureStyleRule const& style,
        JsValue const& id,
        BoundEvalFun const& evalFun);

    /**
     * Get the parameters for a BillboardCollection::add() call.
     */
    static JsValue billboardParams(
        const JsValue& position,
        FeatureStyleRule const& style,
        JsValue const& id,
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
    /** Number of billboards in this collection. */
    size_t numGeometryInstances_ = 0;

    /** Wrapped billboard primitive object from Cesium */
    JsValue billboardCollection_;
};

}