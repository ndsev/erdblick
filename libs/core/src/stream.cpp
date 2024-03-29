#include "stream.h"
#include <iostream>

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
    for (auto const& node : srcInfoParsed) {
        auto dsInfo = DataSourceInfo::fromJson(node);
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
        [this](auto&& nodeId) { return cachedFieldDicts_->operator()(nodeId); });
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

}
