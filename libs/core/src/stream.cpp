#include "stream.h"
#include <iostream>

using namespace mapget;

namespace erdblick
{

TileLayerParser::TileLayerParser(SharedUint8Array const& dataSourceInfo)
{
    // Create field dict cache
    cachedFieldDicts_ = std::make_shared<mapget::TileLayerStream::CachedFieldsProvider>();

    // Parse data source info
    auto srcInfoParsed = nlohmann::json::parse(dataSourceInfo.toString());
    for (auto const& node : srcInfoParsed) {
        auto dsInfo = DataSourceInfo::fromJson(node);
        info_.emplace(dsInfo.mapId_, std::move(dsInfo));
    }

    // Create fresh parser
    reset();
}

void TileLayerParser::onTileParsed(std::function<void(mapget::TileFeatureLayer::Ptr)> fun)
{
    tileParsedFun_ = std::move(fun);
}

void TileLayerParser::parse(SharedUint8Array const& bytes)
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

}
