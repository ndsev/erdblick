#include "layer.h"

#include "geo/point-conversion.h"
#include "geometry.h"
#include "mapget/log.h"
#include "mapget/model/feature.h"
#include "mapget/model/point.h"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <iostream>
#include <limits>
#include <sstream>
#include <string_view>
#include <unordered_map>
#include <variant>
#include <vector>

namespace
{

/** Recover the source descriptor ordinal from a stable relation identity. */
std::optional<uint32_t> relationIndexForSource(
    std::string_view relationId,
    std::string_view sourceFeatureId)
{
    auto const marker =
        std::string(":") +
        std::string(sourceFeatureId) +
        "#";
    auto const markerPosition =
        relationId.find(marker);
    if (markerPosition == std::string_view::npos) {
        return std::nullopt;
    }
    auto const begin =
        relationId.data() +
        markerPosition +
        marker.size();
    auto const end = relationId.data() +
        relationId.size();
    uint32_t ordinal = 0;
    auto const parsed =
        std::from_chars(begin, end, ordinal);
    if (parsed.ec != std::errc{} ||
        parsed.ptr == begin)
    {
        return std::nullopt;
    }
    return ordinal;
}

/** Render binary source-data blobs as readable integers when possible, hex otherwise. */
auto byteArrayToDisplayString(const simfil::ByteArray& value) -> std::string
{
    if (auto decoded = value.decodeBigEndianI64())
        return std::to_string(*decoded);
    return "0x" + value.toHex(false);
}

/** Convert nlohmann JSON into the small JS value helper used by embind-facing APIs. */
auto jsonToJsValue(nlohmann::json const& json) -> erdblick::JsValue
{
    using erdblick::JsValue;
    if (json.is_null()) {
        return JsValue();
    }
    if (json.is_boolean()) {
        return JsValue(json.get<bool>());
    }
    if (json.is_number_integer()) {
        return JsValue(static_cast<double>(json.get<int64_t>()));
    }
    if (json.is_number_unsigned()) {
        return JsValue(static_cast<double>(json.get<uint64_t>()));
    }
    if (json.is_number_float()) {
        return JsValue(json.get<double>());
    }
    if (json.is_string()) {
        return JsValue(json.get<std::string>());
    }
    if (json.is_array()) {
        auto result = JsValue::List();
        for (auto const& item : json) {
            result.push(jsonToJsValue(item));
        }
        return result;
    }
    if (json.is_object()) {
        auto result = JsValue::Dict();
        for (auto const& [key, value] : json.items()) {
            result.set(key, jsonToJsValue(value));
        }
        return result;
    }
    return JsValue();
}

/** Pick a representative WGS84 center for one copied subset geometry collection. */
auto subsetGeometryCenter(
    mapget::model_ptr<mapget::GeometryCollection> const& collection)
    -> std::optional<mapget::Point>
{
    if (!collection) {
        return std::nullopt;
    }
    std::optional<mapget::Point> result;
    collection->forEachGeometry(
        [&](mapget::model_ptr<mapget::Geometry> const& geometry) {
            if (!geometry) {
                return true;
            }
            switch (geometry->geomType()) {
            case mapget::GeomType::AABB: {
                auto const origin = geometry->aabbOrigin();
                auto const size = geometry->aabbSize();
                result = mapget::Point{
                    origin.x + size.x * 0.5,
                    origin.y + size.y * 0.5,
                    origin.z + size.z * 0.5};
                break;
            }
            case mapget::GeomType::GltfNodeIndex: {
                auto const origin = geometry->gltfNodeAabbOrigin();
                auto const size = geometry->gltfNodeAabbSize();
                result = mapget::Point{
                    origin.x + size.x * 0.5,
                    origin.y + size.y * 0.5,
                    origin.z + size.z * 0.5};
                break;
            }
            default: {
                auto selfContained = geometry->toSelfContained();
                if (!selfContained.points_.empty()) {
                    result = erdblick::geometryCenter(selfContained);
                }
                break;
            }
            }
            return !result.has_value();
        });
    return result;
}

/** Convert one projected scalar array into ordinary JavaScript values. */
auto projectedValues(mapget::model_ptr<mapget::Array> const& values)
    -> erdblick::JsValue
{
    auto result = erdblick::JsValue::List();
    if (!values) {
        return result;
    }
    for (uint32_t index = 0; index < values->size(); ++index) {
        auto value = values->at(index);
        result.push(
            value
                ? jsonToJsValue(value->toJson())
                : erdblick::JsValue());
    }
    return result;
}

/** Accumulate compact diagnostics for one projected value stream. */
struct ValueSummary
{
    uint64_t count = 0;
    uint64_t missing = 0;
    uint64_t nulls = 0;
    uint64_t booleans = 0;
    uint64_t integers = 0;
    uint64_t numbers = 0;
    uint64_t strings = 0;
    uint64_t objects = 0;
    uint64_t lists = 0;
    uint64_t blobs = 0;
    uint64_t unknown = 0;
    uint64_t numericCount = 0;
    uint64_t histogramDropped = 0;
    bool distinctLimitReached = false;
    double numericMin = std::numeric_limits<double>::infinity();
    double numericMax = -std::numeric_limits<double>::infinity();
    double numericSum = 0.0;
    std::unordered_map<std::string, uint64_t> histogram;
};

void addNumeric(ValueSummary& summary, double value)
{
    if (!std::isfinite(value)) {
        return;
    }
    ++summary.numericCount;
    summary.numericSum += value;
    summary.numericMin = std::min(summary.numericMin, value);
    summary.numericMax = std::max(summary.numericMax, value);
}

void addHistogram(
    ValueSummary& summary,
    std::string value,
    uint32_t distinctLimit)
{
    if (auto existing = summary.histogram.find(value);
        existing != summary.histogram.end())
    {
        ++existing->second;
        return;
    }
    if (summary.histogram.size() >= distinctLimit) {
        ++summary.histogramDropped;
        summary.distinctLimitReached = true;
        return;
    }
    summary.histogram.emplace(std::move(value), 1);
}

std::string numericHistogramValue(double value)
{
    if (std::isfinite(value) &&
        std::floor(value) == value &&
        value >= static_cast<double>(
            std::numeric_limits<int64_t>::min()) &&
        value <= static_cast<double>(
            std::numeric_limits<int64_t>::max()))
    {
        return std::to_string(static_cast<int64_t>(value));
    }
    auto stream = std::ostringstream();
    stream.precision(12);
    stream << value;
    return stream.str();
}

void summarizeNode(
    ValueSummary& summary,
    simfil::ModelNode::Ptr const& node,
    uint32_t distinctLimit)
{
    ++summary.count;
    if (!node) {
        ++summary.missing;
        return;
    }
    switch (node->type()) {
    case simfil::ValueType::Undef:
        ++summary.missing;
        break;
    case simfil::ValueType::Null:
        ++summary.nulls;
        break;
    case simfil::ValueType::Bool:
        ++summary.booleans;
        break;
    case simfil::ValueType::Int: {
        ++summary.integers;
        auto const value = std::get<int64_t>(node->value());
        addNumeric(summary, static_cast<double>(value));
        addHistogram(summary, std::to_string(value), distinctLimit);
        break;
    }
    case simfil::ValueType::Float: {
        ++summary.numbers;
        auto const value = std::get<double>(node->value());
        addNumeric(summary, value);
        addHistogram(
            summary,
            numericHistogramValue(value),
            distinctLimit);
        break;
    }
    case simfil::ValueType::String: {
        auto const value = node->value();
        auto text = std::string{};
        if (auto string = std::get_if<std::string>(&value)) {
            text = *string;
        }
        else if (
            auto string = std::get_if<std::string_view>(&value))
        {
            text = std::string(*string);
        }
        ++summary.strings;
        addHistogram(summary, std::move(text), distinctLimit);
        break;
    }
    case simfil::ValueType::Bytes:
        ++summary.blobs;
        break;
    case simfil::ValueType::TransientObject:
    case simfil::ValueType::Object:
        ++summary.objects;
        break;
    case simfil::ValueType::Array:
        ++summary.lists;
        break;
    default:
        ++summary.unknown;
        break;
    }
}

auto summaryToJsValue(
    ValueSummary const& summary,
    uint32_t histogramLimit) -> erdblick::JsValue
{
    using erdblick::JsValue;
    auto result = JsValue::Dict({
        {"count", JsValue(static_cast<double>(summary.count))},
        {"missing", JsValue(static_cast<double>(summary.missing))},
        {"nulls", JsValue(static_cast<double>(summary.nulls))},
        {"kinds", JsValue::Dict({
            {"integer", JsValue(static_cast<double>(summary.integers))},
            {"number", JsValue(static_cast<double>(summary.numbers))},
            {"boolean", JsValue(static_cast<double>(summary.booleans))},
            {"string", JsValue(static_cast<double>(summary.strings))},
            {"object", JsValue(static_cast<double>(summary.objects))},
            {"list", JsValue(static_cast<double>(summary.lists))},
            {"blob", JsValue(static_cast<double>(summary.blobs))},
            {"unknown", JsValue(static_cast<double>(summary.unknown))},
        })},
        {"otherCount",
         JsValue(static_cast<double>(summary.histogramDropped))},
        {"distinctLimitReached",
         JsValue(summary.distinctLimitReached)},
    });
    if (summary.numericCount > 0) {
        result.set("numeric", JsValue::Dict({
            {"count",
             JsValue(static_cast<double>(summary.numericCount))},
            {"min", JsValue(summary.numericMin)},
            {"max", JsValue(summary.numericMax)},
            {"sum", JsValue(summary.numericSum)},
            {"average",
             JsValue(
                 summary.numericSum /
                 static_cast<double>(summary.numericCount))},
        }));
    }

    std::vector<std::pair<std::string, uint64_t>> entries(
        summary.histogram.begin(),
        summary.histogram.end());
    std::sort(
        entries.begin(),
        entries.end(),
        [](auto const& left, auto const& right) {
            return left.second != right.second
                ? left.second > right.second
                : left.first < right.first;
        });
    auto histogram = JsValue::List();
    auto otherCount = summary.histogramDropped;
    for (size_t index = 0; index < entries.size(); ++index) {
        if (index >= histogramLimit) {
            otherCount += entries[index].second;
            continue;
        }
        histogram.push(JsValue::Dict({
            {"value", JsValue(entries[index].first)},
            {"count",
             JsValue(static_cast<double>(entries[index].second))},
        }));
    }
    result.set("histogram", histogram);
    result.set("otherCount", JsValue(static_cast<double>(otherCount)));
    return result;
}

}

