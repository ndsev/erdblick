#pragma once

#include "mapget/model/featurelayer.h"
#include "mapget/model/sourcedatalayer.h"
#include "mapget/model/subsetlayer.h"
#include "interop/js-object.h"
#include "buffer.h"
#include "mapget/model/sourcedata.h"
#include "mapget/model/incoming-relations.h"

namespace erdblick
{

/** Wrapper class around the mapget `TileFeatureLayer` smart pointer. */
struct TileFeatureLayer
{
    /**
     * Constructor accepting a shared pointer to the original `TileFeatureLayer` class.
     * @param self Shared pointer to `mapget::TileFeatureLayer`.
     */
    TileFeatureLayer(std::shared_ptr<mapget::TileFeatureLayer> self);

    /**
     * Retrieves the ID of the tile feature layer as a string.
     * @return The ID string.
     */
    std::string id() const;

    /** Retrieves the signed packed NDS.Live tile ID. */
    int32_t tileId() const;

    /** Return the tagged tile/object identity without narrowing object IDs. */
    NativeJsValue partition() const;

    /**
     * Gets the number of features in the tile.
     * @return The number of features.
     */
    uint32_t numFeatures() const;

    /**
     * Gets the total number of geometry vertices in the tile.
     * Includes all points across all geometries of all features.
     */
    uint64_t numVertices() const;

    /**
     * Retrieves the center point of the tile, including the zoom level as the Z coordinate.
     * @return The center point of the tile.
     */
    mapget::Point center() const;

    /**
     * Retrieves the legal information / copyright of the tile feature layer as a string.
     * @return The legal information string.
     */
    std::string legalInfo() const;

    /**
     * Finds a feature within the tile by its ID.
     * @param id The ID of the feature to find.
     * @return A pointer to the found feature, or `nullptr` if not found.
     */
    mapget::model_ptr<mapget::Feature> find(const std::string& id) const;

    /** Report whether the tile names a tile-level GLB attachment. */
    [[nodiscard]] bool hasGlbAttachment() const;

    /** Return the attachment name for the tile-level GLB, or empty string when absent. */
    [[nodiscard]] std::string glbAttachmentName() const;

    /**
     * Finds the index of a feature based on its type and ID parts.
     * @param type The type of the feature.
     * @param idParts The parts of the feature's ID.
     * @return The index of the feature, or `-1` if not found.
     */
    int32_t findFeatureIndex(std::string type, NativeJsValue idParts) const;

    /**
     * Retrieves the feature ID string for a feature address.
     * @param address Tile-local address of the feature.
     * @return Feature ID string, or empty string if not found.
     */
    std::string featureIdByAddress(uint32_t address) const;

    /**
     * Retrieves a feature by address.
     * @param address Tile-local address of the feature.
     * @return Feature pointer, or null if address is out of range.
     */
    mapget::model_ptr<mapget::Feature> featureByAddress(uint32_t address) const;

    /** Release the wrapped smart pointer. */
    ~TileFeatureLayer();

    /** Shared pointer to the underlying `mapget::TileFeatureLayer`. */
    mapget::TileFeatureLayer::Ptr model_;
};

/** Request-local native builder that validates incoming ownership before producing tree rows. */
class IncomingInspection
{
public:
    /** Decode the backend manifest and verify the selected target identity. */
    IncomingInspection(std::string const& manifest, std::string const& targetKey,
                       std::string const& featureId);

    /** Retain an immutable feature snapshot independently of its temporary WASM wrapper. */
    void addSnapshot(TileFeatureLayer const& layer);

    /** Validate the complete bundle and render source-owned incoming rows. */
    NativeJsValue inspectionModel() const;
private:
    mapget::IncomingRelationCollection collection_;
    std::vector<mapget::PartitionFeatureLayer::Ptr> snapshots_;
};

/** Wrapper class around the mapget `TileSourceDataLayer` smart pointer. */
struct TileSourceDataLayer
{
    /**
     * Constructor accepting a shared pointer to the original `TileSourceDataLayer` class.
     * @param self Shared pointer to `mapget::TileSourceDataLayer`.
     */
    TileSourceDataLayer(std::shared_ptr<mapget::TileSourceDataLayer> self);

    /**
     * Retrieves the source data address format of the layer.
     * @return The address format.
     */
    mapget::TileSourceDataLayer::SourceDataAddressFormat addressFormat() const;

    /**
     * Converts the layer's data to a JSON string with indentation.
     * @return The JSON representation of the layer.
     */
    std::string toJson() const;

    /** Obtain the error string of the layer, if there is one. */
    std::string getError() const;

    /** Convert the source hierarchy to the shared inspection-node representation. */
    NativeJsValue toObject() const;

