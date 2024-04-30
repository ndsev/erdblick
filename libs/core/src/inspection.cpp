#include "inspection.h"
#include "mapget/model/featurelayer.h"
#include <iostream>

using namespace erdblick;

void InspectionConverter::convert(mapget::model_ptr<mapget::Feature> const& featurePtr)
{
    fieldDict_ = featurePtr->model().fieldNames();
    featureId_ = featurePtr->id()->toString();

    // Identifiers section.
    {
        auto scope = push(convertStringView("Identifiers"), Section);
        for (auto const& [k, v] : featurePtr->id()->keyValuePairs()) {
            auto& entry = current_->children_.emplace_back();
            entry.key_ = convertStringView(k);
            std::visit([&entry](auto&& vv){
                entry.value_ = JsValue(vv);
            }, v);
        }
    }

    // Basic attributes section.
    if (auto attrs = featurePtr->attributes())
    {
        auto scope = push(convertStringView("Basic Attributes"), Section);
        for (auto const& [k, v] : attrs->fields()) {
            convertField(k, v);
        }
    }

    // Flexible attributes section.
    if (auto layers = featurePtr->attributeLayers())
    {
        auto scope = push(convertStringView("Attribute Layers"), Section);
        layers->forEachLayer([this](auto&& layerName, auto&& layer) -> bool {
            convertAttributeLayer(layerName, layer);
            return true;
        });
        pop();
    }

    // Relation section.
    using namespace mapget;
    if (featurePtr->numRelations())
    {
        auto scope = push(convertStringView("Relations"), Section);
        std::unordered_map<std::string_view, std::vector<model_ptr<Relation>>> relsByName;
        featurePtr->forEachRelation([this](model_ptr<Relation> const& relation) -> bool {
            convertRelation(relation);
            return true;
        });
    }

    // Geometry section.
    if (auto geomCollection = featurePtr->geom())
    {
        auto scope = push(convertStringView("Geometry"), Section);
        uint32_t geomIndex = 0;
        geomCollection->forEachGeometry([this, &geomIndex](model_ptr<Geometry> const& geom) -> bool {
            convertGeometry(JsValue(geomIndex++), geom);
            return true;
        });
        pop();
    }
}

InspectionConverter::InspectionNodeScope InspectionConverter::push(
    JsValue const& key, ValueType type)
{
    auto result = push(&current_->children_.emplace_back());
    result->key_ = key;
    result->type_ = type;
    return result;
}

InspectionConverter::InspectionNodeScope InspectionConverter::push(
    const std::string_view& key,
    InspectionConverter::ValueType type)
{
    return push(convertStringView(key), type);
}

InspectionConverter::InspectionNodeScope
InspectionConverter::push(InspectionConverter::InspectionNode* node)
{
    stack_.push_back(node);
    current_ = stack_.back();
    return {current_, this};
}

void InspectionConverter::pop()
{
    if (stack_.size() < 2) {
        std::cout << "Unbalanced push/pop!" << std::endl;
        return;
    }
    stack_.pop_back();
    current_ = stack_.back();
}

void InspectionConverter::convertAttributeLayer(
    const std::string_view& name,
    const mapget::model_ptr<mapget::AttributeLayer>& l)
{
    auto layerScope = push(convertStringView(name));
    l->forEachAttribute([this](mapget::model_ptr<mapget::Attribute> const& attr)
    {
        auto attrScope = push(convertStringView(attr->name()), Null);

        auto numValues = 0;
        OptionalValueAndType singleValue;
        attr->forEachField([this, &numValues, &singleValue](auto const& fieldName, auto const& val){
            auto singleValueForField = convertField(fieldName, val);
            if (singleValueForField && fieldName != "origValidity") {
                ++numValues;
                singleValue = singleValueForField;
            }
            return true;
        });

        if (numValues == 1) {
            std::tie(current_->value_, current_->type_) = *singleValue;
        }
        else if (numValues == 0) {
            current_->value_ = JsValue(true);
        }

        if (attr->hasValidity()) {
            convertGeometry(convertStringView("validity"), attr->validity());
        }

        if (auto direction = attr->direction()) {
            auto dirScope = push("direction", String);
            switch (direction) {
            case mapget::Attribute::Positive:
                dirScope->value_ = convertStringView("POSITIVE");
                break;
            case mapget::Attribute::Negative:
                dirScope->value_ = convertStringView("NEGATIVE");
                break;
            case mapget::Attribute::Both:
                dirScope->value_ = convertStringView("BOTH");
                break;
            case mapget::Attribute::None:
                dirScope->value_ = convertStringView("NONE");
                break;
            default: break;
            }
        }

        attrScope->hoverId_ = featureId_+":attribute#"+std::to_string(nextAttributeIndex_);

        ++nextAttributeIndex_;
        return true;
    });
}

void InspectionConverter::convertRelation(const mapget::model_ptr<mapget::Relation>& r)
{
    auto& relGroup = relationsByType_[r->name()];
    if (!relGroup) {
        relGroup = push(r->name()).node_;
    }
    auto relGroupScope = push(relGroup);
    auto relScope = push(JsValue(relGroup->children_.size()), FeatureId);
    relScope->value_ = JsValue(r->target()->toString());
    relScope->hoverId_ = featureId_+":relation#"+std::to_string(nextRelationIndex_);
    if (r->hasSourceValidity()) {
        convertGeometry(convertStringView("sourceValidity"), r->sourceValidity());
    }
    if (r->hasTargetValidity()) {
        convertGeometry(convertStringView("targetValidity"), r->targetValidity());
    }
    ++nextRelationIndex_;
}

