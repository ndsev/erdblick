#pragma once

#include "cesium-interface/object.h"
#include "mapget/model/feature.h"
#include "simfil/model/fields.h"
#include <unordered_map>

namespace erdblick
{

class InspectionConverter
{
    enum ValueType {
        Null = 0,
        Number = 1,
        String = 2,
        Boolean = 3,
        FeatureId = 4,
        Section = 5,
        ArrayBit = 128,
    };

    struct InspectionNode
    {
        JsValue key_;
        JsValue value_;
        ValueType type_ = Null;
        std::string hoverId_;
        std::string info_;
        std::vector<InspectionNode> children_;
        JsValue direction_;

        JsValue toJsValue() const;
        JsValue childrenToJsValue() const;
    };

    struct InspectionNodeScope
    {
        InspectionNode& operator* () const;
        InspectionNode* operator-> () const;

        ~InspectionNodeScope();
        InspectionNodeScope(InspectionNodeScope const&) = delete;
        InspectionNodeScope(InspectionNodeScope&&);
        InspectionNodeScope(InspectionNode* n, InspectionConverter* c);

        InspectionNode* node_ = nullptr;
        InspectionConverter* converter_ = nullptr;
    };

    using OptionalValueAndType = std::optional<std::pair<JsValue, ValueType>>;

public:
    JsValue convert(mapget::model_ptr<mapget::Feature> const& featurePtr);

    InspectionNodeScope push(InspectionNode* node);
    InspectionNodeScope push(std::string_view const& key, ValueType type=Null);
    InspectionNodeScope push(JsValue const& key, ValueType type=Null);
    void pop();

    void convertAttributeLayer(std::string_view const& name, mapget::model_ptr<mapget::AttributeLayer> const& l);
    void convertRelation(mapget::model_ptr<mapget::Relation> const& r);
    void convertGeometry(JsValue const& key, mapget::model_ptr<mapget::Geometry> const& r);

    OptionalValueAndType convertField(simfil::FieldId const& fieldId, simfil::ModelNode::Ptr const& value);
    OptionalValueAndType convertField(std::string_view const& fieldName, simfil::ModelNode::Ptr const& value);
    OptionalValueAndType convertField(JsValue const& fieldName, simfil::ModelNode::Ptr const& value);

    JsValue convertStringView(const simfil::FieldId& f);
    JsValue convertStringView(const std::string_view& f);

    std::string featureId_;
    uint32_t nextRelationIndex_ = 0;
    uint32_t nextAttributeIndex_ = 0;
    InspectionNode root_;
    std::vector<InspectionNode*> stack_ = {&root_};
    InspectionNode* current_ = &root_;
    std::shared_ptr<simfil::Fields> fieldDict_;
    std::unordered_map<std::string_view, JsValue> translatedFieldNames_;
    std::unordered_map<std::string_view, InspectionNode*> relationsByType_;
};

}  // namespace erdblick