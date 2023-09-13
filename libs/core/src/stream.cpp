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

void TileLayerParser::onTileParsedFromStream(std::function<void(mapget::TileFeatureLayer::Ptr)> fun)
{
    tileParsedFun_ = std::move(fun);
}

void TileLayerParser::parseFromStream(SharedUint8Array const& bytes)
{
    try {
        reader_->read(bytes.toString());
    }
    catch(std::exception const& e) {
        std::cout << "ERROR: " << e.what() << std::endl;
    }
}

mapget::TileLayerStream::FieldOffsetMap TileLayerParser::fieldDictOffsets()
{
    return reader_->fieldDictCache()->fieldDictOffsets();
}

void TileLayerParser::reset()
{
    reader_ = std::make_unique<TileLayerStream::Reader>(
        [this](auto&& mapId, auto&& layerId){
            return info_[std::string(mapId)].getLayer(std::string(layerId));
        },
        [this](auto&& layer){
            if (tileParsedFun_)
                tileParsedFun_(layer);
        },
        cachedFieldDicts_);
}

void TileLayerParser::writeTileFeatureLayer(  // NOLINT (Could be made static, but not due to Embind)
    mapget::TileFeatureLayer::Ptr const& tile,
    SharedUint8Array& buffer)
{
    std::stringstream serializedTile;
    tile->write(serializedTile);
    buffer.writeToArray(serializedTile.str());
}

mapget::TileFeatureLayer::Ptr TileLayerParser::readTileFeatureLayer(const SharedUint8Array& buffer)
{
    std::stringstream inputStream;
    inputStream << buffer.toString();
    auto result = std::make_shared<TileFeatureLayer>(
        inputStream,
        [this](auto&& mapId, auto&& layerId)
        { return info_[std::string(mapId)].getLayer(std::string(layerId)); },
        [this](auto&& nodeId) { return cachedFieldDicts_->operator()(nodeId); });
    return result;
}

}
