#include "inspection.h"
#include "mapget/model/featurelayer.h"
#include "mapget/model/sourcedatareference.h"
#include "simfil/model/nodes.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <iostream>
#include <limits>
#include <optional>
#include <span>
#include <string>
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

using InspectionNode = InspectionConverter::InspectionNode;
using ValueBubble = InspectionConverter::InspectionNode::ValueBubble;

constexpr auto kMaxAggregateValues = 100U;

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
ValueBubble makeValueBubble(
    std::string label,
    std::string targetNodeId,
    std::string kind,
    std::string colorKey = {})
{
    return ValueBubble{
        .label_ = std::move(label),
        .targetNodeId_ = std::move(targetNodeId),
        .kind_ = std::move(kind),
        .colorKey_ = std::move(colorKey)
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

/** Return whether a bubble carries compact validity information. */
bool isValidityBubble(ValueBubble const& bubble)
{
    return bubble.kind_.rfind("validity", 0) == 0;
}

/** Return whether a bubble only says that the validity covers the complete host. */
bool isCompleteValidityBubble(ValueBubble const& bubble)
{
    return bubble.kind_ == "validity-complete";
}

/** Return whether a bubble is weak metadata for an empty zserio bitmask. */
bool isEmptyBitmaskBubble(ValueBubble const& bubble)
{
    return bubble.kind_ == "bool-array-empty" || bubble.label_ == "0[]";
}

/** Return whether this bubble must remain visually independent while propagating. */
bool isUngroupedBubble(ValueBubble const& bubble)
{
    return bubble.kind_ == "relation"
        || bubble.kind_ == "pair"
        || bubble.kind_ == "days-of-week"
        || bubble.kind_ == "months-of-year";
}

/** Return whether any bubble in this group should remain visually independent. */
bool containsUngroupedBubble(std::deque<ValueBubble> const& bubbles)
{
    return std::ranges::any_of(bubbles, [](auto const& bubble) { return isUngroupedBubble(bubble); });
}

/** Keep validity summaries at the front so spatial constraints are visible first. */
void sortValidityBubblesFirst(std::deque<ValueBubble>& bubbles)
{
    std::stable_sort(bubbles.begin(), bubbles.end(), [](auto const& a, auto const& b) {
        return isValidityBubble(a) && !isValidityBubble(b);
    });
}

/** Add a bubble to a grouped visual, flattening nested groups to keep one level of agglomeration. */
void appendGroupedBubblePart(ValueBubble bubble, std::deque<ValueBubble>& parts)
{
    if (bubble.kind_ == "group" && !bubble.children_.empty()) {
        for (auto& child : bubble.children_) {
            appendGroupedBubblePart(std::move(child), parts);
        }
        return;
    }
    parts.push_back(std::move(bubble));
}

/** Combine child bubbles into one grouped summary bubble for propagation through a container. */
ValueBubble makeGroupedBubble(std::deque<ValueBubble> children)
{
    std::deque<ValueBubble> parts;
    for (auto& child : children) {
        appendGroupedBubblePart(std::move(child), parts);
    }
    sortValidityBubblesFirst(parts);

    std::string label;
    for (auto const& child : parts) {
        if (!label.empty()) {
            label += " ";
        }
        label += child.label_;
    }
    auto group = makeValueBubble(
        std::move(label),
        parts.empty() ? std::string{} : firstBubbleTarget(parts.front()),
        parts.size() == 2
            && std::ranges::all_of(parts, [](auto const& part) {
                return part.kind_ == "scalar" || part.kind_ == "feature-id";
            })
                ? "pair"
                : "group");
    group.children_ = std::move(parts);
    return group;
}

/** Return the filtering rank used when choosing which child summaries survive propagation. */
uint8_t bubbleContributionRank(ValueBubble const& bubble, bool isCountField)
{
    return static_cast<uint8_t>((isCountField ? 4U : 0U)
        | (isCompleteValidityBubble(bubble) ? 2U : 0U)
        | (isEmptyBitmaskBubble(bubble) ? 1U : 0U));
}

/**
 * Keep at most `remaining` scalar values from a bubble tree.
 *
 * Group shells are retained so sibling pairs remain visually disjoint, while
 * nested aggregate content is truncated before it can grow quadratically.
 */
std::optional<ValueBubble> takeBubblePrefix(
    ValueBubble bubble,
    size_t& remaining,
    bool& truncated)
{
    if (bubble.children_.empty()) {
        if (remaining == 0) {
            truncated = true;
            return std::nullopt;
        }
        --remaining;
        return bubble;
    }

    auto children = std::move(bubble.children_);
    bubble.children_.clear();
    for (size_t index = 0; index < children.size(); ++index) {
        if (remaining == 0) {
            truncated = true;
            break;
        }
        if (auto child = takeBubblePrefix(std::move(children[index]), remaining, truncated)) {
            bubble.children_.push_back(std::move(*child));
        }
    }
    if (bubble.children_.empty()) {
        return std::nullopt;
    }

    bubble.label_.clear();
    for (auto const& child : bubble.children_) {
        if (!bubble.label_.empty()) {
            bubble.label_ += " ";
        }
        bubble.label_ += child.label_;
    }
    bubble.targetNodeId_ = firstBubbleTarget(bubble.children_.front());
    return bubble;
}

/** Result returned to a parent while keeping truncation separate from real value bubbles. */
struct BubblePropagation {
    std::deque<ValueBubble> bubbles_;
    bool truncated_ = false;
};

/** Add the visual overflow marker to a row-local summary without propagating it as a value. */
void setNodeValueBubbles(
    InspectionNode& node,
    std::deque<ValueBubble> const& bubbles,
    bool truncated)
{
    node.valueBubbles_ = bubbles;
    if (truncated) {
        node.valueBubbles_.push_back(makeValueBubble("…", node.nodeId_, "overflow", "overflow"));
    }
}

InspectionNode const* directChildByKey(InspectionNode const& node, std::string_view key);

/** Return whether a child node is a true boolean flag. */
bool isTrueBooleanChild(InspectionNode const* child)
{
    return child
        && baseValueType(child->type_) == InspectionConverter::ValueType::Boolean
        && child->value_.type() == JsValue::Type::Bool
        && child->value_.as<bool>();
}

/** Return a compact label for an inclusive range of named boolean flags. */
std::string rangeLabel(
    std::span<std::pair<std::string_view, InspectionNode const*> const> values,
    size_t first,
    size_t last)
{
    if (first == last) {
        return std::string(values[first].first);
    }
    return fmt::format("{}-{}", values[first].first, values[last].first);
}

/** Summarize a named boolean-flag structure as compact continuous ranges plus the inclusive flag. */
std::deque<ValueBubble> booleanRangeBubblesForNode(
    InspectionNode const& node,
    std::span<std::pair<std::string_view, std::string_view> const> fields,
    std::string_view kind,
    std::string_view colorKey)
{
    std::vector<std::pair<std::string_view, InspectionNode const*>> values;
    values.reserve(fields.size());
    for (auto const& [label, field] : fields) {
        values.emplace_back(label, directChildByKey(node, field));
    }

    auto const looksLikeRangeStructure = std::ranges::any_of(values, [](auto const& value) {
        return value.second != nullptr;
    }) && directChildByKey(node, "isInclusive") != nullptr;
    if (!looksLikeRangeStructure) {
        return {};
    }

    std::vector<std::string> ranges;
    std::string targetNodeId;
    for (size_t index = 0; index < values.size();) {
        if (!isTrueBooleanChild(values[index].second)) {
            ++index;
            continue;
        }
        if (targetNodeId.empty()) {
            targetNodeId = values[index].second->nodeId_;
        }
        auto rangeEnd = index;
        while (rangeEnd + 1 < values.size() && isTrueBooleanChild(values[rangeEnd + 1].second)) {
            ++rangeEnd;
        }
        ranges.push_back(rangeLabel(values, index, rangeEnd));
        index = rangeEnd + 1;
    }

    std::deque<ValueBubble> bubbles;
    if (!ranges.empty()) {
        auto label = std::string{};
        for (auto const& range : ranges) {
            if (!label.empty()) {
                label += ",";
            }
            label += range;
        }
        bubbles.push_back(makeValueBubble(std::move(label), targetNodeId, std::string(kind), std::string(colorKey)));
    }
    if (auto const* isInclusive = directChildByKey(node, "isInclusive"); isTrueBooleanChild(isInclusive)) {
        bubbles.push_back(makeValueBubble("isInclusive", isInclusive->nodeId_, "boolean", "isInclusive"));
    }
    return bubbles;
}

/** Summarize zserio/NDS day-of-week structures as compact weekday ranges plus the inclusive flag. */
std::deque<ValueBubble> daysOfWeekBubblesForNode(InspectionNode const& node)
{
    static constexpr std::array<std::pair<std::string_view, std::string_view>, 7> kDays = {{
        {"Mon", "isMonday"},
        {"Tue", "isTuesday"},
        {"Wed", "isWednesday"},
        {"Thu", "isThursday"},
        {"Fri", "isFriday"},
        {"Sat", "isSaturday"},
        {"Sun", "isSunday"},
    }};
    return booleanRangeBubblesForNode(node, kDays, "days-of-week", "daysOfWeek");
}

/** Summarize zserio/NDS month-of-year structures as compact month ranges plus the inclusive flag. */
std::deque<ValueBubble> monthsOfYearBubblesForNode(InspectionNode const& node)
{
    static constexpr std::array<std::pair<std::string_view, std::string_view>, 12> kMonths = {{
        {"Jan", "january"},
        {"Feb", "february"},
        {"Mar", "march"},
        {"Apr", "april"},
        {"May", "may"},
        {"Jun", "june"},
        {"Jul", "july"},
        {"Aug", "august"},
        {"Sep", "september"},
        {"Oct", "october"},
        {"Nov", "november"},
        {"Dec", "december"},
    }};
    return booleanRangeBubblesForNode(node, kMonths, "months-of-year", "monthsOfYear");
}

/** Return whether a node represents a flat boolean array in inspection form. */
bool isBooleanArrayNode(InspectionNode const& node)
{
    return isArrayValue(node.type_)
        && !node.children_.empty()
        && std::ranges::all_of(node.children_, [](auto const& child) {
            return child.children_.empty()
                && baseValueType(child.type_) == InspectionConverter::ValueType::Boolean
                && child.value_.type() == JsValue::Type::Bool;
        });
}

/** Summarize a boolean array as a compact bit-vector bubble. */
std::optional<ValueBubble> booleanArrayBitsBubbleForNode(InspectionNode const& node)
{
    if (!isBooleanArrayNode(node)) {
        return std::nullopt;
    }

    auto hasTrueValue = false;
    auto targetNodeId = node.nodeId_;
    std::string label;
    size_t valueCount = 0;
    for (auto const& child : node.children_) {
        if (valueCount == kMaxAggregateValues) {
            label += " …";
            break;
        }
        auto const childValue = child.value_.as<bool>();
        if (!label.empty()) {
            label += " ";
        }
        label += childValue ? "1" : "0";
        if (childValue && !hasTrueValue) {
            targetNodeId = child.nodeId_;
            hasTrueValue = true;
        }
        ++valueCount;
    }

    return makeValueBubble(
        std::move(label),
        targetNodeId,
        hasTrueValue ? "bool-array" : "bool-array-empty",
        inspectionKeyString(node));
}

/** Return the named boolean-array summary that should propagate to parent rows. */
std::optional<ValueBubble> propagatedBooleanArrayBubbleForNode(InspectionNode const& node)
{
    auto bitsBubble = booleanArrayBitsBubbleForNode(node);
    if (!bitsBubble) {
        return std::nullopt;
    }

    std::deque<ValueBubble> parts;
    parts.push_back(makeValueBubble(
        inspectionKeyString(node),
        node.nodeId_,
        "bool-array-name",
        inspectionKeyString(node)));
    parts.push_back(*bitsBubble);

    auto result = makeGroupedBubble(std::move(parts));
    result.kind_ = bitsBubble->kind_;
    result.colorKey_ = inspectionKeyString(node);
    return result;
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
            auto key = inspectionKeyString(node);
            return makeValueBubble(key, node.nodeId_, "boolean", key);
        }
        return std::nullopt;
    case InspectionConverter::ValueType::Number:
    case InspectionConverter::ValueType::String:
        return makeValueBubble(node.value_.toString(), node.nodeId_, "scalar", inspectionKeyString(node));
    case InspectionConverter::ValueType::FeatureId:
        return makeValueBubble(node.value_.toString(), node.nodeId_, "feature-id", inspectionKeyString(node));
    case InspectionConverter::ValueType::Null:
        return std::nullopt;
    case InspectionConverter::ValueType::Section:
    case InspectionConverter::ValueType::ArrayBit:
        return std::nullopt;
    }
    return std::nullopt;
}

