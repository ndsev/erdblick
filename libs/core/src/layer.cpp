#include "layer.h"

#include "geo/point-conversion.h"
#include "geometry.h"
#include "mapget/log.h"
#include "mapget/model/feature.h"
#include <algorithm>
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

/** Returns the last GLB attachment found along the staged overlay chain, if any. */
auto findGlbAttachment(std::shared_ptr<mapget::TileFeatureLayer> const& layer) -> mapget::TileGlbAttachment const*
{
    auto const* attachment = static_cast<mapget::TileGlbAttachment const*>(nullptr);
    auto current = layer;
    while (current) {
        if (auto const* candidate = current->glbAttachment()) {
            attachment = candidate;
        }
        current = current->overlay();
    }
    return attachment;
}

/** Pick a representative WGS84 center for copied search-result geometry. */
auto searchResultGeometryCenter(mapget::model_ptr<mapget::SearchResult> const& result) -> mapget::Point
{
    if (!result) {
        return {};
    }
    auto geometryCollection = result->geometry();
    if (!geometryCollection) {
        return {};
    }

    mapget::model_ptr<mapget::Geometry> geometry;
    geometryCollection->forEachGeometryAtPreferredStage(
        std::nullopt,
        [&geometry](auto&& candidate)
        {
            geometry = candidate;
            return false;
        });
    if (!geometry) {
        geometryCollection->forEachGeometry(
            [&geometry](auto&& candidate)
            {
                geometry = candidate;
                return false;
            });
    }
    if (!geometry) {
        return {};
    }

    switch (geometry->geomType()) {
    case mapget::GeomType::AABB: {
        auto const origin = geometry->aabbOrigin();
        auto const size = geometry->aabbSize();
        return {origin.x + size.x * 0.5, origin.y + size.y * 0.5, origin.z + size.z * 0.5};
    }
    case mapget::GeomType::GltfNodeIndex: {
        auto const origin = geometry->gltfNodeAabbOrigin();
        auto const size = geometry->gltfNodeAabbSize();
        return {origin.x + size.x * 0.5, origin.y + size.y * 0.5, origin.z + size.z * 0.5};
    }
    default:
        return erdblick::geometryCenter(geometry->toSelfContained());
    }
}

/** Accumulate compact diagnostics for one value stream. */
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

/** Extract string-like SIMFIL scalar values without forcing JSON conversion. */
auto nodeStringValue(simfil::ModelNode const& node) -> std::string
{
    auto const value = node.value();
    if (auto const* str = std::get_if<std::string>(&value)) {
        return *str;
    }
    if (auto const* strView = std::get_if<std::string_view>(&value)) {
        return std::string(*strView);
    }
    return {};
}

/** Add one finite numeric scalar to the min/max/average accumulator. */
void addNumeric(ValueSummary& summary, double value)
{
    if (!std::isfinite(value)) {
        return;
    }
    summary.numericCount++;
    summary.numericSum += value;
    summary.numericMin = std::min(summary.numericMin, value);
    summary.numericMax = std::max(summary.numericMax, value);
}

/** Track string histograms with a hard distinct-value cap. */
void addHistogram(ValueSummary& summary, std::string value, uint32_t distinctLimit)
{
    if (distinctLimit == 0) {
        summary.histogramDropped++;
        summary.distinctLimitReached = true;
        return;
    }

    if (auto existing = summary.histogram.find(value); existing != summary.histogram.end()) {
        existing->second++;
        return;
    }

    if (summary.histogram.size() >= distinctLimit) {
        summary.histogramDropped++;
        summary.distinctLimitReached = true;
        return;
    }
    summary.histogram.emplace(std::move(value), 1);
}

/** Accumulate one model node sample into a value summary. */
void summarizeNode(ValueSummary& summary, simfil::ModelNode::Ptr const& node, uint32_t distinctLimit)
{
    summary.count++;
    if (!node) {
        summary.missing++;
        return;
    }

    switch (node->type()) {
    case simfil::ValueType::Undef:
        summary.missing++;
        break;
    case simfil::ValueType::Null:
        summary.nulls++;
        break;
    case simfil::ValueType::Bool:
        summary.booleans++;
        break;
    case simfil::ValueType::Int:
        summary.integers++;
        addNumeric(summary, static_cast<double>(std::get<int64_t>(node->value())));
        break;
    case simfil::ValueType::Float:
        summary.numbers++;
        addNumeric(summary, std::get<double>(node->value()));
        break;
    case simfil::ValueType::String: {
        auto value = nodeStringValue(*node);
        if (value == "object") {
            summary.objects++;
        }
        else if (value == "list") {
            summary.lists++;
        }
        else if (value == "blob") {
            summary.blobs++;
        }
        else {
            summary.strings++;
            addHistogram(summary, std::move(value), distinctLimit);
        }
        break;
    }
    case simfil::ValueType::Bytes:
        summary.blobs++;
        break;
    case simfil::ValueType::TransientObject:
    case simfil::ValueType::Object:
        summary.objects++;
        break;
    case simfil::ValueType::Array:
        summary.lists++;
        break;
    default:
        summary.unknown++;
        break;
    }
}

