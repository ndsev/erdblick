#pragma once

#include "mapget/model/featurelayer.h"
#include "mapget/model/sourcedatalayer.h"
#include "cesium-interface/object.h"
#include "mapget/model/sourcedata.h"

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

    /**
     * Retrieves the tile ID as a 64-bit unsigned integer.
     * @return The tile ID.
     */
    uint64_t tileId() const;

    /**
     * Gets the number of features in the tile.
     * @return The number of features.
     */
    uint32_t numFeatures() const;

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

    /**
     * Finds the index of a feature based on its type and ID parts.
     * @param type The type of the feature.
     * @param idParts The parts of the feature's ID.
     * @return The index of the feature, or `-1` if not found.
     */
    int32_t findFeatureIndex(std::string type, NativeJsValue idParts) const;

    ~TileFeatureLayer();

    /** Shared pointer to the underlying `mapget::TileFeatureLayer`. */
    mapget::TileFeatureLayer::Ptr model_;
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

    /**
     * Converts the `SourceDataLayer` hierarchy to a tree model compatible structure.
     *
     * **Layout:**
     * ```json
     * [
     *   {
     *     "data": {"key": "...", "value": ...},
     *     "children": [{ ... }]
     *   },
     *   ...
     * ]
     * ```
     * @return A `NativeJsValue` representing the hierarchical data structure.
     */
    NativeJsValue toObject() const;

    /** Shared pointer to the underlying `mapget::TileSourceDataLayer`. */
    std::shared_ptr<mapget::TileSourceDataLayer> model_;
};

} // namespace erdblick
