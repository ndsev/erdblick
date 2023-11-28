#include "cesium-interface/cesium.h"
#include "cesium-interface/pointprimitives.h"
#include "cesium-interface/point-conversion.h"
#include "simfil/model/model.h"

#include <iostream>

namespace erdblick
{

CesiumPointPrimitiveCollection::CesiumPointPrimitiveCollection() :
    pointPrimitiveCollection_(Cesium().PointPrimitiveCollection.New())
{}

void CesiumPointPrimitiveCollection::visualizePoints(
    mapget::model_ptr<mapget::Geometry> const& geom,
    FeatureStyleRule const& style,
    uint32_t id)
{
    geom->forEachPoint(
        [this, &style, &id](auto&& vertex) {
            this->visualizePoint(
                JsValue(wgsToCartesian<mapget::Point>(vertex)),
                style,
                id);
            return true;
        });
}

void CesiumPointPrimitiveCollection::visualizePoint(
    const JsValue& position,
    FeatureStyleRule const& style,
    uint32_t id)
{
    auto const& color = style.color();

    pointPrimitiveCollection_.call<void>("add",
        *JsValue::Dict({
            {"position", position},
            // TODO fix point styling - hardcoded pixelSize seems to work already
            {"color",
                Cesium().ColorGeometryInstanceAttribute.New(
                    color.r,
                    color.g,
                    color.b,
                    color.a)
            },
            {"pixelSize", JsValue(style.width())}
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