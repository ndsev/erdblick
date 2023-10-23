#pragma once

#include "mapget/model/stream.h"
#include "buffer.h"
#include "cesium-interface/object.h"

namespace erdblick
{

class TileLayerParser
{
public:
    explicit TileLayerParser();

    /**
     * Update the data source info metadata which the parser uses
     * to supply parsed TileFeatureLayers with map metadata info.
     */
    void setDataSourceInfo(SharedUint8Array const& dataSourceInfoJson);

    /**
     * Parse a TileFeatureLayer from a buffer as returned by writeTileFeatureLayer.
     */
    mapget::TileFeatureLayer::Ptr readTileFeatureLayer(SharedUint8Array const& buffer);

    /**
     * Parse only the stringified MapTileKey and tile id from the tile layer blob.
     * Returns two-element JS list, containing both.
     */
    NativeJsValue readTileLayerKeyAndTileId(SharedUint8Array const& buffer);

    /**
     * Reset the parser by removing any buffered unparsed stream chunks.
     */
    void reset();

    /**
     * Access the field id dictionary offsets as currently known by this parser.
     * This is used to tell the server whether additional field-id mapping updates
     * need to be sent.
     */
    NativeJsValue getFieldDictOffsets();

    /**
     * Add a chunk of streamed fields into this TileLayerParser.
     */
    void readFieldDictUpdate(SharedUint8Array const& buffer);

private:
    std::map<std::string, mapget::DataSourceInfo> info_;
    std::unique_ptr<mapget::TileLayerStream::Reader> reader_;
    std::shared_ptr<mapget::TileLayerStream::CachedFieldsProvider> cachedFieldDicts_;
    std::function<void(mapget::TileFeatureLayer::Ptr)> tileParsedFun_;
};

}