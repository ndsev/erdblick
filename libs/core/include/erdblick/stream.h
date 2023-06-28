#pragma once

#include "mapget/model/stream.h"
#include "buffer.h"

namespace erdblick
{

class TileLayerParser
{
public:
    TileLayerParser(SharedUint8Array const& dataSourceInfo);
    void onTileParsed(std::function<void(mapget::TileFeatureLayer::Ptr)>);
    void parse(SharedUint8Array const& dataSourceInfo);

private:
    std::map<std::string, mapget::DataSourceInfo> info_;
    std::unique_ptr<mapget::TileLayerStream::Reader> reader_;
    std::function<void(mapget::TileFeatureLayer::Ptr)> tileParsedFun_;
};

}