/** Convert one summary to the JS diagnostics object used by the search panel. */
auto summaryToJsValue(ValueSummary const& summary, uint32_t histogramLimit) -> erdblick::JsValue
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
        {"otherCount", JsValue(static_cast<double>(summary.histogramDropped))},
        {"distinctLimitReached", JsValue(summary.distinctLimitReached)},
    });

    if (summary.numericCount > 0) {
        result.set("numeric", JsValue::Dict({
            {"count", JsValue(static_cast<double>(summary.numericCount))},
            {"min", JsValue(summary.numericMin)},
            {"max", JsValue(summary.numericMax)},
            {"sum", JsValue(summary.numericSum)},
            {"average", JsValue(summary.numericSum / static_cast<double>(summary.numericCount))},
        }));
    }

    std::vector<std::pair<std::string, uint64_t>> histogramEntries;
    histogramEntries.reserve(summary.histogram.size());
    for (auto const& entry : summary.histogram) {
        histogramEntries.emplace_back(entry);
    }
    std::sort(
        histogramEntries.begin(),
        histogramEntries.end(),
        [](auto const& left, auto const& right)
        {
            if (left.second != right.second) {
                return left.second > right.second;
            }
            return left.first < right.first;
        });

    auto histogram = JsValue::List();
    uint64_t otherCount = summary.histogramDropped;
    for (size_t index = 0; index < histogramEntries.size(); ++index) {
        auto const& [value, count] = histogramEntries[index];
        if (index >= histogramLimit) {
            otherCount += count;
            continue;
        }
        histogram.push(JsValue::Dict({
            {"value", JsValue(value)},
            {"count", JsValue(static_cast<double>(count))},
        }));
    }
    result.set("histogram", histogram);
    result.set("otherCount", JsValue(static_cast<double>(otherCount)));
    return result;
}

