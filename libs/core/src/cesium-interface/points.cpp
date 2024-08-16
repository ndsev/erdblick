#include "cesium-interface/points.h"
#include "cesium-interface/cesium.h"
#include "cesium-interface/point-conversion.h"
#include "simfil/model/model.h"

#include <iostream>

namespace erdblick
{

CesiumPointPrimitiveCollection::CesiumPointPrimitiveCollection() :
    pointPrimitiveCollection_(Cesium().PointPrimitiveCollection.New())
{}

void CesiumPointPrimitiveCollection::addPoint(
    const JsValue& position,
    FeatureStyleRule const& style,
    std::string_view const& id,
    BoundEvalFun const& evalFun)
{
    auto const color = style.color(evalFun);
    auto const& oColor = style.outlineColor();

    auto options = JsValue::Dict({
        {"position", position},
        {"color", Cesium().Color.New(color.r, color.g, color.b, color.a)},
        {"pixelSize", JsValue(style.width())},
        {"id", JsValue(id)},
        {"outlineColor", Cesium().Color.New(oColor.r, oColor.g, oColor.b, oColor.a)},
        {"outlineWidth", JsValue(style.outlineWidth())},
    });

    if (auto const& nfs = style.nearFarScale()) {
        options.set(
            "scaleByDistance",
            Cesium().NearFarScalar.New((*nfs)[0], (*nfs)[1], (*nfs)[2], (*nfs)[3]));
    }

    pointPrimitiveCollection_.call<void>("add", *options);
    ++numGeometryInstances_;
}

[[nodiscard]] NativeJsValue CesiumPointPrimitiveCollection::toJsObject() const
{
    return *pointPrimitiveCollection_;
}

bool CesiumPointPrimitiveCollection::empty() const
{
    return numGeometryInstances_ == 0;
}

}