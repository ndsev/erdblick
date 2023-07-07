#include "stream.h"
#include <iostream>

using namespace mapget;

namespace erdblick
{

TileLayerParser::TileLayerParser(SharedUint8Array const& dataSourceInfo)
{
    // Parse data source info
    auto srcInfoParsed = nlohmann::json::parse(dataSourceInfo.toString());

    for (auto const& node : srcInfoParsed) {
        auto dsInfo = DataSourceInfo::fromJson(node);
        info_.emplace(dsInfo.mapId_, std::move(dsInfo));
    }

    // Create parser
    reader_ = std::make_unique<TileLayerStream::Reader>(
        [this](auto&& mapId, auto&& layerId){
            return info_[std::string(mapId)].getLayer(std::string(layerId));
        },
        [this](auto&& layer){
            if (tileParsedFun_)
                tileParsedFun_(layer);
        });
}

void TileLayerParser::onTileParsed(std::function<void(mapget::TileFeatureLayer::Ptr)> fun)
{
    tileParsedFun_ = std::move(fun);
}

void TileLayerParser::parse(SharedUint8Array const& dataSourceInfo)
{
    reader_->read(dataSourceInfo.toString());
}

}