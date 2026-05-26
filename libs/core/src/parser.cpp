#include <algorithm>
#include <cctype>
#include <iostream>
#include <map>
#include <regex>
#include <set>
#include <span>
#include <sstream>
#include <unordered_set>
#include "mapget/model/stringpool.h"
#include "mapget/model/schemaregistry.h"
#include "mapget/model/simfilutil.h"
#include "simfil/model/model.h"
#include "simfil/simfil.h"
#include "parser.h"

using namespace mapget;

namespace erdblick
{

namespace {

constexpr int kSchemaCompletionDepth = 6;

std::string completionTypeToString(simfil::CompletionCandidate::Type type)
{
    switch (type) {
    case simfil::CompletionCandidate::Type::CONSTANT:
        return "Constant";
    case simfil::CompletionCandidate::Type::FIELD:
        return "Field";
    case simfil::CompletionCandidate::Type::FUNCTION:
        return "Function";
    case simfil::CompletionCandidate::Type::HINT:
        return "Hint";
    }
    return "";
}

simfil::ModelNode::Ptr makeSchemaCompletionNode(
    std::shared_ptr<simfil::ModelPool> const& model,
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
    simfil::SchemaId schemaId,
    int depth)
{
    if (!registry || schemaId == simfil::NoSchemaId) {
        return model->newValue(std::string_view{});
    }

    switch (registry->kind(schemaId)) {
    case simfil::Schema::Kind::Object: {
        auto object = model->newObject();
        (void)object->setSchema(schemaId);
        if (depth > 0) {
            for (auto const& fieldName : registry->directFields(schemaId)) {
                auto childSchema = registry->childSchema(schemaId, fieldName);
                auto child = makeSchemaCompletionNode(model, registry, childSchema, depth - 1);
                (void)object->addField(fieldName, child);
            }
        }
        return object;
    }
    case simfil::Schema::Kind::Array: {
        auto array = model->newArray();
        (void)array->setSchema(schemaId);
        return array;
    }
    case simfil::Schema::Kind::Value:
        return model->newValue(std::string_view{});
    }

    return model->newValue(std::string_view{});
}

void addAttributeOverlayFields(
    simfil::model_ptr<simfil::Object>& attributeRoot,
    std::shared_ptr<simfil::ModelPool> const& model,
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
    std::string const& featureType)
{
    (void)attributeRoot->addField("$name", std::string_view{});
    (void)attributeRoot->addField("$layer", std::string_view{});
    (void)attributeRoot->addField("$validityIndex", int64_t{0});
    (void)attributeRoot->addField("$validityCount", int64_t{1});

    auto featureSchema = registry ? registry->featureSchema(featureType) : simfil::NoSchemaId;
    if (featureSchema != simfil::NoSchemaId) {
        auto featureRoot = makeSchemaCompletionNode(model, registry, featureSchema, kSchemaCompletionDepth);
        (void)attributeRoot->addField("$feature", featureRoot);
    }
}

void addCompletionCandidates(
    std::set<simfil::CompletionCandidate>& merged,
    std::shared_ptr<mapget::SchemaRegistry const> const& registry,
    std::shared_ptr<simfil::StringPool> const& strings,
    std::string const& query,
    int point,
    simfil::ModelNode const& root,
    simfil::CompletionOptions const& options)
{
    auto env = mapget::makeEnvironment(strings);
    mapget::installCompletionSchemaRegistry(*env, registry, strings);

    auto result = simfil::complete(*env, query, point, root, options);
    if (!result) {
        return;
    }
    merged.insert(result->begin(), result->end());
}

NativeJsValue completionCandidatesToJs(
    std::string const& query,
    std::set<simfil::CompletionCandidate> const& candidates,
    size_t limit)
{
    auto result = JsValue::List();
    size_t count = 0;
    for (auto const& item : candidates) {
        if (limit && count >= limit) {
            break;
        }
        auto insertText = item.text;
        if (item.type == simfil::CompletionCandidate::Type::FUNCTION) {
            insertText += "(";
        }

        auto completedQuery = query;
        completedQuery.replace(item.location.offset, item.location.size, insertText);

        result.push(JsValue::Dict({
            {"text", JsValue(item.text)},
            {"range", JsValue::List({
                JsValue(static_cast<int>(item.location.offset)),
                JsValue(static_cast<int>(item.location.size)),
            })},
            {"query", JsValue(completedQuery)},
            {"type", JsValue(completionTypeToString(item.type))},
            {"hint", item.hint.empty() ? JsValue::Undefined() : JsValue(item.hint)},
        }));
        ++count;
    }
    return *result;
}

bool hasFeatureModelSchema(mapget::LayerInfo const& layerInfo)
{
    return !layerInfo.featureModelSchema_.is_null();
}

struct ScopeFields
{
    std::set<std::string, std::less<>> featureDirectFields;
    std::set<std::string, std::less<>> attributeDirectFields;
    bool hasSchema = false;
};

void addFields(std::set<std::string, std::less<>>& target, std::span<const std::string> fields)
{
    for (auto const& field : fields) {
        target.insert(field);
    }
}

ScopeFields collectScopeFields(std::map<std::string, mapget::DataSourceInfo> const& infos)
{
    ScopeFields fields;
    fields.attributeDirectFields.insert("$name");
    fields.attributeDirectFields.insert("$feature");
    fields.attributeDirectFields.insert("$layer");
    fields.attributeDirectFields.insert("$validityIndex");
    fields.attributeDirectFields.insert("$validityCount");

    for (auto const& [_, dataSource] : infos) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                continue;
            }
            auto registry = layerInfo->schemaRegistry();
            if (!registry) {
                continue;
            }
            fields.hasSchema = true;
            for (auto const& featureType : layerInfo->featureTypes_) {
                auto featureSchema = registry->featureSchema(featureType.name_);
                addFields(fields.featureDirectFields, registry->directFields(featureSchema));

                auto layerMapSchema = registry->attributeLayerMapSchema(featureType.name_);
                for (auto const& layerName : registry->directFields(layerMapSchema)) {
                    auto layerSchema = registry->childSchema(
                        layerMapSchema,
                        layerName,
                        simfil::Schema::Kind::Object);
                    for (auto const& attributeName : registry->directFields(layerSchema)) {
                        auto attributeSchema = registry->childSchema(
                            layerSchema,
                            attributeName,
                            simfil::Schema::Kind::Object);
                        addFields(fields.attributeDirectFields, registry->directFields(attributeSchema));
                    }
                }
            }
        }
    }
    return fields;
}

