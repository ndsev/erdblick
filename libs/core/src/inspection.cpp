#include "inspection.h"
#include "mapget/model/featurelayer.h"
#include "mapget/model/sourcedatareference.h"
#include "simfil/model/nodes.h"
#include <cstdint>
#include <iostream>

using namespace erdblick;
using namespace mapget;

namespace
{

/**
 * Converts a collection of qualified source-data references to the internal
 * inspection node model.
 */
InspectionConverter::InspectionNode& convertSourceDataReferences(const model_ptr<SourceDataReferenceCollection>& modelNode,
                                                                 InspectionConverter::InspectionNode& node)
{
    using Ref = InspectionConverter::InspectionNode::SourceDataReference;

    if (!modelNode)
        return node;

    const auto& model = modelNode->model();
    const auto& strings = model.strings();
    const auto tileId = model.tileId().value_;

    modelNode->forEachReference([tileId, &node](const SourceDataReferenceItem& item) {
        node.sourceDataRefs_.push_back(Ref{
            .tileId_ = tileId,
            .address_ = item.address().u64(),
            .layerId_ = std::string{item.layerId()},
            .qualifier_ = std::string{item.qualifier()}
        });
    });

    return node;
}

}

JsValue InspectionConverter::convert(model_ptr<Feature> const& featurePtr)
{
    stringPool_ = featurePtr->model().strings();
    featureId_ = featurePtr->id()->toString();
    tile_ = &featurePtr->model();

    // Top-Level Feature Item
    auto featureScope = push("Feature", "", ValueType::Section);
    featureScope->value_ = JsValue(featurePtr->id()->toString());
    convertSourceDataReferences(featurePtr->sourceDataReferences(), *featureScope);

    // Identifiers section.
    {
        auto scope = push(convertString("Identifiers"), "", ValueType::Section);
        push("type", "typeId", ValueType::String)->value_ = convertString(featurePtr->typeId());

        // Add map and layer names to the Identifiers section.
        push("mapId", "mapId", ValueType::String)->value_ = convertString(featurePtr->model().mapId());
        push("layerId", "layerId", ValueType::String)->value_ = convertString(featurePtr->model().layerInfo()->layerId_);

        // TODO: Investigate and fix the issue for "index out of bounds" error.
        //   Affects boundaries and lane connectors
        //  if (auto prefix = featurePtr->model().getIdPrefix()) {
        //      for (auto const& [k, v] : prefix->fields()) {
        //          convertField(k, v);
        //      }
        //  }
        //  for (auto const& [k, v] : featurePtr->id()->fields()) {
        //      convertField(k, v);
        //  }

        for (auto const& [key, value]: featurePtr->id()->keyValuePairs()) {
            auto &field = current_->children_.emplace_back();
            field.key_ = convertString(key);
            field.value_ = JsValue::fromVariant(value);
            field.type_ = ValueType::String;
            field.geoJsonPath_ = convertString(key).toString();
        }
    }

    // Basic attributes section.
    if (auto attrs = featurePtr->attributesOrNull())
    {
        auto scope = push(convertString("Basic Attributes"), "properties", ValueType::Section);
        for (auto const& [k, v] : attrs->fields()) {
            convertField(k, v);
        }
    }

    // Flexible attributes section.
    if (auto layers = featurePtr->attributeLayersOrNull())
    {
        auto scope = push(convertString("Attribute Layers"), "properties.layer", ValueType::Section);
        layers->forEachLayer([this](auto&& layerName, auto&& layer) -> bool {
            convertAttributeLayer(layerName, layer);
            return true;
        });
    }

    // Relation section.
    using namespace mapget;
    if (featurePtr->numRelations())
    {
        auto scope = push(convertString("Relations"), "relations", ValueType::Section);
        std::unordered_map<std::string_view, std::vector<model_ptr<Relation>>> relsByName;
        featurePtr->forEachRelation([this](model_ptr<Relation> const& relation) -> bool {
            convertRelation(relation);
            return true;
        });
    }

    // Geometry section.
    if (auto geomCollection = featurePtr->geomOrNull())
    {
        auto scope = push(convertString("Geometry"), "geometry", ValueType::Section);
        uint32_t geomIndex = 0;
        geomCollection->forEachGeometry([this, &geomIndex](model_ptr<Geometry> const& geom) -> bool {
            convertGeometry(JsValue(geomIndex++), geom);
            return true;
        });
    }

    return root_.childrenToJsValue(tile_->mapId());
}