/** Render a leaf scalar on its own row; propagation uses stricter boolean semantics. */
std::optional<ValueBubble> leafDisplayBubbleForNode(InspectionNode const& node, std::string_view parentKey)
{
    if (!node.children_.empty() || isArrayValue(node.type_)) {
        return std::nullopt;
    }

    auto const key = inspectionKeyString(node);
    if (key == "direction" && (
            parentKey == "validity" || parentKey == "sourceValidity" || parentKey == "targetValidity")) {
        return makeValueBubble(node.value_.toString(), node.nodeId_, "validity", "validity");
    }

    switch (baseValueType(node.type_)) {
    case InspectionConverter::ValueType::Boolean:
    case InspectionConverter::ValueType::Number:
    case InspectionConverter::ValueType::String:
        return makeValueBubble(node.value_.toString(), node.nodeId_, "scalar", key);
    case InspectionConverter::ValueType::FeatureId:
        return makeValueBubble(node.value_.toString(), node.nodeId_, "feature-id", key);
    case InspectionConverter::ValueType::Null:
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
        return "±";
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

/** Label and propagation strength for one compact validity bubble. */
struct CompactValidityBubble {
    std::string label_;
    std::string kind_;
};

/** Create the label for one compact validity bubble. */
CompactValidityBubble compactValidityBubble(InspectionNode const& validityNode)
{
    std::vector<std::string> parts;
    auto hasCompleteDirectionOnly = false;
    if (auto direction = compactValidityDirection(validityNode); !direction.empty()) {
        hasCompleteDirectionOnly = direction == "±";
        parts.push_back(std::move(direction));
    }
    if (auto const* featureId = directChildByKey(validityNode, "featureId")) {
        parts.push_back(featureId->value_.toString());
        hasCompleteDirectionOnly = false;
    }
    else if (auto const* transitionNumber = directChildByKey(validityNode, "transitionNumber")) {
        parts.push_back("T" + transitionNumber->value_.toString());
        hasCompleteDirectionOnly = false;
    }

    if (auto const* point = directChildByKey(validityNode, "point")) {
        parts.push_back(compactValidityOffset(*point));
        hasCompleteDirectionOnly = false;
    }
    else {
        auto const* start = directChildByKey(validityNode, "start");
        auto const* end = directChildByKey(validityNode, "end");
        if (start && end) {
            parts.push_back(fmt::format("{} to {}", compactValidityOffset(*start), compactValidityOffset(*end)));
            hasCompleteDirectionOnly = false;
        }
    }

    if (parts.empty()) {
        return CompactValidityBubble{.label_ = "validity", .kind_ = "validity"};
    }
    if (hasCompleteDirectionOnly) {
        return CompactValidityBubble{.label_ = "COMPLETE", .kind_ = "validity-complete"};
    }

    std::string label;
    for (auto const& part : parts) {
        if (!label.empty()) {
            label += " ";
        }
        label += part;
    }
    return CompactValidityBubble{.label_ = std::move(label), .kind_ = "validity"};
}

/** Return whether a node represents a validity container or one indexed validity entry. */
bool isValidityNode(InspectionNode const& node)
{
    auto const key = inspectionKeyString(node);
    if (key == "validity" || key == "sourceValidity" || key == "targetValidity") {
        return true;
    }
    if (directChildByKey(node, "target")) {
        return false;
    }
    return node.hoverId_.find(":validity#") != std::string::npos;
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
        auto compact = compactValidityBubble(child);
        if (compact.label_ == "validity") {
            continue;
        }
        auto kind = std::move(compact.kind_);
        bubbles.push_back(makeValueBubble(std::move(compact.label_), child.nodeId_, kind, "validity"));
    }
    if (!bubbles.empty()) {
        return bubbles;
    }
    auto compact = compactValidityBubble(node);
    if (compact.label_ == "validity") {
        return {};
    }
    auto kind = std::move(compact.kind_);
    bubbles.push_back(makeValueBubble(std::move(compact.label_), node.nodeId_, kind, "validity"));
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
    if (!bubble.hoverTargetNodeId_.empty()) {
        value.set("hoverTargetNodeId", JsValue(bubble.hoverTargetNodeId_));
    }
    if (!bubble.colorKey_.empty()) {
        value.set("colorKey", JsValue(bubble.colorKey_));
    }
    if (!bubble.children_.empty()) {
        auto children = JsValue::List();
        for (auto const& child : bubble.children_) {
            children.push(valueBubbleToJsValue(child));
        }
        value.set("children", children);
    }
    return value;
}

/** Return whether a node is a relation object or relation row in inspection form. */
bool isRelationNode(InspectionNode const& node)
{
    return node.hoverId_.find(":relation#") != std::string::npos
        || (directChildByKey(node, "target")
            && (directChildByKey(node, "sourceValidity") || directChildByKey(node, "targetValidity")));
}

/** Append compact validity bubbles from a relation-side validity child. */
void appendRelationValidityBubbles(InspectionNode const* validityNode, std::deque<ValueBubble>& children)
{
    if (!validityNode) {
        return;
    }
    if (validityNode->valueBubbles_.empty()) {
        return;
    }
    if (validityNode->valueBubbles_.size() == 1) {
        children.push_back(validityNode->valueBubbles_.front());
        return;
    }
    children.push_back(makeGroupedBubble(validityNode->valueBubbles_));
}

/** Pick the concrete target-validity row that a relation target feature bubble should preview. */
std::string relationTargetValidityHoverNodeId(InspectionNode const* validityNode)
{
    if (!validityNode) {
        return {};
    }
    if (!validityNode->valueBubbles_.empty()) {
        return firstBubbleTarget(validityNode->valueBubbles_.front());
    }
    return validityNode->nodeId_;
}

/** Build the compact relation bubble: target feature plus optional source/target validity summaries. */
std::optional<ValueBubble> relationBubbleForNode(InspectionNode const& node)
{
    if (!isRelationNode(node)) {
        return std::nullopt;
    }

    auto const* targetValidity = directChildByKey(node, "targetValidity");
    std::deque<ValueBubble> children;
    appendRelationValidityBubbles(directChildByKey(node, "sourceValidity"), children);

    if (auto const* target = directChildByKey(node, "target")) {
        std::optional<ValueBubble> targetFeature;
        if (!target->valueBubbles_.empty()) {
            targetFeature = target->valueBubbles_.front();
        }
        else if (target->value_.type() == JsValue::Type::String) {
            targetFeature = makeValueBubble(target->value_.toString(), target->nodeId_, "feature-id", inspectionKeyString(*target));
        }
        if (targetFeature) {
            targetFeature->hoverTargetNodeId_ = relationTargetValidityHoverNodeId(targetValidity);
            children.push_back(std::move(*targetFeature));
        }
    }

    appendRelationValidityBubbles(targetValidity, children);

    if (children.empty()) {
        return std::nullopt;
    }

    std::string label;
    for (auto const& child : children) {
        if (!label.empty()) {
            label += " ";
        }
        label += child.label_;
    }
    auto relation = makeValueBubble(std::move(label), firstBubbleTarget(children.front()), "relation", "relation");
    relation.children_ = std::move(children);
    return relation;
}

/** Prefer a relation's single target-validity row when selecting/highlighting relation references. */
std::string relationRowHoverId(model_ptr<Relation> const& relation, std::string const& relationHoverId)
{
    auto targetValidity = relation ? relation->targetValidityOrNull() : nullptr;
    if (targetValidity && targetValidity->size() == 1) {
        return relationHoverId + ":validity#0";
    }
    return relationHoverId;
}

/** Compute bounded scalar summaries bottom-up and return this node's contribution to its parent. */
BubblePropagation buildPropagatedValueBubbles(InspectionNode& node, std::string_view parentKey = {})
{
    node.valueBubbles_.clear();
    std::deque<ValueBubble> childContributions;
    auto remainingValues = static_cast<size_t>(kMaxAggregateValues);
    auto childContributionsTruncated = false;
    std::optional<uint8_t> bestContributionRank;
    auto const key = inspectionKeyString(node);
    for (auto& child : node.children_) {
        auto childPropagation = buildPropagatedValueBubbles(child, key);
        if (childPropagation.bubbles_.empty()) {
            continue;
        }
        auto const isCountField = isLikelyZserioCountField(inspectionKeyString(child));
        auto childRank = std::numeric_limits<uint8_t>::max();
        for (auto const& bubble : childPropagation.bubbles_) {
            childRank = std::min(childRank, bubbleContributionRank(bubble, isCountField));
        }
        if (!bestContributionRank || childRank < *bestContributionRank) {
            bestContributionRank = childRank;
            childContributions.clear();
            remainingValues = kMaxAggregateValues;
            childContributionsTruncated = false;
        }
        if (childRank != *bestContributionRank) {
            continue;
        }

        childContributionsTruncated |= childPropagation.truncated_;
        for (auto& bubble : childPropagation.bubbles_) {
            if (bubbleContributionRank(bubble, isCountField) != childRank) {
                continue;
            }
            if (auto retained = takeBubblePrefix(
                    std::move(bubble),
                    remainingValues,
                    childContributionsTruncated)) {
                childContributions.push_back(std::move(*retained));
            }
        }
    }

    if (parentKey == "Attribute Layers") {
        return {};
    }
    if (parentKey == "Identifiers") {
        return {};
    }

    if (auto leafDisplayBubble = leafDisplayBubbleForNode(node, parentKey)) {
        node.valueBubbles_.push_back(*leafDisplayBubble);
    }

    if (isValidityNode(node)) {
        node.valueBubbles_ = validityBubblesForNode(node);
        return {.bubbles_ = node.valueBubbles_};
    }

    auto daysOfWeekBubbles = daysOfWeekBubblesForNode(node);
    if (!daysOfWeekBubbles.empty()) {
        node.valueBubbles_ = std::move(daysOfWeekBubbles);
        return {.bubbles_ = node.valueBubbles_};
    }

    auto monthsOfYearBubbles = monthsOfYearBubblesForNode(node);
    if (!monthsOfYearBubbles.empty()) {
        node.valueBubbles_ = std::move(monthsOfYearBubbles);
        return {.bubbles_ = node.valueBubbles_};
    }

    auto booleanArrayBitsBubble = booleanArrayBitsBubbleForNode(node);
    if (booleanArrayBitsBubble) {
        node.valueBubbles_.push_back(*booleanArrayBitsBubble);
        if (auto propagated = propagatedBooleanArrayBubbleForNode(node)) {
            return {.bubbles_ = {std::move(*propagated)}};
        }
        return {};
    }

    auto relationBubble = relationBubbleForNode(node);
    if (relationBubble) {
        node.valueBubbles_.push_back(std::move(*relationBubble));
        return {.bubbles_ = node.valueBubbles_};
    }

    auto scalarBubble = scalarBubbleForNode(node);
    if (scalarBubble) {
        return {.bubbles_ = {std::move(*scalarBubble)}};
    }

    if (baseValueType(node.type_) == InspectionConverter::ValueType::Section) {
        return {};
    }

    sortValidityBubblesFirst(childContributions);
    if (childContributions.empty()) {
        return {};
    }
    setNodeValueBubbles(node, childContributions, childContributionsTruncated);

    if (isTransparentPropagationContainer(inspectionKeyString(node))) {
        return {
            .bubbles_ = std::move(childContributions),
            .truncated_ = childContributionsTruncated
        };
    }
    if (containsUngroupedBubble(childContributions)) {
        return {
            .bubbles_ = std::move(childContributions),
            .truncated_ = childContributionsTruncated
        };
    }
    if (childContributions.size() == 1) {
        return {
            .bubbles_ = std::move(childContributions),
            .truncated_ = childContributionsTruncated
        };
    }
    std::deque<ValueBubble> grouped;
    grouped.push_back(makeGroupedBubble(std::move(childContributions)));
    return {
        .bubbles_ = std::move(grouped),
        .truncated_ = childContributionsTruncated
    };
}

}

