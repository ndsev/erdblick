#pragma once

#include "mapget/model/stream.h"
#include "mapget/model/featurelayer.h"
#include "buffer.h"
#include "interop/js-object.h"
#include "mapget/model/featurelayer.h"
#include "mapget/model/sourcedatalayer.h"
#include "layer.h"

namespace erdblick
{

/**
 * Stateful decoder for streamed mapget tile payloads and auxiliary dictionaries.
 *
 * The parser retains string-pool and layer-info caches across calls so streamed
 * updates can be decoded incrementally and feature-id parsing can later reuse
 * the same metadata.
 */
class TileLayerParser
{
    friend class TestDataProvider;

public:
    /** Create a parser with empty stream state and metadata caches. */
    explicit TileLayerParser();

    /**
     * Update the data source info metadata which the parser uses
     * to supply parsed TileFeatureLayers with map metadata info.
     */
    void setDataSourceInfo(SharedUint8Array const& dataSourceInfoJson);

    /**
     * Get the data source info JSON that was set earlier.
     */
    void getDataSourceInfo(SharedUint8Array& dataSourceInfoJson, std::string const& mapId);

    /**
     * Parse a TileFeatureLayer from a buffer as returned by writeTileFeatureLayer.
     */
    TileFeatureLayer readTileFeatureLayer(SharedUint8Array const& buffer);

    /**
     * Parse a TileSourceDataLayer from a buffer.
     */
    TileSourceDataLayer readTileSourceDataLayer(SharedUint8Array const& buffer);

    /** Cheap metadata view read from a tile blob without fully parsing the tile. */
    struct TileLayerMetadata {
        std::string id;
        std::string nodeId;
        std::string mapName;
        std::string layerName;
        uint64_t tileId;
        uint32_t stage;
        std::string legalInfo;
        std::string error;
        int32_t numFeatures;
        NativeJsValue scalarFields;
    };
    /** Parse only cheap tile metadata without constructing the full feature/source-data model. */
    TileLayerMetadata readTileLayerMetadata(SharedUint8Array const& buffer);

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

    /**
     * Get a serialized field dictionary, which can be passed into addFieldDict().
     */
    void getFieldDict(SharedUint8Array& out, std::string const& nodeId);

    /**
     * Add a serialized field dictionary that is not wrapped in a message frame.
     */
    void addFieldDict(SharedUint8Array const& buffer);

    /**
     * Set layer info which will be used if the external doesn't fit.
     * Used for test data, which does not have layer info among the
     * info fetched from the connected mapget service.
     */
    void setFallbackLayerInfo(std::shared_ptr<mapget::LayerInfo> info);

    /**
     * Describes how one feature type can be reconstructed from a textual jump query.
     */
    struct FeatureJumpTarget
    {
        std::string id_;
        std::string name_;
        std::vector<std::string> maps_;
        std::vector<mapget::IdPart> idParts_;
        std::shared_ptr<mapget::LayerInfo> layerInfo_;
    };

    /**
     * A single result from filterFeatureJumpTargets.
     */
    struct FilteredFeatureJumpTarget
    {
        FeatureJumpTarget const& jumpTarget_;
        mapget::KeyValuePairs parsedParams_;
        std::optional<std::string> error_;

        /** Convert this jump-target parse result into the JS object consumed by the UI. */
        JsValue toJsValue() const;
    };

    /**
     * Takes a parameter string.
     * Checks if the first parameter is the prefix of a feature type name.
     * No valid feature type prefix: Try parsing with all feature types.
     * Otherwise: Try only feature type names where the prefix matches.
     * @return Vector of parsing results. An invalid parsing result will have
     *  a set `error_`. The Id-Part-values of errored parses may be indicative
     *  of the problem, e.g. `Expecting I32`.
     */
    std::vector<FilteredFeatureJumpTarget> filterFeatureJumpTargets(std::string const& queryString) const;

    std::map<std::string, mapget::DataSourceInfo> info_;
    std::unique_ptr<mapget::TileLayerStream::Reader> reader_;
    std::shared_ptr<mapget::TileLayerStream::StringPoolCache> cachedStrings_;
    std::function<void(mapget::TileFeatureLayer::Ptr)> tileParsedFun_;
    std::shared_ptr<mapget::LayerInfo> fallbackLayerInfo_;

    /**
     * Resolve layer metadata for a `(mapId, layerId)` pair using loaded datasource info
     * and the optional fallback layer info used by tests.
     */
    std::shared_ptr<mapget::LayerInfo>
    resolveMapLayerInfo(std::string const& mapId, std::string const& layerId);

    /** Type info registry. */
    std::map<std::string, FeatureJumpTarget> featureJumpTargets_;
};

}