namespace erdblick
{

/**
 * Constructor accepting a shared pointer to the original `TileFeatureLayer` class.
 * @param self Shared pointer to `mapget::TileFeatureLayer`.
 */
TileFeatureLayer::TileFeatureLayer(std::shared_ptr<mapget::TileFeatureLayer> self)
    : model_(std::move(self)) {}

/**
 * Retrieves the ID of the tile feature layer as a string.
 * @return The ID string.
 */
std::string TileFeatureLayer::id() const
{
    return model_->id().toString();
}

/** Retrieves the signed packed NDS.Live tile ID. */
int32_t TileFeatureLayer::tileId() const
{
    return model_->tileId().value();
}

/**
 * Gets the number of features in the tile.
 * @return The number of features.
 */
uint32_t TileFeatureLayer::numFeatures() const
{
    return model_->numRoots();
}

uint64_t TileFeatureLayer::numVertices() const
{
    return model_->numVertices();
}

/**
 * Retrieves the center point of the tile, including the zoom level as the Z coordinate.
 * @return The center point of the tile.
 */
mapget::Point TileFeatureLayer::center() const
{
    auto result = mapget::Point(model_->tileId().centerWgs84());
    result.z = model_->tileId().level();
    return result;
}

/**
 * Retrieves the legal information / copyright of the tile feature layer as a string.
 * @return The legal information string.
 */
std::string TileFeatureLayer::legalInfo() const
{
    return model_->legalInfo() ? *model_->legalInfo() : "";
}

/**
 * Finds a feature within the tile by its ID.
 * @param id The ID of the feature to find.
 * @return A pointer to the found feature, or `nullptr` if not found.
 */
mapget::model_ptr<mapget::Feature> TileFeatureLayer::find(const std::string& id) const
{
    return model_->find(id);
}

bool TileFeatureLayer::hasGlbAttachment() const
{
    return model_ && model_->glbAttachmentName().has_value();
}

std::string TileFeatureLayer::glbAttachmentName() const
{
    return model_ && model_->glbAttachmentName()
        ? *model_->glbAttachmentName()
        : std::string{};
}

/**
 * Finds the index of a feature based on its type and ID parts.
 * @param type The type of the feature.
 * @param idParts The parts of the feature's ID.
 * @return The index of the feature, or `-1` if not found.
 */
int32_t TileFeatureLayer::findFeatureIndex(std::string type, NativeJsValue idParts) const
{
    auto idPartsKvp = JsValue(idParts).toKeyValuePairs();
    if (auto result = model_->find(type, idPartsKvp))
        return result->addr().index();
    return -1;
}

std::string TileFeatureLayer::featureIdByAddress(uint32_t address) const
{
    if (address >= model_->numRoots()) {
        return {};
    }
    uint32_t currentIndex = 0;
    for (auto&& feature : *model_) {
        if (currentIndex++ != address) {
            continue;
        }
        if (auto featureId = feature->id()) {
            return featureId->toString();
        }
        return {};
    }
    return {};
}

mapget::model_ptr<mapget::Feature> TileFeatureLayer::featureByAddress(uint32_t address) const
{
    if (address >= model_->numRoots()) {
        return {};
    }
    uint32_t currentIndex = 0;
    for (auto&& feature : *model_) {
        if (currentIndex++ == address) {
            return feature;
        }
    }
    return {};
}

TileFeatureLayer::~TileFeatureLayer() = default;

/**
 * Constructor accepting a shared pointer to the original `TileSourceDataLayer` class.
 * @param self Shared pointer to `mapget::TileSourceDataLayer`.
 */
TileSourceDataLayer::TileSourceDataLayer(std::shared_ptr<mapget::TileSourceDataLayer> self)
    : model_(std::move(self)) {}

/**
 * Retrieves the source data address format of the layer.
 * @return The address format.
 */
mapget::TileSourceDataLayer::SourceDataAddressFormat TileSourceDataLayer::addressFormat() const
{
    return model_->sourceDataAddressFormat();
}

/**
 * Converts the layer's data to a JSON string with indentation.
 * @return The JSON representation of the layer.
 */
std::string TileSourceDataLayer::toJson() const
{
    return model_->toJson().dump(2);
}

/**
 * Converts the `SourceDataLayer` hierarchy to a tree model compatible structure.
 *
 * **Layout:**
 * ```json
 * [
 *   {
 *     "data": {"key": "...", "value": ...},
 *     "children": [{ ... }]
 *   },
 *   ...
 * ]
 * ```
 * @return A `NativeJsValue` representing the hierarchical data structure.
 */
NativeJsValue TileSourceDataLayer::toObject() const
{
    using namespace erdblick;
    using namespace mapget;
    using namespace simfil;

    const auto& strings = *model_->strings();

    std::function<JsValue(JsValue&&, const simfil::ModelNode&)> visit;

    // Function to handle atomic (non-complex) nodes
    auto visitAtomic = [&](JsValue&& key, const simfil::ModelNode& node) {
        auto value = [&node]() -> JsValue {
            switch (node.type()) {
            case simfil::ValueType::Null:
                return JsValue();
            case simfil::ValueType::Bool:
                return JsValue(std::get<bool>(node.value()));
            case simfil::ValueType::Int:
                return JsValue(std::get<int64_t>(node.value()));
            case simfil::ValueType::Float:
                return JsValue(std::get<double>(node.value()));
            case simfil::ValueType::String: {
                auto v = node.value();
                if (auto vv = std::get_if<std::string>(&v))
                    return JsValue(*vv);
                if (auto vv = std::get_if<std::string_view>(&v))
                    return JsValue(std::string(*vv));
                return JsValue();
            }
            case simfil::ValueType::Bytes: {
                auto v = node.value();
                if (auto vv = std::get_if<simfil::ByteArray>(&v))
                    return JsValue(byteArrayToDisplayString(*vv));
                return JsValue();
            }
            default:
                return JsValue();
            }
        }();

        auto res = JsValue::Dict();
        auto data = JsValue::Dict();
        data.set("key", std::move(key));
        data.set("value", std::move(value));
        res.set("data", std::move(data));

        return res;
    };

    // Function to handle array nodes
    auto visitArray = [&](JsValue&& key, const simfil::ModelNode& node) -> JsValue {
        auto res = JsValue::Dict();

        auto data = JsValue::Dict();
        data.set("key", std::move(key));
        res.set("data", std::move(data));

        auto children = JsValue::List();
        int i = 0;
        for (const auto& item : node) {
            children.call<void>("push", visit(JsValue(i++), *item));
        }

        if (i > 0)
            res.set("children", std::move(children));

        return res;
    };

    // Function to handle source data addresses
    auto visitAddress = [&](const SourceDataAddress& addr) {
        if (model_->sourceDataAddressFormat() == mapget::TileSourceDataLayer::SourceDataAddressFormat::BitRange) {
            auto res = JsValue::Dict();
            res.set("offset", JsValue(addr.bitOffset()));
            res.set("size", JsValue(addr.bitSize()));
            return res;
        } else {
            return JsValue(addr.u64());
        }
    };

    // Function to handle object nodes
    auto visitObject = [&](JsValue&& key, const simfil::ModelNode& node) -> JsValue {
        auto res = JsValue::Dict();

        auto data = JsValue::Dict();
        data.set("key", std::move(key));

        if (node.addr().column() == mapget::TileSourceDataLayer::Compound) {
            auto compound = model_->resolve<SourceDataCompoundNode>(node);
            data.set("address", visitAddress(compound->sourceDataAddress()));
            if (compound->isSourceDataAddressScope()) {
                data.set("addressScope", JsValue(true));
            }
            data.set("type", JsValue(std::string(compound->schemaName())));
        }

        res.set("data", std::move(data));

        auto children = JsValue::List();
        for (const auto& [field, v] : node.fields()) {
            if (auto k = strings.resolve(field); k && v) {
                children.call<void>("push", visit(JsValue(k->data()), *v));
            }
        }

        if (node.size() > 0)
            res.set("children", std::move(children));

        return res;
    };

    // Main recursive visit function
    visit = [&](JsValue&& key, const simfil::ModelNode& node) -> JsValue {
        switch (node.type()) {
        case simfil::ValueType::Array:
            return visitArray(std::move(key), node);
        case simfil::ValueType::Object:
            return visitObject(std::move(key), node);
        default:
            return visitAtomic(std::move(key), node);
        }
    };

    if (model_->numRoots() == 0)
        return *JsValue::Dict();

    auto root = model_->root(0);
    if (!root)
        raise(root.error().message);

    return *visit(JsValue("root"), **root);
}

std::string TileSourceDataLayer::getError() const
{
    return model_->error() ? *model_->error() : "";
}

TileSubsetLayer::TileSubsetLayer(std::shared_ptr<mapget::TileSubsetLayer> self)
    : model_(std::move(self)) {}

std::string TileSubsetLayer::id() const
{
    return model_->id().toString();
}

std::string TileSubsetLayer::stringPoolId() const
{
    return model_->stringPoolId();
}

std::string TileSubsetLayer::mapId() const
{
    return model_->mapId();
}

std::string TileSubsetLayer::layerId() const
{
    return model_->layerInfo() ? model_->layerInfo()->layerId_ : "";
}

int32_t TileSubsetLayer::tileId() const
{
    return model_->tileId().value();
}

std::string TileSubsetLayer::filterId() const
{
    return model_->filterId();
}

uint64_t TileSubsetLayer::generation() const
{
    return model_->generation();
}

uint32_t TileSubsetLayer::numChannels() const
{
    return static_cast<uint32_t>(model_->size());
}

uint32_t TileSubsetLayer::numEntries() const
{
    uint64_t count = 0;
    model_->forEachChannel([&](mapget::model_ptr<mapget::TileSubsetChannel> const& channel) {
        count += channel->entryCount();
        return count <= std::numeric_limits<uint32_t>::max();
    });
    return static_cast<uint32_t>(
        std::min<uint64_t>(count, std::numeric_limits<uint32_t>::max()));
}

NativeJsValue TileSubsetLayer::info() const
{
    return *jsonToJsValue(model_->info());
}

NativeJsValue TileSubsetLayer::dependencies() const
{
    auto result = JsValue::List();
    for (auto const& dependency : model_->dependencies()) {
        result.push(JsValue::Dict({
            {"sourceTileKey", JsValue(dependency.sourceTileKey_.toString())},
            {"mapId", JsValue(dependency.sourceTileKey_.mapId_)},
            {"layerId", JsValue(dependency.sourceTileKey_.layerId_)},
            {"tileId", JsValue(dependency.sourceTileKey_.tileId_.value())},
            {"sourceFeatureCount", JsValue(dependency.sourceFeatureCount_)},
        }));
    }
    return *result;
}

NativeJsValue TileSubsetLayer::issues() const
{
    auto result = JsValue::List();
    for (auto const& issue : model_->issues()) {
        nlohmann::json scope = issue.scope_;
        result.push(JsValue::Dict({
            {"channelId", JsValue(issue.channelId_)},
            {"expression", JsValue(issue.expression_)},
            {"scope", JsValue(scope.get<std::string>())},
            {"message", JsValue(issue.message_)},
            {"occurrenceCount", JsValue(static_cast<double>(issue.occurrenceCount_))},
        }));
    }
    return *result;
}

std::string TileSubsetLayer::glbAttachmentName() const
{
    return model_->glbAttachmentName().value_or(std::string{});
}

NativeJsValue TileSubsetLayer::channelSchema(
    uint32_t channelOrdinal) const
{
    auto channel = model_->at(channelOrdinal);
    if (!channel) {
        return *JsValue::Undefined();
    }
    auto featureFields = JsValue::List();
    for (auto const& field : channel->featureFields()) {
        featureFields.push(JsValue(field));
    }
    auto entryFields = JsValue::List();
    for (auto const& field : channel->entryFields()) {
        entryFields.push(JsValue(field));
    }
    nlohmann::json scope = channel->scope();
    return *JsValue::Dict({
        {"channelId", JsValue(channel->channelId())},
        {"scope", JsValue(scope.get<std::string>())},
        {"featureFields", featureFields},
        {"entryFields", entryFields},
        {"entryCount",
         JsValue(static_cast<double>(channel->entryCount()))},
    });
}

NativeJsValue TileSubsetLayer::entryRange(
    uint32_t channelOrdinal,
    uint32_t offset,
    uint32_t limit,
    bool includePosition) const
{
    auto channel = model_->at(channelOrdinal);
    if (!channel) {
        return *JsValue::List();
    }
    auto const count = channel->entryCount();
    auto const begin = std::min<size_t>(offset, count);
    auto const end = limit == 0
        ? count
        : std::min<size_t>(
              count,
              begin + static_cast<size_t>(limit));
    auto entries = JsValue::List();
    auto append = [&](
                      size_t index,
                      mapget::model_ptr<mapget::FeatureId> const& featureId,
                      mapget::model_ptr<mapget::GeometryCollection> const& geometry,
                      mapget::model_ptr<mapget::Array> const& values,
                      std::optional<uint32_t> attributeIndex = std::nullopt,
                      std::optional<bool> hasValidity = std::nullopt,
                      uint32_t validityIndex = 0,
                      uint32_t validityCount = 1) {
        if (index < begin || index >= end || !featureId) {
            return;
        }
        auto entry = JsValue::Dict({
            {"mapTileKey", JsValue(model_->id().toString())},
            {"featureId", JsValue(featureId->toString())},
            {"resultIndex", JsValue(static_cast<double>(index))},
            {"values", projectedValues(values)},
        });
        if (includePosition) {
            if (auto center = subsetGeometryCenter(geometry)) {
                auto const cartesian =
                    wgsToCartesian<mapget::Point>(*center);
                entry.set("position", JsValue::Dict({
                    {"cartesian", JsValue(cartesian)},
                    {"cartographic", JsValue(*center)},
                }));
            }
        }
        if (attributeIndex) {
            entry.set("attributeIndex", JsValue(*attributeIndex));
        }
        if (hasValidity) {
            entry.set("hasValidity", JsValue(*hasValidity));
            entry.set("validityIndex", JsValue(validityIndex));
            entry.set("validityCount", JsValue(validityCount));
        }
        entries.push(entry);
    };

    size_t index = 0;
    switch (channel->scope()) {
    case mapget::Scope::Feature:
        channel->forEachFeatureEntry(
            [&](mapget::model_ptr<mapget::FeatureEntry> const& entry) {
                append(
                    index++,
                    entry->featureId(),
                    entry->geometry(),
                    entry->values());
                return index < end;
            });
        break;
    case mapget::Scope::Attribute:
        channel->forEachAttributeValidityEntry(
            [&](mapget::model_ptr<mapget::AttributeValidityEntry> const& entry) {
                auto const current = index++;
                if (current < begin || current >= end) {
                    return index < end;
                }
                append(
                    current,
                    entry->featureId(),
                    entry->geometry(),
                    entry->values(),
                    entry->attributeIndex(),
                    entry->hasValidity(),
                    entry->validityIndex(),
                    entry->validityCount());
                return index < end;
            });
        break;
    case mapget::Scope::Relation:
        channel->forEachRelationEntry(
            [&](mapget::model_ptr<mapget::RelationEntry> const& entry) {
                auto source = entry->source();
                append(
                    index++,
                    source
                        ? source->featureId()
                        : mapget::model_ptr<mapget::FeatureId>{},
                    entry->sourceGeometry(),
                    entry->values());
                return index < end;
            });
        break;
    case mapget::Scope::Group:
        channel->forEachGroupEntry(
            [&](mapget::model_ptr<mapget::GroupEntry> const& entry) {
                append(
                    index++,
                    entry->representativeFeatureId(),
                    entry->geometry(),
                    entry->values());
                return index < end;
            });
        break;
    }
    return *entries;
}

NativeJsValue TileSubsetLayer::valueSummaries(
    uint32_t channelOrdinal,
    uint32_t histogramLimit,
    uint32_t distinctLimit) const
{
    auto channel = model_->at(channelOrdinal);
    if (!channel) {
        return *JsValue::Undefined();
    }
    histogramLimit = std::clamp<uint32_t>(
        histogramLimit == 0 ? 16U : histogramLimit,
        1U,
        256U);
    distinctLimit = std::clamp<uint32_t>(
        distinctLimit == 0 ? 512U : distinctLimit,
        1U,
        8192U);
    auto const fields =
        channel->scope() == mapget::Scope::Feature
            ? channel->featureFields()
            : channel->entryFields();
    auto summaries = std::vector<ValueSummary>(fields.size());
    auto summarize = [&](mapget::model_ptr<mapget::Array> const& values) {
        for (size_t field = 0; field < fields.size(); ++field) {
            summarizeNode(
                summaries[field],
                values && field < values->size()
                    ? values->at(static_cast<int64_t>(field))
                    : simfil::ModelNode::Ptr{},
                distinctLimit);
        }
    };
    switch (channel->scope()) {
    case mapget::Scope::Feature:
        channel->forEachFeatureEntry([&](auto const& entry) {
            summarize(entry->values());
            return true;
        });
        break;
    case mapget::Scope::Attribute:
        channel->forEachAttributeValidityEntry([&](auto const& entry) {
            summarize(entry->values());
            return true;
        });
        break;
    case mapget::Scope::Relation:
        channel->forEachRelationEntry([&](auto const& entry) {
            summarize(entry->values());
            return true;
        });
        break;
    case mapget::Scope::Group:
        channel->forEachGroupEntry([&](auto const& entry) {
            summarize(entry->values());
            return true;
        });
        break;
    }

    auto resultFields = JsValue::List();
    for (size_t index = 0; index < fields.size(); ++index) {
        resultFields.push(JsValue::Dict({
            {"source", JsValue("resultField")},
            {"index", JsValue(static_cast<double>(index))},
            {"expression", JsValue(fields[index])},
            {"summary",
             summaryToJsValue(summaries[index], histogramLimit)},
        }));
    }
    auto traces = JsValue::List();
    for (size_t traceIndex = 0;
         traceIndex < model_->traceCount();
         ++traceIndex)
    {
        auto trace = model_->traceAt(traceIndex);
        if (!trace) {
            continue;
        }
        auto summary = ValueSummary{};
        if (auto values = trace->values()) {
            for (uint32_t index = 0; index < values->size(); ++index) {
                summarizeNode(
                    summary,
                    values->at(index),
                    distinctLimit);
            }
        }
        traces.push(JsValue::Dict({
            {"source", JsValue("trace")},
            {"name", JsValue(trace->name())},
            {"calls", JsValue(static_cast<double>(trace->calls()))},
            {"totalus",
             JsValue(
                 static_cast<double>(
                     trace->totalUs().count()))},
            {"summary",
             summaryToJsValue(summary, histogramLimit)},
        }));
    }
    return *JsValue::Dict({
        {"resultFields", resultFields},
        {"traces", traces},
    });
}

NativeJsValue TileSubsetLayer::resolvePick(
    uint32_t channelOrdinal,
    uint32_t entryOrdinal,
    uint32_t endpointRole) const
{
    auto channel = model_->at(channelOrdinal);
    if (!channel) {
        return *JsValue::Undefined();
    }

    auto result = JsValue::Dict({
        {"channelOrdinal", JsValue(channelOrdinal)},
        {"entryOrdinal", JsValue(entryOrdinal)},
        {"endpointRole", JsValue(endpointRole)},
        {"channelId", JsValue(channel->channelId())},
    });
    auto setFeatureId = [&](mapget::model_ptr<mapget::FeatureId> const& id) {
        if (id) {
            result.set("featureId", JsValue(id->toString()));
            result.set("featureType", JsValue(std::string(id->typeId())));
        }
    };

    switch (channel->scope()) {
    case mapget::Scope::Feature: {
        uint32_t current = 0;
        channel->forEachFeatureEntry([&](mapget::model_ptr<mapget::FeatureEntry> const& entry) {
            if (current++ != entryOrdinal) {
                return true;
            }
            setFeatureId(entry->featureId());
            return false;
        });
        break;
    }
    case mapget::Scope::Attribute: {
        uint32_t current = 0;
        channel->forEachAttributeValidityEntry(
            [&](mapget::model_ptr<mapget::AttributeValidityEntry> const& entry) {
                if (current++ != entryOrdinal) {
                    return true;
                }
                setFeatureId(entry->featureId());
                if (auto index = entry->attributeIndex()) {
                    result.set("attributeIndex", JsValue(*index));
                }
                result.set("hasValidity", JsValue(entry->hasValidity()));
                result.set("validityIndex", JsValue(entry->validityIndex()));
                result.set("validityCount", JsValue(entry->validityCount()));
                return false;
            });
        break;
    }
    case mapget::Scope::Relation: {
        uint32_t current = 0;
        channel->forEachRelationEntry([&](mapget::model_ptr<mapget::RelationEntry> const& entry) {
            if (current++ != entryOrdinal) {
                return true;
            }
            auto endpoint = endpointRole == 2 ? entry->target() : entry->source();
            setFeatureId(endpoint ? endpoint->featureId() : mapget::model_ptr<mapget::FeatureId>{});
            if (auto source = entry->source(); source && source->featureId()) {
                auto const sourceFeatureId =
                    source->featureId()->toString();
                result.set(
                    "relationSourceFeatureId",
                    JsValue(sourceFeatureId));
                if (auto relationIndex =
                        relationIndexForSource(
                            entry->relationId(),
                            sourceFeatureId))
                {
                    result.set(
                        "relationIndex",
                        JsValue(*relationIndex));
                }
            }
            result.set("relationId", JsValue(entry->relationId()));
            result.set("relationName", JsValue(entry->name()));
            result.set("twoway", JsValue(entry->twoway()));
            return false;
        });
        break;
    }
    case mapget::Scope::Group: {
        uint32_t current = 0;
        channel->forEachGroupEntry([&](mapget::model_ptr<mapget::GroupEntry> const& entry) {
            if (current++ != entryOrdinal) {
                return true;
            }
            setFeatureId(entry->representativeFeatureId());
            auto members = JsValue::List();
            if (auto memberIds = entry->memberFeatureIds()) {
                for (uint32_t index = 0; index < memberIds->size(); ++index) {
                    auto node = memberIds->at(index);
                    auto member = node
                        ? model_->resolve<mapget::FeatureId>(*node)
                        : mapget::model_ptr<mapget::FeatureId>{};
                    if (member) {
                        members.push(JsValue(member->toString()));
                    }
                }
            }
            result.set("memberFeatureIds", members);
            return false;
        });
        break;
    }
    }
    return *result;
}

std::string TileSubsetLayer::toJson() const
{
    return model_->toJson().dump(2);
}

bool TileSubsetLayer::copyDiagnostics(SharedUint8Array& output) const
{
    std::stringstream stream;
    auto written = model_->diagnostics().write(stream);
    if (!written) {
        return false;
    }
    output.writeToArray(stream.str());
    return true;
}

TileSubsetLayer::~TileSubsetLayer() = default;

} // namespace erdblick