std::vector<std::string> topLevelIdentifiers(std::string const& query)
{
    std::vector<std::string> identifiers;
    bool inString = false;
    char quote = '\0';
    bool escaped = false;
    for (size_t i = 0; i < query.size();) {
        auto const c = query[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == quote) {
                inString = false;
            }
            ++i;
            continue;
        }
        if (c == '"' || c == '\'') {
            inString = true;
            quote = c;
            ++i;
            continue;
        }
        auto const isStart = std::isalpha(static_cast<unsigned char>(c)) || c == '_' || c == '$';
        if (!isStart) {
            ++i;
            continue;
        }
        auto const start = i;
        ++i;
        while (i < query.size()) {
            auto const next = query[i];
            if (!std::isalnum(static_cast<unsigned char>(next)) && next != '_' && next != '$') {
                break;
            }
            ++i;
        }
        if (start > 0 && query[start - 1] == '.') {
            continue;
        }
        auto j = i;
        while (j < query.size() && std::isspace(static_cast<unsigned char>(query[j]))) {
            ++j;
        }
        if (j < query.size() && query[j] == '(') {
            continue;
        }
        identifiers.push_back(query.substr(start, i - start));
    }
    return identifiers;
}

bool isIgnoredIdentifier(std::string const& identifier)
{
    static const std::set<std::string, std::less<>> ignored = {
        "true",
        "false",
        "null",
        "and",
        "or",
        "not",
        "any",
        "all",
    };
    return ignored.contains(identifier);
}

} // namespace