    /** Shared pointer to the underlying `mapget::TileSourceDataLayer`. */
    std::shared_ptr<mapget::TileSourceDataLayer> model_;
};

/** Wrapper around one immutable server-evaluated `mapget::TileSubsetLayer`. */
struct TileSubsetLayer
{
    /** Adopt one parsed subset value. */
    explicit TileSubsetLayer(std::shared_ptr<mapget::TileSubsetLayer> self);

    /** Return the inherited output tile key. */
    std::string id() const;

    /** Return the serialized string-pool namespace. */
    std::string stringPoolId() const;

    /** Return the source map id. */
    std::string mapId() const;

    /** Return the source layer id. */
    std::string layerId() const;

    /** Return the signed packed output tile id. */
    int32_t tileId() const;

    /** Return the tagged tile/object identity without narrowing object IDs. */
    NativeJsValue partition() const;

    /** Return the transport subscription identity. */
    std::string filterId() const;

    /** Return the transport generation. */
    uint64_t generation() const;

    /** Return the number of ordered channels. */
    uint32_t numChannels() const;

    /** Return the terminal-entry count across all channels, saturated at uint32_t's maximum. */
    uint32_t numEntries() const;

    /** Return the inherited source and subset-local numeric metadata. */
    NativeJsValue info() const;

    /** Return every consulted source dependency, including empty tiles. */
    NativeJsValue dependencies() const;

    /** Return structured server-side evaluation issues. */
    NativeJsValue issues() const;

    /** Return the optional attachment name, or an empty string. */
    std::string glbAttachmentName() const;

    /** Return one channel's scope and ordered projection schemas, or undefined for a missing channel. */
    NativeJsValue channelSchema(uint32_t channelOrdinal) const;

    /**
     * Copy terminal rows in channel order, starting at offset. A zero limit
     * includes the remaining channel; a missing channel returns an empty list.
     * Entries without a feature identity are omitted, so fewer rows may be returned.
     *
     * Values follow `channelSchema()`'s featureFields for feature scope and
     * entryFields for other scopes. Optional positions use a representative
     * geometry center; broad searches normally use the cheaper output-tile center.
     */
    NativeJsValue entryRange(
        uint32_t channelOrdinal,
        uint32_t offset,
        uint32_t limit,
        bool includePosition) const;

    /**
     * Summarize channel projections and subset-wide request traces, grouped by
     * schema type. A missing channel returns undefined. Empty expression streams
     * count as missing; returned arrays remain individual list-valued results.
     *
     * Keep the first distinctLimit histogram keys per group, then return up to
     * histogramLimit of those keys by frequency. Keys are display strings;
     * otherCount includes discarded observations and omitted retained buckets.
     * A zero limit selects the default (16 histogram / 512 distinct); nonzero
     * limits are clamped to [1, 256] and [1, 8192], respectively.
     *
     * Numeric aggregates exclude non-finite values, unsafe JS integers, schema
     * specials and values outside declared ordinary ranges. Raw kind counts and
     * histograms still include those values.
     */
    NativeJsValue valueSummaries(
        uint32_t channelOrdinal,
        uint32_t histogramLimit,
        uint32_t distinctLimit) const;

    /**
     * Resolve one renderer picking tuple against this exact immutable subset.
     *
     * `endpointRole` is zero for the terminal/representative feature, one for
     * a relation source, and two for a relation target. Relation roles other than
     * two select the source; non-relation scopes ignore the role.
     * A missing channel returns undefined. An absent entry leaves only the
     * picking tuple and channel ID in the result, without a feature identity.
     */
    NativeJsValue resolvePick(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        uint32_t endpointRole) const;

    /**
     * Find compact renderer rows which resolve to one persisted interaction target.
     *
     * Only local feature identities match. entryIndex selects an attribute or
     * relation descriptor; validityIndex < 0 selects an attribute without a
     * validity. Indices are ignored for whole-feature targets. The browser
     * intersects these source rows with rows emitted by the active style.
     */
    NativeJsValue findPickReferences(
        std::string const& featureId,
        std::string const& scope,
        int64_t entryIndex,
        int64_t validityIndex) const;

    /** Return a compact JSON representation for diagnostics and tests. */
    std::string toJson() const;

    /**
     * Replace the output buffer with serialized SIMFIL diagnostics. Return false
     * without changing output when serialization fails.
     */
    bool copyDiagnostics(SharedUint8Array& output) const;

    /** Release the wrapped smart pointer. */
    ~TileSubsetLayer();

    /** Shared pointer retained for render jobs and picking lifetime. */
    mapget::TileSubsetLayer::Ptr model_;
};

} // namespace erdblick
