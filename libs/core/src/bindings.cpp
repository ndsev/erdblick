#include <emscripten/bind.h>

#include "aabb.h"
#include "buffer.h"
#include "renderer.h"
#include "stream.h"
#include "style.h"
#include "testdataprovider.h"

#include "mapget/log.h"

using namespace erdblick;
namespace em = emscripten;

/**
 * Gets the prioritized list of tile IDs for a given viewport, zoom level, and tile limit.
 *
 * This function takes a viewport, a zoom level, and a tile limit, and returns an array of tile IDs
 * that are visible in the viewport, prioritized by radial distance from the camera position.
 *
 * The function first extracts the viewport properties and creates an Axis-Aligned Bounding Box (AABB)
 * from the viewport boundaries. If the number of tile IDs in the AABB at the given zoom level exceeds
 * the specified limit, a new AABB is created from the camera position and tile limit.
 *
 * The function then populates a vector of prioritized tile IDs by calculating the radial distance
 * from the camera position to the center of each tile in the AABB. The tile IDs are then sorted by
 * their radial distance, and the sorted array is converted to an emscripten value to be returned.
 * Duplicate tile IDs are removed from the array before it is returned.
 *
 * @param viewport An emscripten value representing the viewport. The viewport is an object
 *                 containing the following properties:
 *                 - south: The southern boundary of the viewport.
 *                 - west: The western boundary of the viewport.
 *                 - width: The width of the viewport.
 *                 - height: The height of the viewport.
 *                 - camPosLon: The longitude of the camera position.
 *                 - camPosLat: The latitude of the camera position.
 *                 - orientation: The orientation of the viewport.
 * @param level The zoom level for which to get the tile IDs.
 * @param limit The maximum number of tile IDs to return.
 *
 * @return An emscripten value representing an array of prioritized tile IDs.
 */
em::val getTileIds(em::val viewport, int level, int limit)
{
    double vpSouth = viewport["south"].as<double>();
    double vpWest = viewport["west"].as<double>();
    double vpWidth = viewport["width"].as<double>();
    double vpHeight = viewport["height"].as<double>();
    double camPosLon = viewport["camPosLon"].as<double>();
    double camPosLat = viewport["camPosLat"].as<double>();
    double orientation = viewport["orientation"].as<double>();

    Wgs84AABB aabb(Wgs84Point{vpWest, vpSouth, .0}, {vpWidth, vpHeight});
    if (aabb.numTileIds(level) > limit)
        // Create a size-limited AABB from the tile limit.
        aabb = Wgs84AABB::fromCenterAndTileLimit(Wgs84Point{camPosLon, camPosLat, .0}, limit, level);

    std::vector<std::pair<mapget::TileId, float>> prioritizedTileIds;
    prioritizedTileIds.reserve(limit);
    aabb.tileIdsWithPriority(
        level,
        prioritizedTileIds,
        Wgs84AABB::radialDistancePrioFn({camPosLon, camPosLat}, orientation));

    std::sort(
        prioritizedTileIds.begin(),
        prioritizedTileIds.end(),
        [](auto const& l, auto const& r) { return l.second < r.second; });

    em::val resultArray = em::val::array();
    int64_t prevTileId = -1;
    for (const auto& tileId : prioritizedTileIds) {
        if (tileId.first.value_ == prevTileId)
            continue;
        resultArray.call<void>("push", tileId.first.value_);
        prevTileId = tileId.first.value_;
    }

    return resultArray;
}

/** Get the center position for a mapget tile id in WGS84. */
mapget::Point getTilePosition(uint64_t tileIdValue) {
    mapget::TileId tid(tileIdValue);
    return tid.center();
}

/** Get the full key of a map tile feature layer. */
std::string getTileFeatureLayerKey(std::string const& mapId, std::string const& layerId, uint64_t tileId) {
    auto tileKey = mapget::MapTileKey();
    tileKey.layer_ = mapget::LayerType::Features;
    tileKey.mapId_ = mapId;
    tileKey.layerId_ = layerId;
    tileKey.tileId_ = tileId;
    return tileKey.toString();
}

