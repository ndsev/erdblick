#pragma once

#include "mapget/model/stream.h"
#include "buffer.h"

namespace erdblick
{

class TileLayerParser
{
public:
    explicit TileLayerParser(SharedUint8Array const& dataSourceInfo);
    void onTileParsed(std::function<void(mapget::TileFeatureLayer::Ptr)>);
    void parse(SharedUint8Array const& dataSourceInfo);
    void reset();
    mapget::TileLayerStream::FieldOffsetMap fieldDictOffsets();

private:
    std::map<std::string, mapget::DataSourceInfo> info_;
    std::unique_ptr<mapget::TileLayerStream::Reader> reader_;
    std::shared_ptr<mapget::TileLayerStream::CachedFieldsProvider> cachedFieldDicts_;
    std::function<void(mapget::TileFeatureLayer::Ptr)> tileParsedFun_;
};

}