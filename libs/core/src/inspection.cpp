#include "inspection.h"
#include "mapget/model/featurelayer.h"
#include "mapget/model/sourcedatareference.h"
#include "simfil/model/nodes.h"
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <iostream>
#include <optional>
#include <utility>
#include <vector>

using namespace erdblick;
using namespace mapget;

namespace
{

/** Check whether a field name can be emitted as a bare GeoJSON-path identifier. */
bool isBareGeoJsonPathField(std::string_view field)
{
    if (field.empty()) {
        return false;
    }
    const auto isIdentifierStart = [](unsigned char c) {
        return std::isalpha(c) || c == '_';
    };
    const auto isIdentifierPart = [](unsigned char c) {
        return std::isalnum(c) || c == '_';
    };
    if (!isIdentifierStart(static_cast<unsigned char>(field.front()))) {
        return false;
    }
    return std::all_of(field.begin() + 1, field.end(), [&](char c) {
        return isIdentifierPart(static_cast<unsigned char>(c));
    });
}

/** Escape a field name for use inside a `["..."]` GeoJSON-path segment. */
std::string escapedGeoJsonPathField(std::string_view field)
{
    std::string escaped;
    escaped.reserve(field.size());
    for (char c : field) {
        if (c == '\\' || c == '"') {
            escaped.push_back('\\');
        }
        escaped.push_back(c);
    }
    return escaped;
}

/** Escape a string literal for use inside a Simfil subquery. */
std::string simfilStringLiteral(std::string_view value)
{
    std::string escaped;
    escaped.reserve(value.size() + 2);
    escaped.push_back('"');
    for (char c : value) {
        switch (c) {
        case '\\':
        case '"':
            escaped.push_back('\\');
            escaped.push_back(c);
            break;
        case '\n':
            escaped.append("\\n");
            break;
        case '\r':
            escaped.append("\\r");
            break;
        case '\t':
            escaped.append("\\t");
            break;
        default:
            escaped.push_back(c);
            break;
        }
    }
    escaped.push_back('"');
    return escaped;
}

/** Append one field segment to an existing GeoJSON path using bare or bracket notation. */
std::string appendGeoJsonPathField(std::string_view base, std::string_view field)
{
    if (isBareGeoJsonPathField(field)) {
        if (base.empty()) {
            return std::string(field);
        }
        return fmt::format("{}.{}", base, field);
    }
    const auto escaped = escapedGeoJsonPathField(field);
    if (base.empty()) {
        return fmt::format("[\"{}\"]", escaped);
    }
    return fmt::format("{}.[\"{}\"]", base, escaped);
}

/** Return the direct-child wildcard selector for an array/object path. */
std::string directChildGeoJsonPath(std::string_view base)
{
    if (base.empty()) {
        return "*";
    }
    return fmt::format("{}.*", base);
}

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
    const auto tileId = model.tileId().value();

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

auto byteArrayToDisplayString(const simfil::ByteArray& value) -> std::string
{
    if (auto decoded = value.decodeBigEndianI64())
        return std::to_string(*decoded);
    return "0x" + value.toHex(false);
}

/** Convert one 3D point to the `[x, y, z]` list format used by inspection arrays. */
JsValue pointArrayValue(const mapget::Point& point)
{
    return JsValue::List({JsValue(point.x), JsValue(point.y), JsValue(point.z)});
}

/** Compute the center point of an origin/size box description. */
mapget::Point boxCenter(const mapget::Point& origin, const mapget::Point& size)
{
    return {
        origin.x + size.x * 0.5,
        origin.y + size.y * 0.5,
        origin.z + size.z * 0.5
    };
}

/** Return the GeoJSON coordinate path, relative to one geometry object, for a displayed point row. */
std::string geometryCoordinatePath(const model_ptr<Geometry>& geometry, uint32_t pointIndex)
{
    switch (geometry->geomType()) {
    case GeomType::Polygon: {
        const auto ringCount = geometry->numPolygonRings();
        for (auto ringIndex = 0U; ringIndex < ringCount; ++ringIndex) {
            const auto ringStart = geometry->polygonRingStart(ringIndex);
            const auto ringEnd = ringIndex + 1U < ringCount
                ? geometry->polygonRingStart(ringIndex + 1U)
                : static_cast<uint32_t>(geometry->numPoints());
            if (pointIndex >= ringStart && pointIndex < ringEnd) {
                return fmt::format(
                    "coordinates[{}][{}]",
                    ringIndex,
                    pointIndex - ringStart);
            }
        }
        break;
    }
    case GeomType::Mesh:
        return fmt::format(
            "coordinates[{}][0][{}]",
            pointIndex / 3U,
            pointIndex % 3U);
    default:
        break;
    }
    return fmt::format("coordinates[{}]", pointIndex);
}

/** Resolve the layer's configured high-fidelity stage with safe fallbacks for legacy metadata. */
uint32_t highFidelityStage(const mapget::TileFeatureLayer& layer)
{
    auto const layerInfo = layer.layerInfo();
    auto const stages = std::max<uint32_t>(1U, layerInfo ? layerInfo->stages_ : 1U);
    auto const fallback = stages > 1U ? 1U : 0U;
    auto const configured = layerInfo ? layerInfo->highFidelityStage_ : fallback;
    return std::min(stages - 1U, configured);
}

/** Resolve the display label for a geometry stage using layer metadata when present. */
std::string stageLabel(const mapget::TileFeatureLayer& layer, uint32_t stage)
{
    auto const layerInfo = layer.layerInfo();
    if (layerInfo && stage < layerInfo->stageLabels_.size()) {
        return layerInfo->stageLabels_[stage];
    }
    return fmt::format("Stage {}", stage);
}

/** Hide stage labels for baseline/high-fi geometry and show them only for add-on stages. */
bool shouldDisplayStageLabel(const mapget::TileFeatureLayer& layer, uint32_t stage)
{
    return stage > highFidelityStage(layer);
}

using InspectionNode = InspectionConverter::InspectionNode;
using ValueBubble = InspectionConverter::InspectionNode::ValueBubble;

constexpr auto kMaxPropagatedBubbles = 12U;

/** Return the non-array base value type for scalar propagation decisions. */
InspectionConverter::ValueType baseValueType(InspectionConverter::ValueType type)
{
    return static_cast<InspectionConverter::ValueType>(
        static_cast<uint8_t>(type) & ~static_cast<uint8_t>(InspectionConverter::ValueType::ArrayBit));
}

/** Return whether this inspection value represents an array payload rather than one scalar. */
bool isArrayValue(InspectionConverter::ValueType type)
{
    return (static_cast<uint8_t>(type) & static_cast<uint8_t>(InspectionConverter::ValueType::ArrayBit)) != 0;
}

/** Convert an inspection key to a stable display string for node ids and propagated labels. */
std::string inspectionKeyString(InspectionNode const& node)
{
    return node.key_.toString();
}

/** Assign local, traversal-stable node ids before value bubbles reference their target rows. */
void assignInspectionNodeIds(InspectionNode& node, std::string_view parentPath = {})
{
    uint32_t index = 0;
    for (auto& child : node.children_) {
        auto const key = inspectionKeyString(child);
        child.nodeId_ = parentPath.empty()
            ? fmt::format("{}:{}", index, key)
            : fmt::format("{}/{}:{}", parentPath, index, key);
        assignInspectionNodeIds(child, child.nodeId_);
        ++index;
    }
}

/** Identify generated zserio count fields which should not dominate parent summaries. */
bool isLikelyZserioCountField(std::string const& key)
{
    if (key == "numLanes") {
        return false;
    }
    if (key == "length" || key == "Length") {
        return true;
    }
    return key.size() > 3
        && key.rfind("num", 0) == 0
        && std::isupper(static_cast<unsigned char>(key[3]));
}

/** Containers whose name is structural rather than meaningful in propagated summaries. */
bool isTransparentPropagationContainer(std::string const& key)
{
    return key == "attributeValue"
        || key == "conditionValue"
        || key == "propertyValue";
}

/** Construct one value bubble with the mandatory target row metadata. */
ValueBubble makeValueBubble(std::string label, std::string targetNodeId, std::string kind)
{
    return ValueBubble{
        .label_ = std::move(label),
        .targetNodeId_ = std::move(targetNodeId),
        .kind_ = std::move(kind)
    };
}

/** Return the first concrete row target inside a bubble tree. */
std::string firstBubbleTarget(ValueBubble const& bubble)
{
    if (!bubble.targetNodeId_.empty()) {
        return bubble.targetNodeId_;
    }
    for (auto const& child : bubble.children_) {
        auto target = firstBubbleTarget(child);
        if (!target.empty()) {
            return target;
        }
    }
    return {};
}

/** Combine child bubbles into one grouped summary bubble for propagation through a container. */
ValueBubble makeGroupedBubble(std::deque<ValueBubble> children)
{
    std::string label;
    for (auto const& child : children) {
        label += "[";
        label += child.label_;
        label += "]";
    }
    auto group = makeValueBubble(std::move(label), children.empty() ? std::string{} : firstBubbleTarget(children.front()), "group");
    group.children_ = std::move(children);
    return group;
}

/** Render a leaf scalar according to the inspection propagation rules. */
std::optional<ValueBubble> scalarBubbleForNode(InspectionNode const& node)
{
    if (!node.children_.empty() || isArrayValue(node.type_)) {
        return std::nullopt;
    }

    switch (baseValueType(node.type_)) {
    case InspectionConverter::ValueType::Boolean:
        if (node.value_.type() == JsValue::Type::Bool && node.value_.as<bool>()) {
            return makeValueBubble(inspectionKeyString(node), node.nodeId_, "boolean");
        }
        return std::nullopt;
    case InspectionConverter::ValueType::Number:
    case InspectionConverter::ValueType::String:
    case InspectionConverter::ValueType::FeatureId:
        return makeValueBubble(node.value_.toString(), node.nodeId_, "scalar");
    case InspectionConverter::ValueType::Null:
        return std::nullopt;
    case InspectionConverter::ValueType::Section:
    case InspectionConverter::ValueType::ArrayBit:
        return std::nullopt;
    }
    return std::nullopt;
}

/** Find a direct child by inspection key. */
InspectionNode const* directChildByKey(InspectionNode const& node, std::string_view key)
{
    for (auto const& child : node.children_) {
        if (inspectionKeyString(child) == key) {
            return &child;
        }
    }
    return nullptr;
}

/** Convert verbose validity direction values into compact prefix markers. */
std::string compactValidityDirection(InspectionNode const& validityNode)
{
    auto const* direction = directChildByKey(validityNode, "direction");
    if (!direction) {
        return {};
    }
    auto const value = direction->value_.toString();
    if (value == "POSITIVE") {
        return "+";
    }
    if (value == "NEGATIVE") {
        return "-";
    }
    if (value == "COMPLETE" || value == "BOTH") {
        return "+-";
    }
    return {};
}

/** Compact one validity offset value into percent, metric, index, or explicit-position notation. */
std::string compactValidityOffset(InspectionNode const& offsetNode)
{
    if (offsetNode.value_.type() == JsValue::Type::ObjectOrList) {
        return "⌖";
    }
    auto value = offsetNode.value_.toString();
    constexpr std::string_view pointIndexPrefix = "Point Index ";
    if (value.rfind(pointIndexPrefix, 0) == 0) {
        return "#" + value.substr(pointIndexPrefix.size());
    }
    return value;
}

/** Create the label for one compact validity bubble. */
std::string compactValidityLabel(InspectionNode const& validityNode)
{
    std::vector<std::string> parts;
    if (auto direction = compactValidityDirection(validityNode); !direction.empty()) {
        parts.push_back(std::move(direction));
    }
    if (auto const* featureId = directChildByKey(validityNode, "featureId")) {
        parts.push_back(featureId->value_.toString());
    }
    else if (auto const* transitionNumber = directChildByKey(validityNode, "transitionNumber")) {
        parts.push_back("T" + transitionNumber->value_.toString());
    }

    if (auto const* point = directChildByKey(validityNode, "point")) {
        parts.push_back(compactValidityOffset(*point));
    }
    else {
        auto const* start = directChildByKey(validityNode, "start");
        auto const* end = directChildByKey(validityNode, "end");
        if (start && end) {
            parts.push_back(fmt::format("{} to {}", compactValidityOffset(*start), compactValidityOffset(*end)));
        }
    }

    if (parts.empty()) {
        return "validity";
    }

    std::string label;
    for (auto const& part : parts) {
        if (!label.empty()) {
            label += " ";
        }
        label += part;
    }
    return label;
}

/** Return whether a node represents a validity container or one indexed validity entry. */
bool isValidityNode(InspectionNode const& node)
{
    auto const key = inspectionKeyString(node);
    return key == "validity"
        || key == "sourceValidity"
        || key == "targetValidity"
        || node.hoverId_.find(":validity#") != std::string::npos;
}

/** Build the special one-bubble-per-validity representation. */
std::deque<ValueBubble> validityBubblesForNode(InspectionNode const& node)
{
    std::deque<ValueBubble> bubbles;
    for (auto const& child : node.children_) {
        auto const hasValidityHoverId = child.hoverId_.find(":validity#") != std::string::npos;
        auto const looksLikeIndexedValidity = child.key_.type() == JsValue::Type::Number
            && (directChildByKey(child, "direction")
                || directChildByKey(child, "featureId")
                || directChildByKey(child, "transitionNumber")
                || directChildByKey(child, "start")
                || directChildByKey(child, "point"));
        if (!hasValidityHoverId && !looksLikeIndexedValidity) {
            continue;
        }
        bubbles.push_back(makeValueBubble(compactValidityLabel(child), child.nodeId_, "validity"));
    }
    if (!bubbles.empty()) {
        return bubbles;
    }
    bubbles.push_back(makeValueBubble(compactValidityLabel(node), node.nodeId_, "validity"));
    return bubbles;
}

/** Convert a bubble tree into the JS shape consumed by the inspection table. */
JsValue valueBubbleToJsValue(ValueBubble const& bubble)
{
    auto value = JsValue::Dict({
        {"label", JsValue(bubble.label_)},
        {"targetNodeId", JsValue(bubble.targetNodeId_)},
        {"kind", JsValue(bubble.kind_)}
    });
    if (!bubble.children_.empty()) {
        auto children = JsValue::List();
        for (auto const& child : bubble.children_) {
            children.push(valueBubbleToJsValue(child));
        }
        value.set("children", children);
    }
    return value;
}

/** Compute propagated scalar bubbles bottom-up and return this node's contribution to its parent. */
std::deque<ValueBubble> buildPropagatedValueBubbles(InspectionNode& node)
{
    struct ChildContribution {
        ValueBubble bubble_;
        bool isCountField_ = false;
    };

    std::vector<ChildContribution> childContributions;
    for (auto& child : node.children_) {
        auto childBubbles = buildPropagatedValueBubbles(child);
        auto const isCountField = isLikelyZserioCountField(inspectionKeyString(child));
        for (auto& bubble : childBubbles) {
            childContributions.push_back(ChildContribution{
                .bubble_ = std::move(bubble),
                .isCountField_ = isCountField
            });
        }
    }

    if (isValidityNode(node)) {
        node.valueBubbles_ = validityBubblesForNode(node);
        return node.valueBubbles_;
    }

    auto scalarBubble = scalarBubbleForNode(node);
    if (scalarBubble) {
        return std::deque<ValueBubble>{std::move(*scalarBubble)};
    }

    if (baseValueType(node.type_) == InspectionConverter::ValueType::Section) {
        return {};
    }

    auto const hasNonCountContribution = std::ranges::any_of(
        childContributions,
        [](auto const& contribution) { return !contribution.isCountField_; });
    for (auto& contribution : childContributions) {
        if (hasNonCountContribution && contribution.isCountField_) {
            continue;
        }
        node.valueBubbles_.push_back(std::move(contribution.bubble_));
    }

    if (node.valueBubbles_.empty() || node.valueBubbles_.size() > kMaxPropagatedBubbles) {
        node.valueBubbles_.clear();
        return {};
    }
    if (isTransparentPropagationContainer(inspectionKeyString(node))) {
        return node.valueBubbles_;
    }
    if (node.valueBubbles_.size() == 1) {
        return std::deque<ValueBubble>{node.valueBubbles_.front()};
    }
    return std::deque<ValueBubble>{makeGroupedBubble(node.valueBubbles_)};
}

}