/** Keep histogram parameters bounded before native summary work starts. */
auto normalizedSummaryLimits(uint32_t histogramLimit, uint32_t distinctLimit) -> std::pair<uint32_t, uint32_t>
{
    auto const normalizedHistogramLimit = std::clamp<uint32_t>(
        histogramLimit == 0 ? 16U : histogramLimit,
        1U,
        256U);
    auto const normalizedDistinctLimit = std::clamp<uint32_t>(
        distinctLimit == 0 ? 512U : distinctLimit,
        1U,
        8192U);
    return {normalizedHistogramLimit, normalizedDistinctLimit};
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

/**
 * Retrieves the tile ID as a 64-bit unsigned integer.
 * @return The tile ID.
 */
uint64_t TileFeatureLayer::tileId() const
{
    return model_->tileId().value_;
}

uint32_t TileFeatureLayer::stage() const
{
    return model_->stage().value_or(0U);
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
    auto result = model_->tileId().center();
    result.z = model_->tileId().z();
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

void TileFeatureLayer::attachOverlay(TileFeatureLayer const& overlay)
{
    if (!model_ || !overlay.model_) {
        return;
    }
    model_->attachOverlay(overlay.model_);
}

bool TileFeatureLayer::hasGlbAttachment() const
{
    return findGlbAttachment(model_) != nullptr;
}

std::string TileFeatureLayer::glbAttachmentName() const
{
    if (auto const* attachment = findGlbAttachment(model_)) {
        return attachment->name_;
    }
    return {};
}

bool TileFeatureLayer::copyGlbAttachment(SharedUint8Array& output) const
{
    auto const* attachment = findGlbAttachment(model_);
    if (!attachment) {
        return false;
    }
    output.writeToArray(
        reinterpret_cast<char const*>(attachment->bytes_.data()),
        reinterpret_cast<char const*>(attachment->bytes_.data() + attachment->bytes_.size()));
    return true;
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

TileSearchResultLayer::TileSearchResultLayer(std::shared_ptr<mapget::TileSearchResultLayer> self)
    : model_(std::move(self)) {}

std::string TileSearchResultLayer::id() const
{
    return model_->id().toString();
}

std::string TileSearchResultLayer::nodeId() const
{
    return model_->nodeId();
}

std::string TileSearchResultLayer::mapId() const
{
    return model_->mapId();
}

std::string TileSearchResultLayer::layerId() const
{
    return model_->layerInfo() ? model_->layerInfo()->layerId_ : "";
}

uint64_t TileSearchResultLayer::tileId() const
{
    return model_->tileId().value_;
}

uint32_t TileSearchResultLayer::stage() const
{
    return model_->stage().value_or(0U);
}

uint32_t TileSearchResultLayer::numResults() const
{
    return static_cast<uint32_t>(model_->size());
}

NativeJsValue TileSearchResultLayer::resultFields() const
{
    auto result = JsValue::List();
    for (auto const& field : model_->resultFields()) {
        result.push(JsValue(field));
    }
    return *result;
}

NativeJsValue TileSearchResultLayer::info() const
{
    return *jsonToJsValue(model_->info());
}

NativeJsValue TileSearchResultLayer::resultEntries() const
{
    auto entries = JsValue::List();
    auto const layerInfo = model_->info();
    auto const sourceMapId = layerInfo.value("sourceMapId", model_->mapId());
    auto const sourceLayerId = layerInfo.value(
        "sourceLayerId",
        model_->layerInfo() ? model_->layerInfo()->layerId_ : std::string{});
    auto const sourceTileId = layerInfo.value("sourceTileId", model_->tileId().value_);
    auto const sourceTileKey = mapget::MapTileKey(
        mapget::LayerType::Features,
        sourceMapId,
        sourceLayerId,
        mapget::TileId(sourceTileId)).toString();

    for (size_t index = 0; index < model_->size(); ++index) {
        auto result = model_->at(index);
        if (!result) {
            continue;
        }

        auto const center = searchResultGeometryCenter(result);
        auto const cartesian = wgsToCartesian<mapget::Point>(center);
        auto entry = JsValue::Dict({
            {"mapTileKey", JsValue(sourceTileKey)},
            {"featureId", JsValue(result->featureId() ? result->featureId()->toString() : std::string{})},
            {"resultIndex", JsValue(static_cast<double>(index))},
            {"position", JsValue::Dict({
                {"cartesian", JsValue(cartesian)},
                {"cartographic", JsValue(center)}
            })},
            {"values", jsonToJsValue(result->toJson().value("values", nlohmann::json::array()))},
        });
        if (auto attributeIndex = result->attributeIndex()) {
            entry.set("attributeIndex", JsValue(static_cast<double>(*attributeIndex)));
        }
        if (auto validityIndex = result->validityIndex()) {
            entry.set("validityIndex", JsValue(static_cast<double>(*validityIndex)));
        }
        if (auto validityCount = result->validityCount()) {
            entry.set("validityCount", JsValue(static_cast<double>(*validityCount)));
        }
        entries.push(entry);
    }

    return *entries;
}

NativeJsValue TileSearchResultLayer::valueSummaries(uint32_t histogramLimit, uint32_t distinctLimit) const
{
    auto const [normalizedHistogramLimit, normalizedDistinctLimit] = normalizedSummaryLimits(
        histogramLimit,
        distinctLimit);

    auto resultFields = JsValue::List();
    auto const& fields = model_->resultFields();
    auto fieldSummaries = std::vector<ValueSummary>(fields.size());
    for (size_t resultIndex = 0; resultIndex < model_->size(); ++resultIndex) {
        auto searchResult = model_->at(resultIndex);
        auto values = searchResult ? searchResult->values() : mapget::model_ptr<simfil::Array>{};
        for (size_t fieldIndex = 0; fieldIndex < fields.size(); ++fieldIndex) {
            if (!values || fieldIndex >= values->size()) {
                summarizeNode(fieldSummaries[fieldIndex], {}, normalizedDistinctLimit);
                continue;
            }
            summarizeNode(
                fieldSummaries[fieldIndex],
                values->at(static_cast<int64_t>(fieldIndex)),
                normalizedDistinctLimit);
        }
    }

    for (size_t fieldIndex = 0; fieldIndex < fields.size(); ++fieldIndex) {
        resultFields.push(JsValue::Dict({
            {"source", JsValue("resultField")},
            {"index", JsValue(static_cast<double>(fieldIndex))},
            {"expression", JsValue(fields[fieldIndex])},
            {"summary", summaryToJsValue(fieldSummaries[fieldIndex], normalizedHistogramLimit)},
        }));
    }

    auto traces = JsValue::List();
    for (size_t traceIndex = 0; traceIndex < model_->traceCount(); ++traceIndex) {
        auto trace = model_->traceAt(traceIndex);
        if (!trace) {
            continue;
        }

        auto summary = ValueSummary{};
        if (auto values = trace->values()) {
            for (uint32_t valueIndex = 0; valueIndex < values->size(); ++valueIndex) {
                summarizeNode(summary, values->at(valueIndex), normalizedDistinctLimit);
            }
        }

        traces.push(JsValue::Dict({
            {"source", JsValue("trace")},
            {"name", JsValue(trace->name())},
            {"calls", JsValue(static_cast<double>(trace->calls()))},
            {"totalus", JsValue(static_cast<double>(trace->totalUs().count()))},
            {"summary", summaryToJsValue(summary, normalizedHistogramLimit)},
        }));
    }

    return *JsValue::Dict({
        {"resultFields", resultFields},
        {"traces", traces},
    });
}

std::string TileSearchResultLayer::toJson() const
{
    return model_->toJson().dump(2);
}

bool TileSearchResultLayer::copyDiagnostics(SharedUint8Array& output) const
{
    std::stringstream stream;
    auto written = model_->diagnostics().write(stream);
    if (!written) {
        return false;
    }
    output.writeToArray(stream.str());
    return true;
}

TileSearchResultLayer::~TileSearchResultLayer() = default;

} // namespace erdblick
