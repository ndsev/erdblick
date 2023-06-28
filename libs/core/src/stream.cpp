#include "stream.h"
#include <iostream>

using namespace mapget;

namespace erdblick
{

TileLayerParser::TileLayerParser(SharedUint8Array const& dataSourceInfo)
{
    std::cout << "Got " << dataSourceInfo.toString() << std::endl;
    // Parse data source info
    auto srcInfoParsed = nlohmann::json::parse(dataSourceInfo.toString());

    std::cout << "Parsed json." << std::endl;
    for (auto const& node : srcInfoParsed) {
        std::cout << "Creating data source." << std::endl;
        auto dsInfo = DataSourceInfo::fromJson(node);
        info_.emplace(dsInfo.mapId_, std::move(dsInfo));
    }

    // Create parser
    reader_ = std::make_unique<TileLayerStream::Reader>(
        [this](auto&& mapId, auto&& layerId){
            std::cout << "Layer info for " << mapId << ", " << layerId << std::endl;
            // TODO: Need stable map id
            return info_[std::string(mapId)].getLayer(std::string(layerId));
        },
        [this](auto&& layer){
            if (tileParsedFun_)
                tileParsedFun_(layer);
        });
}

void TileLayerParser::onTileParsed(std::function<void(mapget::TileFeatureLayer::Ptr)> fun)
{
    tileParsedFun_ = fun;
}

void TileLayerParser::parse(SharedUint8Array const& dataSourceInfo)
{
    reader_->read(dataSourceInfo.toString());
}

}