TileLayerParser::TileLayerParser()
{
    // Create field dict cache
    cachedStrings_ = std::make_shared<mapget::TileLayerStream::StringPoolCache>();

    // Create fresh mapget stream parser.
    reset();
}

void TileLayerParser::setDataSourceInfo(const erdblick::SharedUint8Array& dataSourceInfoJson)
{
    // Parse data source info
    auto srcInfoParsed = nlohmann::json::parse(dataSourceInfoJson.toString());

    // Index available feature types by their feature id compositions.
    // These will be the available jump-to-feature targets.
    // For each composition, allow a version with and without optional params.
    for (auto const& node : srcInfoParsed) {
        auto dsInfo = DataSourceInfo::fromJson(node);
        if (dsInfo.isAddOn_) {
            // Do not expose add-on datasources in the frontend.
            continue;
        }
        for (auto const& [_, l] : dsInfo.layers_) {
            for (auto const& tp : l->featureTypes_) {
                for (auto const& composition : tp.uniqueIdCompositions_) {
                    for (auto const& withOptionals : {false, true}) {
                        std::vector<mapget::IdPart> idParts;
                        std::string compositionId = tp.name_;

                        for (auto const& idPart : composition) {
                            if (!idPart.isOptional_ || withOptionals) {
                                compositionId += fmt::format(".{}:{}", idPart.idPartLabel_, static_cast<uint32_t>(idPart.datatype_));
                                idParts.push_back(idPart);
                            }
                        }

                        auto& typeInfo = featureJumpTargets_[compositionId];
                        if (typeInfo.idParts_.empty()) {
                            typeInfo.id_ = compositionId;
                            typeInfo.idParts_ = idParts;
                            typeInfo.name_ = tp.name_;
                            typeInfo.layerInfo_ = l;
                        }
                        if (std::ranges::find(typeInfo.maps_, dsInfo.mapId_) == typeInfo.maps_.end())
                            typeInfo.maps_.emplace_back(dsInfo.mapId_);
                    }
                }
            }
        }

        info_.emplace(dsInfo.mapId_, std::move(dsInfo));
    }
}

void TileLayerParser::readFieldDictUpdate(SharedUint8Array const& bytes)
{
    try {
        reader_->read(bytes.toString());
    }
    catch(std::exception const& e) {
        std::cout << "ERROR: " << e.what() << std::endl;
    }
}

NativeJsValue TileLayerParser::getFieldDictOffsets()
{
    auto offsets = reader_->stringPoolCache()->stringPoolOffsets();
    auto result = JsValue::Dict();
    for (auto const& [nodeId, highestFieldId] : offsets)
        result.set(nodeId, JsValue(highestFieldId));
    return *result;
}

void TileLayerParser::reset()
{
    // Note: The reader is only ever used to read field dict updates.
    // For this, it does not need a layer info provider or onParsedLayer callback.
    reader_ = std::make_unique<TileLayerStream::Reader>(
        [](auto&& mapId, auto&& layerId){return nullptr;},
        [](auto&& layer){},
        cachedStrings_);
}

TileFeatureLayer TileLayerParser::readTileFeatureLayer(const SharedUint8Array& buffer)
{
    auto result = TileFeatureLayer(std::make_shared<mapget::TileFeatureLayer>(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& nodeId) { return cachedStrings_->getStringPool(nodeId); }));
    return result;
}

TileSourceDataLayer TileLayerParser::readTileSourceDataLayer(SharedUint8Array const& buffer)
{
    auto result = TileSourceDataLayer(std::make_shared<mapget::TileSourceDataLayer>(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& nodeId) { return cachedStrings_->getStringPool(nodeId); }));
    return result;
}