InspectionConverter::InspectionNodeScope InspectionConverter::push(
    JsValue const& key, FieldOrIndex const& path, ValueType type)
{
    auto prevTop = stack_.back();
    auto result = push(&current_->children_.emplace_back());
    result->key_ = key;
    result->type_ = type;

    if (std::holds_alternative<uint32_t>(path)) {
        current_->geoJsonPath_ = fmt::format("{}[{}]", prevTop->geoJsonPath_, std::get<uint32_t>(path));
    }
    else {
        std::string_view field = std::get<std::string_view>(path);
        if (prevTop->geoJsonPath_.empty())
            current_->geoJsonPath_ = field;
        else
            current_->geoJsonPath_ = fmt::format("{}.{}", prevTop->geoJsonPath_, field);
    }

    return result;
}

InspectionConverter::InspectionNodeScope InspectionConverter::push(
    const std::string_view& key,
    FieldOrIndex const& path,
    InspectionConverter::ValueType type)
{
    return push(convertString(key), path, type);
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
    const model_ptr<AttributeLayer>& l)
{
    auto layerScope = push(convertString(name), name);
    l->forEachAttribute([this](model_ptr<Attribute> const& attr)
    {
        auto attrScope = push(convertString(attr->name()), attr->name(), ValueType::Null);
        convertSourceDataReferences(attr->sourceDataReferences(), *attrScope);

        auto numValues = 0;
        OptionalValueAndType singleValue;
        attr->forEachField([this, &numValues, &singleValue](auto const& fieldName, auto const& val){
            auto singleValueForField = convertField(fieldName, val);
            if (singleValueForField && fieldName != "schemaValidity" && fieldName != "origValidity") {
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
            current_->type_ = ValueType::Boolean;
        }

        if (auto validity = attr->validityOrNull()) {
            convertValidity(convertString("validity"), validity);
        }

        attrScope->mapId_ = JsValue(tile_->mapId());
        attrScope->hoverId_ = featureId_+":attribute#"+std::to_string(nextAttributeIndex_);

        ++nextAttributeIndex_;
        return true;
    });
}

void InspectionConverter::convertRelation(const model_ptr<Relation>& r)
{
    auto& relGroup = relationsByType_[r->name()];
    if (!relGroup) {
        relGroup = push(r->name(), "").node_;
        relGroup->geoJsonPath_ += fmt::format("{{name='{}'}}", r->name());
    }
    auto relGroupScope = push(relGroup);
    auto relScope = push(JsValue(relGroup->children_.size()), nextRelationIndex_, ValueType::FeatureId);
    relScope->value_ = JsValue(r->target()->toString());
    relScope->mapId_ = JsValue(r->model().mapId());
    relScope->hoverId_ = featureId_+":relation#"+std::to_string(nextRelationIndex_);
    convertSourceDataReferences(r->sourceDataReferences(), *relScope);
    if (auto const sourceValidity = r->sourceValidityOrNull()) {
        convertValidity(convertString("sourceValidity"), sourceValidity);
    }
    if (auto const targetValidity = r->targetValidityOrNull()) {
        convertValidity(convertString("targetValidity"), targetValidity);
    }
    ++nextRelationIndex_;
}

void InspectionConverter::convertGeometry(JsValue const& key, const model_ptr<Geometry>& g)
{
    auto geomScope = push(
        key,
        key.type() == JsValue::Type::Number ?
            FieldOrIndex(key.as<uint32_t>()) :
            FieldOrIndex(key.as<std::string>()),
        ValueType::String);
    std::string typeString;
    switch (g->geomType()) {
    case GeomType::Points: typeString = "Points"; break;
    case GeomType::Line: typeString = "Polyline"; break;
    case GeomType::Polygon: typeString = "Polygon"; break;
    case GeomType::Mesh: typeString = "Mesh"; break;
    }
    if (g->name()) {
        typeString += fmt::format(" ({})", *g->name());
    }
    geomScope->value_ = convertString(typeString);

    convertSourceDataReferences(g->sourceDataReferences(), *geomScope);

    uint32_t index = 0;
    g->forEachPoint(
        [this, &geomScope, &index](auto&& pt)
        {
            auto ptScope = push(
                JsValue(geomScope->children_.size()),
                index++,
                ValueType::Number | ValueType::ArrayBit);
            ptScope->value_ = JsValue::List({JsValue(pt.x), JsValue(pt.y), JsValue(pt.z)});
            return true;
        });
}

void InspectionConverter::convertValidity(
    JsValue const& key,
    model_ptr<MultiValidity> const& multiValidity)
{
    auto scope = push(key, key.as<std::string>());
    uint32_t valIndex = 0;
    multiValidity->forEach([this, &valIndex](Validity const& v) -> bool {
        auto validityScope = push(
            JsValue(valIndex),
            valIndex);

        if (auto direction = v.direction()) {
            auto dirScope = push("direction", "direction", ValueType::String);
            switch (direction) {
            case Validity::Positive:
                dirScope->value_ = convertString("POSITIVE");
                break;
            case Validity::Negative:
                dirScope->value_ = convertString("NEGATIVE");
                break;
            case Validity::Both:
                dirScope->value_ = convertString("BOTH");
                break;
            case Validity::None:
                dirScope->value_ = convertString("NONE");
                break;
            default: break;
            }
        }

        if (auto featureId = v.featureId()) {
            push("featureId", "featureId", ValueType::FeatureId)->value_ = convertString(featureId_);
        }

        if (auto geom = v.simpleGeometry()) {
            convertGeometry(JsValue("simpleGeometry"), geom);
            return true;
        }

        if (auto geomName = v.geometryName()) {
            push("geometryName", "geometryName", ValueType::String)->value_ = convertString(*geomName);
        }

        auto renderOffset = [this, &v](Point const& data, std::string_view const& name)
        {
            switch (v.geometryOffsetType()) {
            case Validity::InvalidOffsetType:
                break;
            case Validity::GeoPosOffset: {
                auto ptScope = push(name, name, ValueType::Number | ValueType::ArrayBit);
                ptScope->value_ = JsValue::List({JsValue(data.x), JsValue(data.y), JsValue(data.z)});
                break;
            }
            case Validity::BufferOffset: {
                push(name, name, ValueType::Number)->value_ =
                    JsValue(fmt::format("Point Index {}", static_cast<uint32_t>(data.x)));
                break;
            }
            case Validity::RelativeLengthOffset:
                push(name, name, ValueType::Number)->value_ =
                    JsValue(fmt::format("{:.2f}%", data.x * 100.));
                break;
            case Validity::MetricLengthOffset:
                push(name, name, ValueType::Number)->value_ =
                    JsValue(fmt::format("{:.2f}m", data.x));
                break;
            }
        };

        if (auto rangeOffset = v.offsetRange()) {
            renderOffset(rangeOffset->first, "start");
            renderOffset(rangeOffset->second, "end");
        }
        else if (auto pointOffset = v.offsetPoint()) {
            renderOffset(*pointOffset, "point");
        }

        return true;
    });
}

InspectionConverter::OptionalValueAndType InspectionConverter::convertField(
    const simfil::StringId& fieldId,
    const simfil::ModelNode::Ptr& value)
{
    return convertField(convertString(fieldId), value);
}

InspectionConverter::OptionalValueAndType InspectionConverter::convertField(
    const std::string_view& fieldName,
    const simfil::ModelNode::Ptr& value)
{
    return convertField(convertString(fieldName), value);
}

InspectionConverter::OptionalValueAndType
InspectionConverter::convertField(const JsValue& fieldName, const simfil::ModelNode::Ptr& value)
{
    auto fieldScope = push(fieldName, fieldName.toString());
    bool isArray = false;
    OptionalValueAndType singleValue;

    if (value->addr().column() == TileFeatureLayer::ColumnId::FeatureIds) {
        singleValue = {convertString(tile_->resolveFeatureId(*value)->toString()), ValueType::FeatureId};
        fieldScope->mapId_ = JsValue(tile_->mapId());
    }
    else {
        switch (value->type()) {
        case simfil::ValueType::Undef: return {};
        case simfil::ValueType::TransientObject: break;
        case simfil::ValueType::Null: singleValue = {JsValue(), ValueType::Null}; break;
        case simfil::ValueType::Bool: singleValue = {JsValue(std::get<bool>(value->value())), ValueType::Boolean}; break;
        case simfil::ValueType::Int: singleValue = {JsValue(std::get<int64_t>(value->value())), ValueType::Number}; break;
        case simfil::ValueType::Float: singleValue = {JsValue(std::get<double>(value->value())), ValueType::Number}; break;
        case simfil::ValueType::String: {
            auto vv = value->value();
            if (std::holds_alternative<std::string_view>(vv))
                singleValue = {convertString(std::get<std::string_view>(vv)), ValueType::String};
            else
                singleValue = {JsValue(std::get<std::string>(vv)), ValueType::String};
            break;
        }
        case simfil::ValueType::Object: break;
        case simfil::ValueType::Array: isArray = true; break;
        }
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
            kk = convertString(k);
        auto singleValueForField = convertField(kk, v);
        if (singleValueForField) {
            ++numValues;
            singleValue = singleValueForField;
        }
        ++index;
    }

    if (numValues == 1) {
        std::tie(fieldScope->value_, fieldScope->type_) = *singleValue;
        return singleValue;
    }
    return {};
}

JsValue InspectionConverter::convertString(const simfil::StringId& f)
{
    if (auto fieldStr = stringPool_->resolve(f)) {
        return convertString(*fieldStr);
    }
    return {};
}

JsValue InspectionConverter::convertString(const std::string_view& f)
{
    auto translation = translatedFieldNames_.find(f);
    if (translation != translatedFieldNames_.end())
        return translation->second;
    auto [newTrans, _] = translatedFieldNames_.emplace(f, JsValue(std::string(f)));
    return newTrans->second;
}

JsValue InspectionConverter::convertString(const std::string& s)
{
    return convertString(std::string_view(s));
}

JsValue InspectionConverter::convertString(const char* s)
{
    return convertString(std::string_view(s));
}

JsValue InspectionConverter::InspectionNode::toJsValue(std::string_view const& mapId) const
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
        newDict.set("children", childrenToJsValue(mapId));
    if (!geoJsonPath_.empty())
        newDict.set("geoJsonPath", JsValue(geoJsonPath_));
    if (mapId_)
        newDict.set("mapId", *mapId_);
    if (!sourceDataRefs_.empty()) {
        auto list = JsValue::List();
        for (const auto& ref : sourceDataRefs_) {
            list.push(JsValue::Dict({
                {"mapTileKey", , JsValue(fmt::format("SourceData:{}:{}:{}", mapId, ref.layerId_, ref.tileId_))},
                {"address", JsValue(ref.address_)},
                {"qualifier", JsValue(ref.qualifier_)},
            }));
        }

        newDict.set("sourceDataReferences", std::move(list));
    }

    return newDict;
}

JsValue InspectionConverter::InspectionNode::childrenToJsValue(std::string_view const& mapId) const
{
    auto result = JsValue::List();
    for (auto const& child : children_)
        result.push(child.toJsValue(mapId));
    return result;
}

InspectionConverter::InspectionNodeScope::~InspectionNodeScope()
{
    if (converter_)
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

InspectionConverter::InspectionNodeScope::InspectionNodeScope(
    InspectionConverter::InspectionNodeScope&& other) noexcept
{
    converter_ = other.converter_;
    other.converter_ = nullptr;
    node_ = other.node_;
}

InspectionConverter::ValueType
operator|(InspectionConverter::ValueType a, InspectionConverter::ValueType b)
{
    return static_cast<InspectionConverter::ValueType>(
        static_cast<uint8_t>(a) | static_cast<uint8_t>(b));
}