void InspectionConverter::convertGeometry(
    JsValue const& key,
    const mapget::model_ptr<mapget::Geometry>& g)
{
    auto geomScope = push(key, String);
    switch (g->geomType()) {
    case simfil::Geometry::GeomType::Points: geomScope->value_ = convertStringView("Points"); break;
    case simfil::Geometry::GeomType::Line: geomScope->value_ = convertStringView("Polyline"); break;
    case simfil::Geometry::GeomType::Polygon: geomScope->value_ = convertStringView("Polygon"); break;
    case simfil::Geometry::GeomType::Mesh: geomScope->value_ = convertStringView("Mesh"); break;
    }

    g->forEachPoint([this, &geomScope](auto&& pt){
        auto ptScope = push(
            JsValue(geomScope->children_.size()),
            static_cast<ValueType>(Number | ArrayBit));
        ptScope->value_ = JsValue::List({JsValue(pt.x), JsValue(pt.y), JsValue(pt.z)});
        return true;
    });
}

InspectionConverter::OptionalValueAndType InspectionConverter::convertField(
    const simfil::FieldId& fieldId,
    const simfil::ModelNode::Ptr& value)
{
    return convertField(convertStringView(fieldId), value);
}

InspectionConverter::OptionalValueAndType InspectionConverter::convertField(
    const std::string_view& fieldName,
    const simfil::ModelNode::Ptr& value)
{
    return convertField(convertStringView(fieldName), value);
}

InspectionConverter::OptionalValueAndType
InspectionConverter::convertField(const JsValue& fieldName, const simfil::ModelNode::Ptr& value)
{
    auto fieldScope = push(fieldName);
    bool isArray = false;
    OptionalValueAndType singleValue;

    switch (value->type()) {
    case simfil::ValueType::Undef: return {};
    case simfil::ValueType::TransientObject: break;
    case simfil::ValueType::Null: singleValue = {JsValue(), Null}; break;
    case simfil::ValueType::Bool: singleValue = {JsValue(std::get<bool>(value->value())), Boolean}; break;
    case simfil::ValueType::Int: singleValue = {JsValue(std::get<int64_t>(value->value())), Number}; break;
    case simfil::ValueType::Float: singleValue = {JsValue(std::get<double>(value->value())), Number}; break;
    case simfil::ValueType::String: {
        auto vv = value->value();
        if (std::holds_alternative<std::string_view>(vv))
            singleValue = {convertStringView(std::get<std::string_view>(vv)), String};
        else
            singleValue = {JsValue(std::get<std::string>(vv)), String};
        break;
    }
    case simfil::ValueType::Object: break;
    case simfil::ValueType::Array: isArray = true; break;
    }

    if (singleValue) {
        std::tie(fieldScope->value_, fieldScope->type_) = *singleValue;
        return singleValue;
    }

    auto numValues = 0;
    auto index = 0;
    for (auto const& [k, v] : value->fields()) {
        JsValue kk;
        if (isArray)
            kk = JsValue(index);
        else
            kk = convertStringView(k);
        auto singleValueForField = convertField(kk, v);
        if (singleValueForField) {
            ++numValues;
            singleValue = singleValueForField;
        }
        ++index;
    }

    if (numValues == 1)
        return singleValue;
    return {};
}

JsValue InspectionConverter::convertStringView(const simfil::FieldId& f)
{
    if (auto fieldStr = fieldDict_->resolve(f)) {
        return convertStringView(*fieldStr);
    }
    return {};
}

JsValue InspectionConverter::convertStringView(const std::string_view& f)
{
    auto translation = translatedFieldNames_.find(f);
    if (translation != translatedFieldNames_.end())
        return translation->second;
    auto [newTrans, _] = translatedFieldNames_.emplace(f, JsValue(std::string(f)));
    return newTrans->second;
}

JsValue InspectionConverter::InspectionNode::toJsValue() const
{
    auto newDict = JsValue::Dict({
        {"key", key_},
        {"value", value_},
        {"type", JsValue((uint32_t)type_)},
    });
    if (!hoverId_.empty())
        newDict.set("hoverId", JsValue(hoverId_));
    if (!info_.empty())
        newDict.set("info", JsValue(info_));
    if (!children_.empty())
        newDict.set("children", childrenToJsValue());
    return newDict;
}

JsValue InspectionConverter::InspectionNode::childrenToJsValue() const
{
    auto result = JsValue::List();
    for (auto const& child : children_)
        result.push(child.toJsValue());
    return result;
}

InspectionConverter::InspectionNodeScope::~InspectionNodeScope()
{
    converter_->pop();
}

InspectionConverter::InspectionNode&
InspectionConverter::InspectionNodeScope::operator*() const
{
    return *node_;
}

InspectionConverter::InspectionNode*
InspectionConverter::InspectionNodeScope::operator->() const
{
    return node_;
}

InspectionConverter::InspectionNodeScope::InspectionNodeScope(
    InspectionConverter::InspectionNode* n,
    InspectionConverter* c) : node_(n), converter_(c)
{
}