TileSearchResultLayer TileLayerParser::readTileSearchResultLayer(SharedUint8Array const& buffer)
{
    auto result = TileSearchResultLayer(std::make_shared<mapget::TileSearchResultLayer>(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& nodeId) { return cachedStrings_->getStringPool(nodeId); }));
    return result;
}

TileLayerParser::TileLayerMetadata TileLayerParser::readTileLayerMetadata(const SharedUint8Array& buffer)
{
    // Parse just the TileLayer part of the blob, which is the base class of
    // e.g. the TileFeatureLayer. The base class blob always precedes the
    // blob from the derived class.
    size_t bytesRead = 0;
    TileLayer tileLayer(
        buffer.bytes(),
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        &bytesRead
    );
    int32_t numFeatures = -1;
    uint32_t stage = 0;
    auto layerInfo = tileLayer.info();
    auto const& bytes = buffer.bytes();
    if (tileLayer.layerInfo() &&
        tileLayer.layerInfo()->type_ == LayerType::Features &&
        tileLayer.layerInfo()->stages_ > 1 &&
        bytesRead < bytes.size())
    {
        // TileFeatureLayer serializes stage as std::optional<uint32_t>:
        // one byte "hasValue" marker, followed by 4-byte little-endian value.
        // Staged layers always set stage, but keep a safe fallback to zero.
        const auto hasSerializedStage = bytes[bytesRead];
        if (hasSerializedStage == 1U && bytesRead + 1 + sizeof(uint32_t) <= bytes.size()) {
            const auto stageOffset = bytesRead + 1;
            stage =
                static_cast<uint32_t>(bytes[stageOffset]) |
                (static_cast<uint32_t>(bytes[stageOffset + 1]) << 8U) |
                (static_cast<uint32_t>(bytes[stageOffset + 2]) << 16U) |
                (static_cast<uint32_t>(bytes[stageOffset + 3]) << 24U);
        }
    }
    auto allScalarFields = JsValue::Dict();
    if (layerInfo.is_object()) {
        numFeatures = layerInfo.value<int32_t>("Size/Features#features", -1);
        for (auto const& [k, v] : layerInfo.items()) {
            if (v.is_number()) {
                allScalarFields.set(k, JsValue(v.get<double>()));
            }
        }
    }
    return {
        tileLayer.id().toString(),
        tileLayer.nodeId(),
        tileLayer.id().mapId_,
        tileLayer.id().layerId_,
        tileLayer.tileId().value_,
        stage,
        tileLayer.legalInfo() ? *tileLayer.legalInfo() : "",
        tileLayer.error() ? *tileLayer.error() : "",
        numFeatures,
        *allScalarFields
    };
}

void TileLayerParser::setFallbackLayerInfo(std::shared_ptr<mapget::LayerInfo> info) {
    fallbackLayerInfo_ = std::move(info);
}

std::shared_ptr<mapget::LayerInfo>
TileLayerParser::resolveMapLayerInfo(std::string const& mapId, std::string const& layerId)
{
    auto& map = info_[mapId];
    auto it = info_[mapId].layers_.find(layerId);
    if (it != map.layers_.end())
        return it->second;
    return fallbackLayerInfo_;
}

