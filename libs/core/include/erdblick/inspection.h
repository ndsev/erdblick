#pragma once

#include "cesium-interface/object.h"
#include "mapget/model/feature.h"
#include <unordered_map>

namespace erdblick
{

class InspectionConverter
{
    enum InspectionNodeType {
        Null = 0,
        Number = 1,
        String = 2,
        Boolean = 3,
        FeatureId = 4,
        Section = 5,
        ArrayBit = 128,
    };

    struct InspectionNodeData {
        std::string key_;
        std::string value_;
        InspectionNodeType type_;
        std::string hoverId_;
        std::string info_;
        std::vector<InspectionNodeData> children_;

        NativeJsValue toJsValue();
    };

public:
    void convert(mapget::Feature::Ptr const& featurePtr);

    InspectionNodeData root_;
    std::vector<InspectionNodeData*> stack_ = {&root_};
};

}  // namespace erdblick