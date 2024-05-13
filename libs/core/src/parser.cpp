#include <iostream>
#include <regex>
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

    std::cout << dataSourceInfoJson.toString() << std::endl;

    // Index available feature types by their feature id compositions.
    // These will be the available jump-to-feature targets.
    // For each composition, allow a version with and without optional params.
    for (auto const& node : srcInfoParsed) {
        auto dsInfo = DataSourceInfo::fromJson(node);
        for (auto const& [_, l] : dsInfo.layers_) {
            for (auto const& tp : l->featureTypes_) {
                for (auto const& composition : tp.uniqueIdCompositions_) {
                    std::cout << tp.name_ << std::endl;
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

                        std::cout << compositionId.str() << std::endl;

                        auto& typeInfo = featureJumpTargets_[compositionId.str()];
                        if (typeInfo.idParts_.empty()) {
                            typeInfo.idParts_ = idParts;
                            typeInfo.name_ = tp.name_;
                            typeInfo.layerInfo_ = l;
                        }
                        typeInfo.mapAndLayerNames_.emplace_back(dsInfo.mapId_, l->layerId_);
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
            if (tileParsedFun_)
                tileParsedFun_(layer);
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
    std::cout << "Using fallback layer info: " << fallbackLayerInfo_->layerId_ << std::endl;
    return fallbackLayerInfo_;
}

std::vector<TileLayerParser::FilteredFeatureJumpTarget>
TileLayerParser::filterFeatureJumpTargets(const std::string& queryString) const
{
    std::vector<FilteredFeatureJumpTarget> results;
    std::regex sep("[.,;|\\s]+"); // Regex to split the input based on multiple delimiters
    std::vector<std::string> tokens(
        std::sregex_token_iterator(queryString.begin(), queryString.end(), sep, -1),
        std::sregex_token_iterator());

    std::string prefix;
    if (!tokens.empty())
        prefix = tokens[0];

    // Find applicable feature types based on the prefix
    for (const auto& [_, target] : featureJumpTargets_) {
        if (!prefix.empty() && target.name_.substr(0, prefix.size()) != prefix)
            continue;

        FilteredFeatureJumpTarget result{target, {}, std::nullopt};

        size_t tokenIndex = 1; // Start parsing after the prefix
        for (const auto& part : target.idParts_) {
            auto partError = std::string("Expecting ")+nlohmann::json(part.datatype_).dump();

            if (tokenIndex >= tokens.size()) {
                result.error_ = "Insufficient parameters.";
                result.parsedParams_.emplace_back(part.idPartLabel_, partError);
                continue; // Skip optional parts if no more tokens
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

JsValue TileLayerParser::FilteredFeatureJumpTarget::toJsValue() const
{
    auto result = JsValue::Dict({
        {"name", JsValue(jumpTarget_.name_)},
        {"error", error_ ? JsValue(*error_) : JsValue()},
    });
    auto mapLayerNameList = JsValue::List();
    for (auto const& [m, l] : jumpTarget_.mapAndLayerNames_) {
        mapLayerNameList.push(JsValue::List({JsValue(m), JsValue(l)}));
    }
    result.set("mapLayers", mapLayerNameList);
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