std::vector<TileLayerParser::FilteredFeatureJumpTarget>
TileLayerParser::filterFeatureJumpTargets(const std::string& queryString) const
{
    std::vector<FilteredFeatureJumpTarget> results;
    std::regex sep("[\\.,;|\\s]+"); // Regex to split the input based on multiple delimiters
    std::vector<std::string> tokens(
        std::sregex_token_iterator(queryString.begin(), queryString.end(), sep, -1),
        std::sregex_token_iterator());

    // Find applicable feature types based on the prefix.
    std::string prefix;
    std::vector<FeatureJumpTarget const*> targetsWithPrefixMatch;
    if (!tokens.empty()) {
        prefix = tokens[0];
        for (const auto& [_, target] : featureJumpTargets_) {
            if (!prefix.empty() && target.name_.substr(0, prefix.size()) == prefix)
                targetsWithPrefixMatch.push_back(&target);
        }
    }

    // Match all targets if there are no matching ones, or there is no prefix.
    if (targetsWithPrefixMatch.empty()) {
        for (const auto& [_, target] : featureJumpTargets_) {
            targetsWithPrefixMatch.push_back(&target);
        }
        prefix.clear();
    }

    // Try to match the parameters.
    for (const auto& target : targetsWithPrefixMatch) {
        FilteredFeatureJumpTarget result{*target, {}, std::nullopt};

        size_t tokenIndex = !prefix.empty() ? 1 : 0; // Start parsing after the prefix.
        for (const auto& part : target->idParts_) {
            auto partError = "?";

            if (tokenIndex >= tokens.size()) {
                result.error_ = "Insufficient parameters.";
                result.parsedParams_.emplace_back(part.idPartLabel_, partError);
                continue; // Skip optional parts if no more tokens.
            }

            std::variant<int64_t, std::string> parsedValue = tokens[tokenIndex++];
            std::string error;
            if (!part.validate(parsedValue, &error)) {
                result.error_ = error;
                parsedValue = partError;
            }

            result.parsedParams_.emplace_back(part.idPartLabel_, parsedValue);
        }

        if (tokenIndex < tokens.size()) {
            result.error_ = "Too many parameters.";
        }

        results.push_back(result);
    }

    return results;
}

void TileLayerParser::getDataSourceInfo(SharedUint8Array& out, std::string const& mapId)
{
    auto const& infoIt = info_.find(mapId);
    if (infoIt == info_.end()) {
        std::cout << "Could not find mapId!" << std::endl;
        return;
    }
    out.writeToArray("[" + infoIt->second.toJson().dump() + "]");
}

void TileLayerParser::getFieldDict(SharedUint8Array& out, std::string const& nodeId)
{
    auto fieldDict = cachedStrings_->getStringPool(nodeId);
    std::ostringstream outStream;
    fieldDict->write(outStream, 0);
    out.writeToArray(outStream.str());
}

void TileLayerParser::addFieldDict(const SharedUint8Array& buffer)
{
    size_t bytesRead;
    auto nodeId = mapget::StringPool::readDataSourceNodeId(buffer.bytes(), 0, &bytesRead);
    auto fieldDict = cachedStrings_->getStringPool(nodeId);
    (void) fieldDict->read(buffer.bytes(), bytesRead);
}

