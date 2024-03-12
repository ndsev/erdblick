#include "cesium-interface/labels.h"
#include "cesium-interface/cesium.h"
#include "simfil/model/model.h"

#include <iostream>

namespace erdblick {

CesiumPrimitiveLabelsCollection::CesiumPrimitiveLabelsCollection() :
    labelCollection_(Cesium().LabelCollection.New()) {}

void CesiumPrimitiveLabelsCollection::addLabel(
        JsValue const &position,
        const std::string &labelText,
        FeatureStyleRule const &style,
        uint32_t id,
        BoundEvalFun const& evalFun) {
    JsValue label;
    auto const &color = style.labelColor();
    auto const &outlineColor = style.labelOutlineColor();
    auto const &bgColor = style.labelBackgroundColor();
    auto const &nfs = style.nearFarScale();
    auto const &padding = style.labelBackgroundPadding();
    labelCollection_.call<void>("add", *JsValue::Dict({
        {"id", JsValue(id)},
        {"position", position},
        {"show", JsValue(true)},
        {"text", JsValue(labelText)},
        {"font", JsValue(style.labelFont())},
        {"fillColor", Cesium().Color.New(color.r, color.g, color.b, color.a)},
        {"outlineColor", Cesium().Color.New(outlineColor.r, outlineColor.g, outlineColor.b, outlineColor.a)},
        {"outlineWidth", JsValue(style.outlineWidth())},
        {"showBackground", JsValue(false)},
        {"backgroundColor", Cesium().Color.New(bgColor.r, bgColor.g, bgColor.b, bgColor.a)},
        {"backgroundPadding", Cesium().Cartesian2.New(padding.first, padding.second)},
        {"style", Cesium().LabelStyle[style.labelStyle()]},
        {"horizontalOrigin", Cesium().HorizontalOrigin[style.labelHorizontalOrigin()]},
        {"verticalOrigin", Cesium().VerticalOrigin[style.labelVerticalOrigin()]},
        {"scale", JsValue(style.labelScale())},
        {"pixelOffsetScaleByDistance", Cesium().NearFarScalar.New((*nfs)[0], (*nfs)[1], (*nfs)[2], (*nfs)[3])}
        // {"pixelOffset", Cesium.Cartesian2.ZERO},
        // {"eyeOffset", Cesium.Cartesian3.ZERO},
        // {"translucencyByDistance", undefined}
    }));
    numLabelInstances_++;
}

NativeJsValue CesiumPrimitiveLabelsCollection::toJsObject() const {
    return *labelCollection_;
}

bool CesiumPrimitiveLabelsCollection::empty() const {
    return numLabelInstances_ == 0;
}

}