JsValue InspectionConverter::convert(model_ptr<Feature> const& featurePtr)
{
    stringPool_ = featurePtr->model().strings();
    featureId_ = featurePtr->id()->toString();
    tile_ = &featurePtr->model();

    // Identifiers section.
    {
        auto scope = push(convertString("Identifiers"), RawPath{""}, ValueType::Section);
        convertSourceDataReferences(featurePtr->sourceDataReferences(), *scope);
        push("type", "typeId", ValueType::String)->value_ = convertString(featurePtr->typeId());
        {
            auto featureIdScope = push("featureId", "id", ValueType::FeatureId);
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
        auto scope = push(convertString("Basic Attributes"), RawPath{"attributes"}, ValueType::Section);
        for (auto i = 0U; i < mergedBasicAttrs->size(); ++i) {
            convertField(
                mergedBasicAttrs->keyAt(static_cast<int64_t>(i)),
                mergedBasicAttrs->at(static_cast<int64_t>(i)));
        }
    }

    // Flexible attributes section.
    if (auto layers = featurePtr->attributeLayersOrNull())
    {
        auto scope = push(convertString("Attribute Layers"), RawPath{"attributes.layer"}, ValueType::Section);
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
        const auto exportAsGeometryCollection = geomCollection->numGeometries() > 1;
        uint32_t exportGeometryIndex = 0;
        uint32_t displayGeometryIndex = 0;
        geomCollection->forEachGeometry(
            [this, &exportGeometryIndex, &displayGeometryIndex, exportAsGeometryCollection]
            (model_ptr<Geometry> const& geom) -> bool {
            const auto currentExportGeometryIndex = exportGeometryIndex++;
            const auto geometryObjectPath = exportAsGeometryCollection
                ? fmt::format("geometries[{}]", currentExportGeometryIndex)
                : std::string{};
            convertGeometry(JsValue(displayGeometryIndex++), geom, geometryObjectPath);
            return true;
        });
    }

    finalizeTree(root_);
    return root_.childrenToJsValue(tile_->mapId());
}

void InspectionConverter::finalizeTree(InspectionNode& root)
{
    assignInspectionNodeIds(root);
    buildPropagatedValueBubbles(root);
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
    else if (std::holds_alternative<AbsolutePath>(path)) {
        current_->geoJsonPath_ = std::string(std::get<AbsolutePath>(path).value_);
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
    if (auto layerId = l->id()) {
        layerScope->keyBubbles_.push_back({
            .label_ = "#" + std::to_string(*layerId),
            .kind_ = "attribute-layer-id"
        });
    }

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

        auto hasFields = false;
        attr->forEachField([this, &hasFields](auto const& fieldName, auto const& val) {
            hasFields = true;
            convertField(fieldName, val);
            return true;
        });

        if (!hasFields) {
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

uint32_t InspectionConverter::relationIndexFor(const model_ptr<Relation>& r)
{
    if (auto featureRelationIndex = r->featureRelationIndex()) {
        return *featureRelationIndex;
    }
    return nextRelationIndex_++;
}

void InspectionConverter::convertRelation(
    JsValue const& key,
    FieldOrIndex const& path,
    const model_ptr<Relation>& r,
    uint32_t relationIndex,
    std::optional<std::string> targetGeoJsonPath)
{
    auto const relationHoverId = featureId_ + ":relation#" + std::to_string(relationIndex);
    auto relationScope = push(key, path);
    relationScope->hoverId_ = relationRowHoverId(r, relationHoverId);
    convertSourceDataReferences(r->sourceDataReferences(), *relationScope);
    {
        auto targetPath = targetGeoJsonPath.value_or(appendGeoJsonPathField(relationScope->geoJsonPath_, "target"));
        auto targetScope = push(convertString("target"), RawPath{""}, ValueType::FeatureId);
        assignFeatureReference(*targetScope, r->target());
        targetScope->geoJsonPath_ = std::move(targetPath);
    }
    if (auto const sourceValidity = r->sourceValidityOrNull()) {
        convertValidity(convertString("sourceValidity"), sourceValidity);
    }
    if (auto const targetValidity = r->targetValidityOrNull()) {
        convertValidity(convertString("targetValidity"), targetValidity, &relationHoverId);
    }
}

void InspectionConverter::convertRelation(const model_ptr<Relation>& r)
{
    auto& relGroup = relationsByType_[r->name()];
    if (!relGroup.node_) {
        relGroup.node_ = push(r->name(), RawPath{""}).node_;
        relGroup.node_->geoJsonPath_ = fmt::format(
            "{}.*{{name = {}}}",
            relGroup.node_->geoJsonPath_,
            simfilStringLiteral(r->name()));
    }
    auto relGroupScope = push(relGroup.node_);
    auto const relationIndex = relationIndexFor(r);
    auto const relationObjectPath = fmt::format(
        "select({}, {})",
        relGroup.node_->geoJsonPath_,
        relGroup.nextLocalIndex_++);
    convertRelation(
        JsValue(relGroup.node_->children_.size()),
        AbsolutePath{relationObjectPath},
        r,
        relationIndex);
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
            convertGeometry(JsValue("simpleGeometry"), geom);
            return true;
        }

        if (auto geometryName = v.geometryName()) {
            push("geometryName", "geometryName", ValueType::String)->value_ =
                convertString(*geometryName);
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

void InspectionConverter::convertField(
    const simfil::StringId& fieldId,
    const simfil::ModelNode::Ptr& value)
{
    convertField(convertString(fieldId), value);
}

void InspectionConverter::convertField(
    const std::string_view& fieldName,
    const simfil::ModelNode::Ptr& value)
{
    convertField(convertString(fieldName), value);
}

void InspectionConverter::convertField(const JsValue& fieldName, const simfil::ModelNode::Ptr& value)
{
    auto path = fieldName.toString();
    convertField(fieldName, std::string_view(path), value);
}

void InspectionConverter::convertField(
    const JsValue& fieldName,
    FieldOrIndex const& path,
    const simfil::ModelNode::Ptr& value)
{
    if (value->addr().column() == TileFeatureLayer::ColumnId::RelationReferences) {
        auto relationRef = tile_->resolve<RelationReference>(*value);
        auto relation = relationRef->relation();
        convertRelation(fieldName, path, relation, relationIndexFor(relation));
        return;
    }

    auto fieldScope = push(fieldName, path);
    bool isArray = false;

    if (value->addr().column() == TileFeatureLayer::ColumnId::FeatureIds ||
        value->addr().column() == TileFeatureLayer::ColumnId::ExternalFeatureIds)
    {
        auto featureId = tile_->resolve<FeatureId>(*value);
        assignFeatureReference(*fieldScope, featureId);
        return;
    }
    else {
        switch (value->type()) {
        case simfil::ValueType::Undef:
            return;
        case simfil::ValueType::TransientObject: break;
        case simfil::ValueType::Null:
            return;
        case simfil::ValueType::Bool:
            fieldScope->value_ = JsValue(std::get<bool>(value->value()));
            fieldScope->type_ = ValueType::Boolean;
            return;
        case simfil::ValueType::Int:
            fieldScope->value_ = JsValue(std::get<int64_t>(value->value()));
            fieldScope->type_ = ValueType::Number;
            return;
        case simfil::ValueType::Float:
            fieldScope->value_ = JsValue(std::get<double>(value->value()));
            fieldScope->type_ = ValueType::Number;
            return;
        case simfil::ValueType::String: {
            auto vv = value->value();
            if (std::holds_alternative<std::string_view>(vv))
                fieldScope->value_ = convertString(std::get<std::string_view>(vv));
            else
                fieldScope->value_ = JsValue(std::get<std::string>(vv));
            fieldScope->type_ = ValueType::String;
            return;
        }
        case simfil::ValueType::Bytes:
            fieldScope->value_ = JsValue(byteArrayToDisplayString(std::get<simfil::ByteArray>(value->value())));
            fieldScope->type_ = ValueType::String;
            return;
        case simfil::ValueType::Object: break;
        case simfil::ValueType::Array:
            isArray = true;
            fieldScope->type_ = ValueType::ArrayBit;
            break;
        case simfil::ValueType::LAST_: break;
        }
    }

    auto const containerPath = fieldScope->geoJsonPath_;
    auto index = 0;
    for (auto const& [k, v] : value->fields()) {
        auto kk = isArray ? JsValue(index) : convertString(k);
        auto keyPath = kk.toString();
        if (isArray) {
            convertField(kk, static_cast<uint32_t>(index), v);
        }
        else {
            convertField(kk, std::string_view(keyPath), v);
        }
        ++index;
    }

    if (isArray) {
        fieldScope->geoJsonPath_ = directChildGeoJsonPath(containerPath);
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
    if (address_)
        newDict.set("address", *address_);
    if (addressScope_)
        newDict.set("addressScope", JsValue(true));
    if (!schemaType_.empty())
        newDict.set("schemaType", JsValue(schemaType_));
    if (!keyBubbles_.empty()) {
        auto bubbles = JsValue::List();
        for (auto const& bubble : keyBubbles_) {
            bubbles.push(JsValue::Dict({
                {"label", JsValue(bubble.label_)},
                {"kind", JsValue(bubble.kind_)}
            }));
        }
        newDict.set("keyBubbles", bubbles);
    }
    if (!valueBubbles_.empty()) {
        auto bubbles = JsValue::List();
        for (auto const& bubble : valueBubbles_) {
            bubbles.push(valueBubbleToJsValue(bubble));
        }
        newDict.set("valueBubbles", bubbles);
    }
    if (isArrayValue(type_) && (!children_.empty() || value_.type() == JsValue::Type::Null)) {
        newDict.set("valueCount", JsValue(std::to_string(children_.size())));
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
