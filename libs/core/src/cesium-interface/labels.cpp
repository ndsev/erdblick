#include "cesium-interface/labels.h"
#include "cesium-interface/cesium.h"
#include "simfil/model/model.h"

#include <iostream>

namespace erdblick {

CesiumLabelCollection::CesiumLabelCollection() :
    labelCollection_(Cesium().LabelCollection.New()) {}

JsValue CesiumLabelCollection::labelParams(
    const JsValue& position,
    const std::string& labelText,
    const FeatureStyleRule& style,
    const JsValue& id,
    const BoundEvalFun& evalFun)
{
    auto const &color = style.labelColor();
    auto const &outlineColor = style.labelOutlineColor();
    auto const &bgColor = style.labelBackgroundColor();
    auto const &padding = style.labelBackgroundPadding();

    auto labelProperties = JsValue::Dict({
        {"id", id},
        {"position", position},
        {"show", JsValue(true)},
        {"text", JsValue(labelText)},
        {"font", JsValue(style.labelFont())},
        {"disableDepthTestDistance", JsValue(std::numeric_limits<double>::infinity())},
        {"fillColor", Cesium().Color.New(color.r, color.g, color.b, color.a)},
        {"outlineColor", Cesium().Color.New(outlineColor.r, outlineColor.g, outlineColor.b, outlineColor.a)},
        {"outlineWidth", JsValue(style.labelOutlineWidth())},
        {"showBackground", JsValue(style.showBackground())},
        {"backgroundColor", Cesium().Color.New(bgColor.r, bgColor.g, bgColor.b, bgColor.a)},
        {"backgroundPadding", Cesium().Cartesian2.New(padding.first, padding.second)},
        {"style", Cesium().LabelStyle[style.labelStyle()]},
        {"horizontalOrigin", Cesium().HorizontalOrigin[style.labelHorizontalOrigin()]},
        {"verticalOrigin", Cesium().VerticalOrigin[style.labelVerticalOrigin()]},
        {"scale", JsValue(style.labelScale())}
    });
    if (auto const& sbd = style.scaleByDistance()) {
        labelProperties.set(
            "scaleByDistance",
            Cesium().NearFarScalar.New((*sbd)[0], (*sbd)[1], (*sbd)[2], (*sbd)[3]));
    }
    else if (auto const& nfs = style.nearFarScale()) {
        labelProperties.set(
            "scaleByDistance",
            Cesium().NearFarScalar.New((*nfs)[0], (*nfs)[1], (*nfs)[2], (*nfs)[3]));
    }
    if (auto const& osbd = style.offsetScaleByDistance()) {
        labelProperties.set(
            "pixelOffsetScaleByDistance",
            Cesium().NearFarScalar.New((*osbd)[0], (*osbd)[1], (*osbd)[2], (*osbd)[3]));
    }
    if (auto const& pixelOffset = style.labelPixelOffset()) {
        labelProperties
            .set("pixelOffset", Cesium().Cartesian2.New(pixelOffset->first, pixelOffset->second));
    }
    if (auto const& eyeOffset = style.labelEyeOffset()) {
        labelProperties.set(
            "eyeOffset",
            Cesium()
                .Cartesian3
                .New(std::get<0>(*eyeOffset), std::get<1>(*eyeOffset), std::get<2>(*eyeOffset)));
    }
    if (auto const& tbd = style.translucencyByDistance()) {
        labelProperties.set(
            "translucencyByDistance",
            Cesium().NearFarScalar.New((*tbd)[0], (*tbd)[1], (*tbd)[2], (*tbd)[3]));
    }

    return labelProperties;
}

void CesiumLabelCollection::addLabel(
        JsValue const &position,
        const std::string &labelText,
        FeatureStyleRule const &style,
        JsValue const& id,
        BoundEvalFun const& evalFun)
{
    auto params = labelParams(position, labelText, style, id, evalFun);
    labelCollection_.call<void>("add", *params);
    numLabelInstances_++;
}

NativeJsValue CesiumLabelCollection::toJsObject() const {
    return *labelCollection_;
}

bool CesiumLabelCollection::empty() const {
    return numLabelInstances_ == 0;
}

}