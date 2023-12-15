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
    uint32_t id)
{
    auto const& color = style.color();

    pointPrimitiveCollection_.call<void>("add",
        *JsValue::Dict({
            {"position", position},
            {"color", Cesium().Color.New(
                color.r,
                color.g,
                color.b,
                color.a)
            },
            {"pixelSize", JsValue(style.width())},
            {"id", JsValue(id)}
        }));
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