EMSCRIPTEN_BINDINGS(FeatureLayerRendererBind)
{
    ////////// SharedUint8Array
    em::class_<SharedUint8Array>("SharedUint8Array")
        .constructor()
        .constructor<uint32_t>()
        .function("getSize", &SharedUint8Array::getSize)
        .function("getPointer", &SharedUint8Array::getPointer);

    ////////// Point
    em::value_object<mapget::Point>("Point")
        .field("x", &mapget::Point::x)
        .field("y", &mapget::Point::y)
        .field("z", &mapget::Point::z);

    ////////// FeatureLayerStyle
    em::class_<FeatureLayerStyle>("FeatureLayerStyle").constructor<SharedUint8Array&>();

    ////////// Feature
    using FeaturePtr = mapget::model_ptr<mapget::Feature>;
    em::class_<FeaturePtr>("Feature")
        .function(
            "id",
            std::function<std::string(FeaturePtr&)>(
                [](FeaturePtr& self) { return self->id()->toString(); }))
        .function(
            "geojson",
            std::function<std::string(FeaturePtr&)>(
                [](FeaturePtr& self) {
                    return self->toGeoJson().dump(4); }));

    ////////// TileFeatureLayer
    em::class_<mapget::TileFeatureLayer>("TileFeatureLayer")
        .smart_ptr<std::shared_ptr<mapget::TileFeatureLayer>>(
            "std::shared_ptr<mapget::TileFeatureLayer>")
        .function(
            "id",
            std::function<std::string(mapget::TileFeatureLayer const&)>(
                [](mapget::TileFeatureLayer const& self) { return self.id().toString(); }))
        .function(
            "tileId",
            std::function<uint64_t(mapget::TileFeatureLayer const&)>(
                [](mapget::TileFeatureLayer const& self) { return self.tileId().value_; }))
        .function(
            "center",
            std::function<em::val(mapget::TileFeatureLayer const&)>(
                [](mapget::TileFeatureLayer const& self)
                {
                    em::val result = em::val::object();
                    result.set("x", self.tileId().center().x);
                    result.set("y", self.tileId().center().y);
                    result.set("z", self.tileId().z());
                    return result;
                }))
        .function(
            "at",
            std::function<
                mapget::model_ptr<mapget::Feature>(mapget::TileFeatureLayer const&, int i)>(
                [](mapget::TileFeatureLayer const& self, int i)
                {
                    if (i < 0 || i >= self.numRoots()) {
                        mapget::log().error("TileFeatureLayer::at(): Index {} is oob.", i);
                    }
                    return self.at(i);
                }));

    ////////// FeatureLayerRenderer
    em::class_<FeatureLayerRenderer>("FeatureLayerRenderer")
        .constructor()
        .function("render", &FeatureLayerRenderer::render)
        .function("makeTileset", &FeatureLayerRenderer::makeTileset);

    ////////// TestDataProvider
    em::class_<TestDataProvider>("TestDataProvider")
        .constructor()
        .function("getTestLayer", &TestDataProvider::getTestLayer);

    ////////// TileLayerParser
    em::class_<TileLayerParser>("TileLayerParser")
        .constructor<SharedUint8Array const&>()
        .function(
            "onTileParsed",
            std::function<void(TileLayerParser&, em::val)>(
                [](TileLayerParser& self, em::val cb)
                { self.onTileParsed([cb](auto&& tile) { cb(tile); }); }))
        .function("parse", &TileLayerParser::parse)
        .function("reset", &TileLayerParser::reset)
        .function(
            "fieldDictOffsets",
            std::function<em::val(TileLayerParser&)>(
                [](TileLayerParser& self)
                {
                    auto result = em::val::object();
                    for (auto const& [nodeId, fieldId] : self.fieldDictOffsets())
                        result.set(nodeId, fieldId);
                    return result;
                }));

    ////////// Viewport TileID calculation
    em::function("getTileIds", &getTileIds);
    em::function("getTilePosition", &getTilePosition);

    ////////// Get full id of a TileFeatureLayer
    em::function("getTileFeatureLayerKey", &getTileFeatureLayerKey);
}
