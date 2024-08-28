#pragma once

#include "cesium.h"
#include "simfil/model/model.h"
#include "mapget/model/featurelayer.h"
#include "../rule.h"

namespace erdblick {

struct CesiumLabelCollection
{
    CesiumLabelCollection();

    /**
     * Get the parameter object for a call to LabelCollection.add().
     */
    JsValue labelParams(
        JsValue const &position,
        const std::string& labelText,
        FeatureStyleRule const &style,
        JsValue const& id,
        BoundEvalFun const& evalFun);

    /**
    * Add an individual label to the collection
    */
    void addLabel(
        JsValue const &position,
        const std::string& labelText,
        FeatureStyleRule const &style,
        JsValue const& id,
        BoundEvalFun const& evalFun);

    /**
    * Construct a JS LabelCollection Primitive from the provided Label data.
    */
    [[nodiscard]] NativeJsValue toJsObject() const;

    /**
    * Check if any labels are present.
    */
    bool empty() const;

private:
    /**
     * Counter for the number of labels in the collection.
     */
    size_t numLabelInstances_ = 0;

    /**
     * JS wrapper for Cesium LabelCollection class.
     */
    JsValue labelCollection_;
};

}
