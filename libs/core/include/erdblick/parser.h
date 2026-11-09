#pragma once

#include "buffer.h"
#include "interop/js-object.h"
#include "layer.h"
#include "mapget/model/featureidentity.h"
#include "mapget/model/featurelayer.h"
#include "mapget/model/mapschema.h"
#include "mapget/model/sourcedatalayer.h"
#include "mapget/model/stream.h"
#include "mapget/model/subsetlayer.h"

namespace erdblick
{

class FeatureLayerStyle;

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
    class StyleFieldDiscovery;

public:
    /** Create a parser with empty stream state and metadata caches. */
    explicit TileLayerParser();

    /**
     * Validate and retain an exact binary schema before publishing its sources.
     * MapSchema's process-local cache shares immutable owners across parsers;
     * a separate WASM worker must install its own heap-local owner first.
     */
    void installMapSchema(SharedUint8Array const& bytes, std::string const& expectedId);

    /** Enumerate only feature types produced by the selected layer. */
    NativeJsValue featureTypes(std::string const& mapId, std::string const& layerId) const;

    /** Refresh service-derived incoming eligibility without replacing schema/model metadata. */
    void setIncomingRelationHints(SharedUint8Array const& catalogJson);

    /**
     * Update the data source info metadata which the parser uses
     * to supply parsed TileFeatureLayers with map metadata info.
     */
    void setDataSourceInfo(SharedUint8Array const& dataSourceInfoJson);

    /**
     * Apply {removedMapIds, addedSources} atomically. Replacement explicitly
     * removes the old map before adding its new metadata. Unchanged maps keep
     * their layer-info, schema and dictionary owners, including add-on pools.
     */
    void applyDataSourceChanges(SharedUint8Array const& changesJson);

    /**
     * Get the data source info JSON that was set earlier.
     */
    void getDataSourceInfo(SharedUint8Array& dataSourceInfoJson, std::string const& mapId);

    /**
     * Parse a TileFeatureLayer from a buffer as returned by writeTileFeatureLayer.
     */
    TileFeatureLayer readTileFeatureLayer(SharedUint8Array const& buffer);

    /** Request discovery for a matching family or unknown coverage; only known absence suppresses
     * it. */
    bool hasIncomingRelations(TileFeatureLayer const& layer, std::string const& featureId) const;

    /**
     * Parse a TileSourceDataLayer from a buffer.
     */
    TileSourceDataLayer readTileSourceDataLayer(SharedUint8Array const& buffer);

    /** Parse one immutable server-evaluated subset from a filter frame. */
    TileSubsetLayer readTileSubsetLayer(SharedUint8Array const& buffer);

    /** Cheap metadata view read from a tile blob without fully parsing the tile. */
    struct TileLayerMetadata {
        std::string id;
        std::string stringPoolId;
        std::string mapName;
        std::string layerName;
        /** Tagged partition identity; object ids remain decimal strings. */
        NativeJsValue partition;
        /** Tile-only compatibility field; zero for object partitions. */
        int32_t tileId;
        std::string legalInfo;
        std::string error;
        NativeJsValue warnings;
        int32_t numFeatures;
        double conversionTimestampMs;
        /** Finite milliseconds when supplied by the datasource; NaN means no expiry. */
        double ttlMs;
        NativeJsValue scalarFields;
    };
    /** Parse only cheap tile metadata without constructing the full feature/source-data model. */
    TileLayerMetadata readTileLayerMetadata(SharedUint8Array const& buffer);

    /** Read base metadata plus filter identity without constructing subset entries. */
    struct TileSubsetLayerMetadata {
        TileLayerMetadata layer;
        std::string filterId;
        uint64_t generation;
        NativeJsValue dependencies;
        NativeJsValue issues;
        std::string glbAttachmentName;
    };
    TileSubsetLayerMetadata readTileSubsetLayerMetadata(SharedUint8Array const& buffer);

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
    void getFieldDict(SharedUint8Array& out, std::string const& stringPoolId);

    /**
     * Add a serialized field dictionary that is not wrapped in a message frame.
     */
    void addFieldDict(SharedUint8Array const& buffer);

    /**
     * Complete a SIMFIL search query using the installed immutable MapSchema.
     *
     * Returns an empty list when no schema metadata is available. This deliberately
     * does not fall back to loaded tile blobs.
     */
    NativeJsValue completeSearchQuery(std::string const& query, int point, NativeJsValue const& options);

    /**
     * Conservative schema-backed inference for search scope auto mode.
     *
     * Returns true when the query references one or more concrete attribute
     * contexts without requiring feature-owned or broad dynamic fields.
     */
    bool isAttributeScopeSearchQuery(std::string const& query, NativeJsValue const& options) const;

