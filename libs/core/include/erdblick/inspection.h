#pragma once

#include <cstdint>
#include <deque>
#include <unordered_map>
#include "cesium-interface/object.h"
#include "mapget/model/feature.h"
#include "sfl/small_vector.hpp"
#include "simfil/model/string-pool.h"
#include "mapget/model/featurelayer.h"

namespace erdblick
{

class InspectionConverter
{
public:
    enum class ValueType: uint8_t {
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
        std::optional<JsValue> mapId_;
        ValueType type_ = ValueType::Null;
        std::string hoverId_;  // For highlight attribs/relations on hovering.
        std::string info_;
        std::deque<InspectionNode> children_;
        JsValue direction_;
        std::string geoJsonPath_;

        struct SourceDataReference {
            uint64_t tileId_;
            uint64_t address_;
            std::string layerId_;
            std::string qualifier_;
        };
        sfl::small_vector<SourceDataReference, 1> sourceDataRefs_; // Most nodes have a single source-data reference.

        [[nodiscard]] JsValue toJsValue() const;
        [[nodiscard]] JsValue childrenToJsValue() const;
    };

    struct InspectionNodeScope
    {
        InspectionNode& operator* () const;
        InspectionNode* operator-> () const;

        ~InspectionNodeScope();
        InspectionNodeScope(InspectionNodeScope const&) = delete;
        InspectionNodeScope(InspectionNodeScope&&) noexcept;
        InspectionNodeScope(InspectionNode* n, InspectionConverter* c);

        InspectionNode* node_ = nullptr;
        InspectionConverter* converter_ = nullptr;
    };

    using OptionalValueAndType = std::optional<std::pair<JsValue, ValueType>>;
    using FieldOrIndex = std::variant<uint32_t, std::string_view>;

    JsValue convert(mapget::model_ptr<mapget::Feature> const& featurePtr);

    InspectionNodeScope push(InspectionNode* node);
    InspectionNodeScope push(std::string_view const& key, FieldOrIndex const& path, ValueType type=ValueType::Null);
    InspectionNodeScope push(JsValue const& key, FieldOrIndex const& path, ValueType type=ValueType::Null);
    void pop();

    void convertAttributeLayer(std::string_view const& name, mapget::model_ptr<mapget::AttributeLayer> const& l);
    void convertRelation(mapget::model_ptr<mapget::Relation> const& r);
    void convertGeometry(JsValue const& key, mapget::model_ptr<mapget::Geometry> const& r);
    void convertValidity(JsValue const& key, mapget::model_ptr<mapget::MultiValidity> const& r);

    OptionalValueAndType convertField(simfil::StringId const& fieldId, simfil::ModelNode::Ptr const& value);
    OptionalValueAndType convertField(std::string_view const& fieldName, simfil::ModelNode::Ptr const& value);
    OptionalValueAndType convertField(JsValue const& fieldName, simfil::ModelNode::Ptr const& value);

    JsValue convertStringView(const simfil::StringId& f);
    JsValue convertStringView(const std::string_view& f);

    std::string featureId_;
    uint32_t nextRelationIndex_ = 0;
    uint32_t nextAttributeIndex_ = 0;
    InspectionNode root_;
    std::vector<InspectionNode*> stack_ = {&root_};
    InspectionNode* current_ = &root_;
    std::shared_ptr<simfil::StringPool> stringPool_;
    std::unordered_map<std::string_view, JsValue> translatedFieldNames_;
    std::unordered_map<std::string_view, InspectionNode*> relationsByType_;
    mapget::TileFeatureLayer* tile_ = nullptr;
};

}  // namespace erdblick

erdblick::InspectionConverter::ValueType
operator|(erdblick::InspectionConverter::ValueType a, erdblick::InspectionConverter::ValueType b);