JsValue InspectionConverter::convert(model_ptr<Feature> const& featurePtr)
{
    stringPool_ = featurePtr->model().strings();
    featureId_ = featurePtr->id()->toString();
    tile_ = &featurePtr->model();

    // Identifiers section.
    {
        auto scope = push(convertString("Identifiers"), "", ValueType::Section);
        convertSourceDataReferences(featurePtr->sourceDataReferences(), *scope);
        push("type", "typeId", ValueType::String)->value_ = convertString(featurePtr->typeId());
        {
            auto featureIdScope = push("featureId", "featureId", ValueType::FeatureId);
            assignFeatureReference(*featureIdScope, featurePtr->id());
        }

        // Add map and layer names to the Identifiers section.
        push("mapId", "mapId", ValueType::String)->value_ = convertString(featurePtr->model().mapId());
        push("layerId", "layerId", ValueType::String)->value_ = convertString(featurePtr->model().layerInfo()->layerId_);

        for (auto const& [key, value]: featurePtr->id()->keyValuePairs()) {
            auto &field = current_->children_.emplace_back();
            field.key_ = convertString(key);
            field.value_ = JsValue::fromVariant(value);
            field.type_ = ValueType::String;
            field.geoJsonPath_ = convertString(key).toString();
        }
    }

    // Basic attributes section.
    if (auto mergedBasicAttrs = featurePtr->mergedAttributesOrNull()) {
        auto scope = push(convertString("Basic Attributes"), RawPath{"properties"}, ValueType::Section);
        for (auto i = 0U; i < mergedBasicAttrs->size(); ++i) {
            convertField(
                mergedBasicAttrs->keyAt(static_cast<int64_t>(i)),
                mergedBasicAttrs->at(static_cast<int64_t>(i)));
        }
    }

    // Flexible attributes section.
    if (auto layers = featurePtr->attributeLayersOrNull())
    {
        auto scope = push(convertString("Attribute Layers"), RawPath{"properties.layer"}, ValueType::Section);
        size_t attributeIndex = 0;
        layers->forEachLayer([this, &attributeIndex](auto&& layerName, auto&& layer) -> bool {
            convertAttributeLayer(layerName, layer, attributeIndex);
            return true;
        });
    }

    // Relation section.
    using namespace mapget;
    if (featurePtr->numRelations())
    {
        auto scope = push(convertString("Relations"), RawPath{"relations"}, ValueType::Section);
        std::unordered_map<std::string_view, std::vector<model_ptr<Relation>>> relsByName;
        featurePtr->forEachRelation([this](model_ptr<Relation> const& relation) -> bool {
            convertRelation(relation);
            return true;
        });
    }

    // Geometry section.
    if (auto geomCollection = featurePtr->geomOrNull())
    {
        auto scope = push(convertString("Geometry"), RawPath{"geometry"}, ValueType::Section);
        const auto highFiStage = highFidelityStage(featurePtr->model());
        const auto exportAsGeometryCollection = geomCollection->numGeometries() > 1;
        uint32_t exportGeometryIndex = 0;
        uint32_t displayGeometryIndex = 0;
        geomCollection->forEachGeometry(
            [this, &exportGeometryIndex, &displayGeometryIndex, highFiStage, exportAsGeometryCollection]
            (model_ptr<Geometry> const& geom) -> bool {
            const auto currentExportGeometryIndex = exportGeometryIndex++;
            const auto geometryStage = geom->model().stage().value_or(0U);
            if (geometryStage < highFiStage) {
                return true;
            }
            const auto geometryObjectPath = exportAsGeometryCollection
                ? fmt::format("geometries[{}]", currentExportGeometryIndex)
                : std::string{};
            convertGeometry(JsValue(displayGeometryIndex++), geom, geometryObjectPath);
            return true;
        });
    }

    assignInspectionNodeIds(root_);
    buildPropagatedValueBubbles(root_);
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
    else if (std::holds_alternative<RawPath>(path)) {
        std::string_view rawPath = std::get<RawPath>(path).value_;
        if (prevTop->geoJsonPath_.empty()) {
            current_->geoJsonPath_ = std::string(rawPath);
        }
        else if (rawPath.empty()) {
            current_->geoJsonPath_ = prevTop->geoJsonPath_;
        }
        else {
            current_->geoJsonPath_ = fmt::format("{}.{}", prevTop->geoJsonPath_, rawPath);
        }
    }
    else {
        std::string_view field = std::get<std::string_view>(path);
        current_->geoJsonPath_ = appendGeoJsonPathField(prevTop->geoJsonPath_, field);
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
    const model_ptr<AttributeLayer>& l,
    size_t& attributeIndex)
{
    auto layerScope = push(convertString(name), name);
    std::vector<simfil::StringId> attributeFieldIds;
    attributeFieldIds.reserve(l->size());
    for (auto const& [fieldId, value] : l->fields()) {
        if (value->addr().column() != TileFeatureLayer::ColumnId::Attributes) {
            continue;
        }
        attributeFieldIds.push_back(fieldId);
    }

    size_t layerAttributeIndex = 0;
    l->forEachAttribute([this, &attributeFieldIds, &attributeIndex, &layerAttributeIndex](model_ptr<Attribute> const& attr)
    {
        auto const featureAttributeIndex = static_cast<uint32_t>(attributeIndex++);
        auto const thisLayerAttributeIndex = layerAttributeIndex++;
        auto fieldId = thisLayerAttributeIndex < attributeFieldIds.size()
            ? attributeFieldIds[thisLayerAttributeIndex]
            : simfil::StringId{};

        auto fieldName = fieldId ? convertString(fieldId).toString() : convertString(attr->name()).toString();
        auto attrScope = push(convertString(fieldId), fieldName, ValueType::Null);
        convertSourceDataReferences(attr->sourceDataReferences(), *attrScope);

        auto numValues = 0;
        OptionalValueAndType singleValue;
        attr->forEachField([this, &numValues, &singleValue](auto const& fieldName, auto const& val) {
            auto singleValueForField = convertField(fieldName, val);
            if (singleValueForField) {
                ++numValues;
                singleValue = singleValueForField;
            }
            return true;
        });

        if (numValues == 1) {
            if (current_->children_.size() == 1) {
                inheritFlattenedChild(*current_, current_->children_.front());
            }
            else {
                std::tie(current_->value_, current_->type_) = *singleValue;
            }
        }
        else if (numValues == 0) {
            current_->value_ = JsValue(true);
            current_->type_ = ValueType::Boolean;
        }

        attrScope->mapId_ = JsValue(tile_->mapId());
        attrScope->hoverId_ = featureId_ + ":attribute#" +
                              std::to_string(featureAttributeIndex);
        if (auto validity = attr->validityOrNull()) {
            convertValidity(convertString("validity"), validity, &attrScope->hoverId_);
        }
        return true;
    });
}

void InspectionConverter::convertRelation(const model_ptr<Relation>& r)
{
    auto& relGroup = relationsByType_[r->name()];
    if (!relGroup) {
        relGroup = push(r->name(), RawPath{""}).node_;
        relGroup->geoJsonPath_ = fmt::format(
            "{}.*{{name = {}}}",
            relGroup->geoJsonPath_,
            simfilStringLiteral(r->name()));
    }
    auto relGroupScope = push(relGroup);
    auto const relationIndex = nextRelationIndex_++;
    auto const relationObjectPath = fmt::format("relations[{}]", relationIndex);
    auto relScope = push(JsValue(relGroup->children_.size()), relationIndex, ValueType::FeatureId);
    relScope->geoJsonPath_ = relationObjectPath;
    assignFeatureReference(*relScope, r->target());
    relScope->hoverId_ = featureId_+":relation#"+std::to_string(relationIndex);
    convertSourceDataReferences(r->sourceDataReferences(), *relScope);
    if (auto const sourceValidity = r->sourceValidityOrNull()) {
        convertValidity(convertString("sourceValidity"), sourceValidity);
    }
    if (auto const targetValidity = r->targetValidityOrNull()) {
        convertValidity(convertString("targetValidity"), targetValidity);
    }
    relScope->geoJsonPath_ = appendGeoJsonPathField(relationObjectPath, "target");
}

void InspectionConverter::convertGeometry(
    JsValue const& key,
    const model_ptr<Geometry>& g,
    std::optional<std::string_view> geometryObjectPath)
{
    std::string keyPath;
    auto geomScope = [&]() {
        if (geometryObjectPath) {
            return push(key, RawPath{*geometryObjectPath}, ValueType::String);
        }
        if (key.type() == JsValue::Type::Number) {
            return push(key, key.as<uint32_t>(), ValueType::String);
        }
        keyPath = key.as<std::string>();
        return push(key, std::string_view(keyPath), ValueType::String);
    }();
    const auto geometryObjectGeoJsonPath = geomScope->geoJsonPath_;
    std::string typeString;
    auto pushPointField = [this](
        std::string_view const& name,
        mapget::Point const& point,
        std::optional<std::string_view> relativePath = std::nullopt) {
        auto fieldScope = relativePath
            ? push(name, RawPath{*relativePath}, ValueType::Number | ValueType::ArrayBit)
            : push(name, name, ValueType::Number | ValueType::ArrayBit);
        fieldScope->value_ = pointArrayValue(point);
        if (!relativePath) {
            fieldScope->geoJsonPath_.clear();
        }
    };
    switch (g->geomType()) {
    case GeomType::Points: typeString = "Points"; break;
    case GeomType::Line: typeString = "Polyline"; break;
    case GeomType::Polygon: typeString = "Polygon"; break;
    case GeomType::Mesh: typeString = "Mesh"; break;
    case GeomType::AABB: typeString = "Bounding Box"; break;
    case GeomType::GltfNodeIndex: typeString = "3D Object"; break;
    }
    geomScope->value_ = convertString(typeString);
    if (auto geometryName = g->name()) {
        push("name", "geometryName", ValueType::String)->value_ = convertString(*geometryName);
    }

    convertSourceDataReferences(g->sourceDataReferences(), *geomScope);

    if (g->geomType() == GeomType::AABB) {
        auto const origin = g->aabbOrigin();
        auto const size = g->aabbSize();
        pushPointField("origin", origin, std::string_view("aabb.origin"));
        pushPointField("size", size, std::string_view("aabb.size"));
        pushPointField("center", boxCenter(origin, size));
        geomScope->geoJsonPath_ = appendGeoJsonPathField(geometryObjectGeoJsonPath, "type");
        return;
    }

    if (g->geomType() == GeomType::GltfNodeIndex) {
        auto const origin = g->gltfNodeAabbOrigin();
        auto const size = g->gltfNodeAabbSize();
        pushPointField("origin", origin);
        pushPointField("size", size);
        pushPointField("center", boxCenter(origin, size));
        geomScope->geoJsonPath_ = appendGeoJsonPathField(geometryObjectGeoJsonPath, "type");
        return;
    }

    uint32_t index = 0;
    g->forEachPoint(
        [this, &g, &index](auto&& pt)
        {
            const auto coordinatePath = geometryCoordinatePath(g, index);
            auto ptScope = push(
                JsValue(index),
                RawPath{coordinatePath},
                ValueType::Number | ValueType::ArrayBit);
            ptScope->value_ = pointArrayValue(pt);
            ++index;
            return true;
        });
    geomScope->geoJsonPath_ = appendGeoJsonPathField(geometryObjectGeoJsonPath, "type");
}

void InspectionConverter::convertValidity(
    JsValue const& key,
    model_ptr<MultiValidity> const& multiValidity,
    std::string const* hoverIdPrefix)
{
    auto scope = push(key, key.as<std::string>());
    auto renderValidity = [this](Validity const& v) -> bool {

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
                dirScope->value_ = convertString("COMPLETE");
                break;
            case Validity::None:
                dirScope->value_ = convertString("NONE");
                break;
            default: break;
            }
        }

        if (auto featureId = v.featureId()) {
            auto featureIdScope = push("featureId", "featureId", ValueType::FeatureId);
            assignFeatureReference(*featureIdScope, featureId);
        }

        if (auto transitionNumber = v.transitionNumber()) {
            push("transitionNumber", "transitionNumber", ValueType::Number)->value_ =
                JsValue(*transitionNumber);
            if (auto fromFeature = v.transitionFromFeature()) {
                auto fromScope = push("from", "from", ValueType::FeatureId);
                fromScope->value_ = convertString(fromFeature->id()->toString());
                fromScope->mapId_ = JsValue(fromFeature->model().mapId());
            }
            if (auto fromConnectedEnd = v.transitionFromConnectedEnd()) {
                push("fromConnectedEnd", "fromConnectedEnd", ValueType::String)->value_ =
                    convertString(*fromConnectedEnd == Validity::End ? "END" : "START");
            }
            if (auto toFeature = v.transitionToFeature()) {
                auto toScope = push("to", "to", ValueType::FeatureId);
                toScope->value_ = convertString(toFeature->id()->toString());
                toScope->mapId_ = JsValue(toFeature->model().mapId());
            }
            if (auto toConnectedEnd = v.transitionToConnectedEnd()) {
                push("toConnectedEnd", "toConnectedEnd", ValueType::String)->value_ =
                    convertString(*toConnectedEnd == Validity::End ? "END" : "START");
            }
            return true;
        }

        if (auto geom = v.simpleGeometry()) {
            auto const highFiStage = highFidelityStage(v.model());
            auto const geometryStage = geom->model().stage().value_or(0U);
            if (geometryStage >= highFiStage) {
                convertGeometry(JsValue("simpleGeometry"), geom);
            }
            return true;
        }

        if (auto geometryStage = v.geometryStage()) {
            push("geometryStage", "geometryStage", ValueType::Number)->value_ = JsValue(*geometryStage);
            if (shouldDisplayStageLabel(v.model(), *geometryStage)) {
                push("geometryStageLabel", "geometryStageLabel", ValueType::String)->value_ =
                    convertString(stageLabel(v.model(), *geometryStage));
            }
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
    };

    if (multiValidity->size() == 1) {
        if (hoverIdPrefix) {
            scope->hoverId_ = *hoverIdPrefix + ":validity#0";
        }
        multiValidity->forEach(renderValidity);
        return;
    }

    uint32_t valIndex = 0;
    multiValidity->forEach([&](Validity const& v) -> bool {
        auto validityScope = push(
            JsValue(valIndex),
            valIndex);
        if (hoverIdPrefix) {
            validityScope->hoverId_ = *hoverIdPrefix + ":validity#" + std::to_string(valIndex);
        }
        ++valIndex;
        return renderValidity(v);
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
    auto path = fieldName.toString();
    return convertField(fieldName, std::string_view(path), value);
}

InspectionConverter::OptionalValueAndType
InspectionConverter::convertField(
    const JsValue& fieldName,
    FieldOrIndex const& path,
    const simfil::ModelNode::Ptr& value)
{
    auto fieldScope = push(fieldName, path);
    bool isArray = false;
    OptionalValueAndType singleValue;

    if (value->addr().column() == TileFeatureLayer::ColumnId::FeatureIds ||
        value->addr().column() == TileFeatureLayer::ColumnId::ExternalFeatureIds)
    {
        auto featureId = tile_->resolve<FeatureId>(*value);
        assignFeatureReference(*fieldScope, featureId);
        singleValue = {fieldScope->value_, ValueType::FeatureId};
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
        case simfil::ValueType::Bytes:
            singleValue = {JsValue(byteArrayToDisplayString(std::get<simfil::ByteArray>(value->value()))), ValueType::String};
            break;
        case simfil::ValueType::Object: break;
        case simfil::ValueType::Array:
            isArray = true;
            fieldScope->type_ = ValueType::ArrayBit;
            break;
        case simfil::ValueType::LAST_: break;
        }
    }

    if (singleValue) {
        std::tie(fieldScope->value_, fieldScope->type_) = *singleValue;
        return singleValue;
    }

    auto const containerPath = fieldScope->geoJsonPath_;
    auto numValues = 0;
    auto index = 0;
    for (auto const& [k, v] : value->fields()) {
        auto kk = isArray ? JsValue(index) : convertString(k);
        auto keyPath = kk.toString();
        auto singleValueForField = isArray
            ? convertField(kk, static_cast<uint32_t>(index), v)
            : convertField(kk, std::string_view(keyPath), v);
        if (singleValueForField) {
            ++numValues;
            singleValue = singleValueForField;
        }
        ++index;
    }

    if (numValues == 1) {
        if (fieldScope->children_.size() == 1) {
            inheritFlattenedChild(*fieldScope, fieldScope->children_.front());
        }
        else {
            std::tie(fieldScope->value_, fieldScope->type_) = *singleValue;
        }
        if (isArray) {
            fieldScope->type_ = fieldScope->type_ | ValueType::ArrayBit;
            fieldScope->geoJsonPath_ = directChildGeoJsonPath(containerPath);
        }
        return singleValue;
    }
    if (isArray) {
        fieldScope->geoJsonPath_ = directChildGeoJsonPath(containerPath);
    }
    return {};
}

void InspectionConverter::inheritFlattenedChild(InspectionNode& parent, InspectionNode const& child)
{
    parent.value_ = child.value_;
    parent.type_ = child.type_;
    parent.mapId_ = child.mapId_;
    parent.hoverId_ = child.hoverId_;
    parent.info_ = child.info_;
    parent.geoJsonPath_ = child.geoJsonPath_;
    if (!child.sourceDataRefs_.empty()) {
        parent.sourceDataRefs_ = child.sourceDataRefs_;
    }
}

void InspectionConverter::assignFeatureReference(
    InspectionNode& node,
    model_ptr<FeatureId> const& featureId)
{
    node.type_ = ValueType::FeatureId;
    if (!featureId) {
        node.value_ = convertString("");
        node.mapId_ = JsValue(tile_->mapId());
        return;
    }

    node.value_ = convertString(featureId->toString());
    node.mapId_ = JsValue(featureId->mapId());
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
    if (!nodeId_.empty())
        newDict.set("nodeId", JsValue(nodeId_));
    if (mapId_)
        newDict.set("mapId", *mapId_);
    if (!valueBubbles_.empty()) {
        auto bubbles = JsValue::List();
        for (auto const& bubble : valueBubbles_) {
            bubbles.push(valueBubbleToJsValue(bubble));
        }
        newDict.set("valueBubbles", bubbles);
    }
    if (!sourceDataRefs_.empty()) {
        auto list = JsValue::List();
        for (const auto& ref : sourceDataRefs_) {
            list.push(JsValue::Dict({
                {"mapTileKey", JsValue(MapTileKey(
                    LayerType::SourceData,
                    std::string(mapId),
                    ref.layerId_,
                    mapget::TileId::fromValue(ref.tileId_)).toString())},
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