    /**
     * Return attribute contexts whose schema can evaluate the supplied query.
     *
     * The result is a list of `{attrName, featureType, attrLayerName, mapId, layerId}` dictionaries.
     */
    NativeJsValue getAttributeScopeForQuery(std::string const& query, NativeJsValue const& options) const;

    /**
     * Return map/layer refs whose schema appears to be addressed by the supplied query.
     *
     * The result is a dictionary with `mapLayers`, `matchedFieldNames`, and `matchedEnumValues`.
     */
    NativeJsValue getMapLayersForQuery(std::string const& query, NativeJsValue const& options) const;

    /**
     * Return concrete search scope plus the backend-safe normalized query.
     */
    NativeJsValue normalizeSearchQuery(std::string const& query, std::string const& scope, NativeJsValue const& options) const;

    /**
     * Offer portable expressions for confirmed input and their per-layer
     * execution plans. Artifact IDs validate only those temporary plans;
     * accepted expressions remain reusable on other maps. No tile data is read.
     */
    NativeJsValue prepareSearchQuery(
        std::string const& query,
        std::string const& scope,
        NativeJsValue const& options) const;

    /**
     * Discover schema-backed style fields in a selected semantic subtree.
     *
     * `scope` accepts `feature`, `attribute`, or `auto`. Attribute scope is narrowed through
     * getAttributeScopeForQuery(query), falling back to all attribute contexts if no attribute was
     * inferred. Options may select feature types, one context, a path of field names and
     * `{elements:true}` array steps, direct children versus recursive traversal,
     * and scalar versus all values. The
     * returned inventory shares context/type tables; paths retain every exact
     * meaning instead of copying type metadata into each feature occurrence.
     */
    NativeJsValue searchStyleFieldsForQuery(std::string const& query, std::string const& scope, NativeJsValue const& options) const;

    /**
     * Derive generic mapget `/filter` channels for a concrete catalog layer.
     * Compatible feature rules may share a channel; invalid plans are rejected
     * instead of executing a partial set of channels.
     */
    NativeJsValue planStyleFilter(
        FeatureLayerStyle const& style,
        std::string const& mapId,
        std::string const& layerId,
        int highlightMode,
        int lod);

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
        // The layer retains the graph once; this composition borrows its
        // canonical parts instead of keeping a second vector of declarations.
        mapget::FeatureIdentity::Composition composition_;
        bool includeOptionalParts_ = false;
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
     * Offer matching feature types and parse their ID parts for the omnibar.
     * A type-name prefix retains incomplete alternatives with `error_` set
     * and missing/invalid ID parts represented by "?". Without a matching
     * prefix, return only complete valid bare IDs. Empty input has no targets.
     */
    std::vector<FilteredFeatureJumpTarget> filterFeatureJumpTargets(std::string const& queryString) const;

    std::map<std::string, mapget::DataSourceInfo> info_;
    /** Exact owners retained for metadata and already captured inspection/subset snapshots. */
    std::map<std::string, std::shared_ptr<mapget::MapSchema const>, std::less<>> schemas_;
    /** Backend-derived capability hints retained when the shared parser omits full schemas. */
    std::map<std::pair<std::string, std::string>, std::set<std::string>> incomingRelationTargets_;
    std::set<std::pair<std::string, std::string>> incomingRelationCoverageUnknown_;
    std::unique_ptr<mapget::TileLayerStream::Reader> reader_;
    std::shared_ptr<mapget::TileLayerStream::StringPoolCache> cachedStrings_;
    /** Serialized subsets can use add-on dictionaries absent from catalog metadata. */
    std::map<std::string, std::set<std::string>> stringPoolsByMap_;
    std::function<void(mapget::TileFeatureLayer::Ptr)> tileParsedFun_;
    std::shared_ptr<mapget::LayerInfo> fallbackLayerInfo_;
    struct SchemaCompletionBinding;
    std::map<std::pair<std::string, std::string>, std::shared_ptr<SchemaCompletionBinding>>
        schemaCompletionBindings_;

    /** Resolve an already installed graph; model decoding never performs network IO. */
    std::shared_ptr<mapget::MapSchema const> resolveMapSchema(std::string_view schemaId) const;

    /** Validate a complete edit before replacing indexes or releasing any dictionary. */
    void changeDataSources(nlohmann::json const& removedMapIds, nlohmann::json const& addedSources);

    /** Keep dictionaries needed by lazily decoded retained subsets across unrelated edits. */
    void trackStringPool(mapget::PartitionLayer const& layer);

    /**
     * Resolve layer metadata for a `(mapId, layerId)` pair using loaded datasource info
     * and the optional fallback layer info used by tests.
     */
    std::shared_ptr<mapget::LayerInfo>
    resolveMapLayerInfo(std::string const& mapId, std::string const& layerId) const;

    /** Type info registry. */
    std::map<std::string, FeatureJumpTarget> featureJumpTargets_;
};

}
