#pragma once

#include "mapget/model/stream.h"
#include "buffer.h"

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
     * Serialize a TileFeatureLayer to a buffer.
     */
    void writeTileFeatureLayer(mapget::TileFeatureLayer::Ptr const& tile, SharedUint8Array& buffer);

    /**
     * Parse a TileFeatureLayer from a buffer as returned by writeTileFeatureLayer.
     */
    mapget::TileFeatureLayer::Ptr readTileFeatureLayer(SharedUint8Array const& buffer);

    /**
     * Reset the parser by removing any buffered unparsed stream chunks.
     */
    void reset();

    /**
     * Access the field id dictionary offsets as currently known by this parser.
     * This is used to tell the server whether additional field-id mapping updates
     * need to be sent.
     */
    mapget::TileLayerStream::FieldOffsetMap fieldDictOffsets();

    /**
     * Stream-based parsing functionality: Set callback which is called
     * as soon as a tile has been parsed.
     */
    void onTileParsedFromStream(std::function<void(mapget::TileFeatureLayer::Ptr)>);

    /**
     * Add a chunk of streamed data into this TileLayerParser.
     */
    void parseFromStream(SharedUint8Array const& buffer);

private:
    std::map<std::string, mapget::DataSourceInfo> info_;
    std::unique_ptr<mapget::TileLayerStream::Reader> reader_;
    std::shared_ptr<mapget::TileLayerStream::CachedFieldsProvider> cachedFieldDicts_;
    std::function<void(mapget::TileFeatureLayer::Ptr)> tileParsedFun_;
};

}