NativeJsValue TileLayerParser::completeSearchQuery(
    std::string const& query,
    int point,
    NativeJsValue const& options_)
{
    JsValue options(options_);
    point = std::max<int>(0, std::min<int>(point, query.size()));

    simfil::CompletionOptions opts;
    opts.limit = 15;
    if (options.has("limit")) {
        opts.limit = std::max<int>(0, options["limit"].as<int>());
    }
    if (options.has("timeoutMs")) {
        opts.timeoutMs = std::max<int>(0, options["timeoutMs"].as<int>());
    }

    std::string scope;
    if (options.has("scope")) {
        scope = options["scope"].as<std::string>();
    }
    auto const includeFeatureScope = scope != "attribute";
    auto const includeAttributeScope = scope != "feature";

    std::set<simfil::CompletionCandidate> mergedCandidates;
    for (auto const& [_, dataSource] : info_) {
        for (auto const& [__, layerInfo] : dataSource.layers_) {
            if (!layerInfo || layerInfo->type_ != mapget::LayerType::Features || !hasFeatureModelSchema(*layerInfo)) {
                continue;
            }
            std::shared_ptr<mapget::SchemaRegistry const> registry = layerInfo->schemaRegistry();
            if (!registry) {
                continue;
            }

            for (auto const& featureType : layerInfo->featureTypes_) {
                auto const featureSchema = registry->featureSchema(featureType.name_);
                if (includeFeatureScope && featureSchema != simfil::NoSchemaId) {
                    auto strings = std::make_shared<mapget::StringPool>("SearchCompletion");
                    auto model = std::make_shared<simfil::ModelPool>(strings);
                    auto root = makeSchemaCompletionNode(model, registry, featureSchema, kSchemaCompletionDepth);
                    addCompletionCandidates(mergedCandidates, registry, strings, query, point, *root, opts);
                }

                if (!includeAttributeScope) {
                    continue;
                }

                auto const layerMapSchema = registry->attributeLayerMapSchema(featureType.name_);
                if (layerMapSchema == simfil::NoSchemaId) {
                    continue;
                }
                for (auto const& layerName : registry->directFields(layerMapSchema)) {
                    auto const layerSchema = registry->childSchema(
                        layerMapSchema,
                        layerName,
                        simfil::Schema::Kind::Object);
                    if (layerSchema == simfil::NoSchemaId) {
                        continue;
                    }
                    for (auto const& attributeName : registry->directFields(layerSchema)) {
                        auto const attributeSchema = registry->childSchema(
                            layerSchema,
                            attributeName,
                            simfil::Schema::Kind::Object);
                        if (attributeSchema == simfil::NoSchemaId) {
                            continue;
                        }

                        auto strings = std::make_shared<mapget::StringPool>("SearchCompletion");
                        auto model = std::make_shared<simfil::ModelPool>(strings);
                        auto attributeRoot = model->newObject();
                        (void)attributeRoot->setSchema(attributeSchema);
                        for (auto const& fieldName : registry->directFields(attributeSchema)) {
                            auto childSchema = registry->childSchema(attributeSchema, fieldName);
                            auto child = makeSchemaCompletionNode(model, registry, childSchema, kSchemaCompletionDepth - 1);
                            (void)attributeRoot->addField(fieldName, child);
                        }
                        addAttributeOverlayFields(attributeRoot, model, registry, featureType.name_);
                        addCompletionCandidates(mergedCandidates, registry, strings, query, point, *attributeRoot, opts);
                    }
                }
            }
        }
    }

    return completionCandidatesToJs(query, mergedCandidates, opts.limit);
}

bool TileLayerParser::isAttributeScopeSearchQuery(std::string const& query) const
{
    auto const fields = collectScopeFields(info_);
    if (!fields.hasSchema) {
        return false;
    }

    auto const identifiers = topLevelIdentifiers(query);
    bool sawAttributeOnlyIdentifier = false;
    for (auto const& identifier : identifiers) {
        auto normalizedIdentifier = identifier;
        std::ranges::transform(normalizedIdentifier, normalizedIdentifier.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        if (isIgnoredIdentifier(normalizedIdentifier)) {
            continue;
        }

        auto const inFeatureScope = fields.featureDirectFields.contains(identifier);
        auto const inAttributeScope = fields.attributeDirectFields.contains(identifier);
        if (inAttributeScope && !inFeatureScope) {
            sawAttributeOnlyIdentifier = true;
            continue;
        }

        // Unknown or ambiguous fields remain feature-scope. Auto mode should not
        // accidentally switch an ordinary feature query into attribute evaluation.
        return false;
    }

    return sawAttributeOnlyIdentifier;
}

JsValue TileLayerParser::FilteredFeatureJumpTarget::toJsValue() const
{
    auto result = JsValue::Dict({
        {"id", JsValue(jumpTarget_.id_)},
        {"name", JsValue(jumpTarget_.name_)},
        {"error", error_ ? JsValue(*error_) : JsValue()},
    });
    auto mapNameList = JsValue::List();
    for (auto const& m : jumpTarget_.maps_) {
        mapNameList.push(JsValue(m));
    }
    result.set("maps", mapNameList);
    auto idPartList = JsValue::List();
    for (auto const& [key, value] : parsedParams_) {
        idPartList.push(JsValue::Dict({
            {"key", JsValue(key)},
            {"value", JsValue::fromVariant(value)}
        }));
    }
    result.set("idParts", idPartList);
    return result;
}

}
