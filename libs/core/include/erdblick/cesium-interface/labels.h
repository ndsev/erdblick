#pragma once

#include "cesium.h"
#include "simfil/model/model.h"
#include "mapget/model/featurelayer.h"
#include "../rule.h"

namespace erdblick {

struct CesiumPrimitiveLabelsCollection {

    CesiumPrimitiveLabelsCollection();

    /**
    * Add an individual label to the collection
    */
    void addLabel(
        JsValue const &position,
        const std::string& labelText,
        FeatureStyleRule const &style,
        std::string_view const& id,
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
