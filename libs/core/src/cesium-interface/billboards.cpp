#include "cesium-interface/billboards.h"
#include "cesium-interface/cesium.h"
#include "simfil/model/model.h"

#include <iostream>

namespace erdblick
{

CesiumBillboardCollection::CesiumBillboardCollection() :
    billboardCollection_(Cesium().PointPrimitiveCollection.New())
{}

JsValue CesiumBillboardCollection::billboardParams(
    const JsValue& position,
    const FeatureStyleRule& style,
    const JsValue& id,
    const BoundEvalFun& evalFun)
{
    auto result = CesiumPointPrimitiveCollection::pointParams(position, style, id, evalFun);
    if (style.hasIconUrl()) {
        result.set("image", JsValue(style.iconUrl(evalFun)));
    }
    return result;
}

void CesiumBillboardCollection::addBillboard(
    const JsValue& position,
    FeatureStyleRule const& style,
    JsValue const& id,
    BoundEvalFun const& evalFun)
{
    auto params = billboardParams(position, style, id, evalFun);
    billboardCollection_.call<void>("add", *params);
    ++numGeometryInstances_;
}

[[nodiscard]] NativeJsValue CesiumBillboardCollection::toJsObject() const
{
    return *billboardCollection_;
}

bool CesiumBillboardCollection::empty() const
{
    return numGeometryInstances_ == 0;
}

}
