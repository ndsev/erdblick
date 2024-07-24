#include <iostream>
#include <regex>
#include "mapget/model/stringpool.h"
#include "parser.h"

using namespace mapget;

namespace erdblick
{

TileLayerParser::TileLayerParser()
{
    // Create field dict cache
    cachedFieldDicts_ = std::make_shared<mapget::TileLayerStream::CachedFieldsProvider>();

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
                        std::stringstream compositionId;
                        compositionId << tp.name_;

                        for (auto const& idPart : composition) {
                            if (!idPart.isOptional_ || withOptionals) {
                                compositionId << "." << idPart.idPartLabel_ << ":" << static_cast<uint32_t>(idPart.datatype_);
                                idParts.push_back(idPart);
                            }
                        }

                        auto& typeInfo = featureJumpTargets_[compositionId.str()];
                        if (typeInfo.idParts_.empty()) {
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
    auto offsets = reader_->fieldDictCache()->fieldDictOffsets();
    auto result = JsValue::Dict();
    for (auto const& [nodeId, highestFieldId] : offsets)
        result.set(nodeId, JsValue(highestFieldId));
    return *result;
}

void TileLayerParser::reset()
{
    reader_ = std::make_unique<TileLayerStream::Reader>(
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& layer){
            const auto type = layer->layerInfo()->type_;
            if (type != LayerType::Features)
                return;

            if (tileParsedFun_)
                tileParsedFun_(std::static_pointer_cast<TileFeatureLayer>(layer));
        },
        cachedFieldDicts_);
}

mapget::TileFeatureLayer::Ptr TileLayerParser::readTileFeatureLayer(const SharedUint8Array& buffer)
{
    std::stringstream inputStream;
    inputStream << buffer.toString();
    auto result = std::make_shared<TileFeatureLayer>(
        inputStream,
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& nodeId) { return cachedFieldDicts_->getFieldDict(nodeId); });
    return result;
}
mapget::TileSourceDataLayer::Ptr TileLayerParser::readTileSourceDataLayer(SharedUint8Array const& buffer)
{
    std::stringstream inputStream;
    inputStream << buffer.toString();
    auto result = std::make_shared<TileSourceDataLayer>(
        inputStream,
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        },
        [this](auto&& nodeId) { return cachedFieldDicts_->getFieldDict(nodeId); });
    return result;
}

TileLayerParser::TileLayerMetadata TileLayerParser::readTileLayerMetadata(const SharedUint8Array& buffer)
{
    std::stringstream inputStream;
    inputStream << buffer.toString();
    // Parse just the TileLayer part of the blob, which is the base class of
    // e.g. the TileFeatureLayer. The base class blob always precedes the
    // blob from the derived class.
    TileLayer tileLayer(
        inputStream,
        [this](auto&& mapId, auto&& layerId)
        {
            return resolveMapLayerInfo(std::string(mapId), std::string(layerId));
        }
    );
    auto numFeatures = -1;
    auto layerInfo = tileLayer.info();
    if (layerInfo.is_object()) {
        numFeatures = layerInfo.value<int32_t>("num-features", -1);
    }
    return {
        tileLayer.id().toString(),
        tileLayer.nodeId(),
        tileLayer.id().mapId_,
        tileLayer.id().layerId_,
        tileLayer.tileId().value_,
        numFeatures
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
    auto fieldDict = cachedFieldDicts_->getFieldDict(nodeId);
    std::stringstream outStream;
    fieldDict->write(outStream, 0);
    out.writeToArray(outStream.str());
}

void TileLayerParser::addFieldDict(const SharedUint8Array& buffer)
{
    std::stringstream bufferStream;
    bufferStream << buffer.toString();
    auto nodeId = mapget::StringPool::readDataSourceNodeId(bufferStream);
    auto fieldDict = cachedFieldDicts_->getFieldDict(nodeId);
    fieldDict->read(bufferStream);
}

JsValue TileLayerParser::FilteredFeatureJumpTarget::toJsValue() const
{
    auto result = JsValue::Dict({
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
