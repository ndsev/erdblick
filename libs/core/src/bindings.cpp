#include <emscripten/bind.h>

#include "aabb.h"
#include "buffer.h"
#include "visualization.h"
#include "stream.h"
#include "style.h"
#include "testdataprovider.h"

#include "cesium-interface/point-conversion.h"
#include "cesium-interface/primitive.h"

#include "mapget/log.h"

using namespace erdblick;
namespace em = emscripten;

/**
 * WGS84 Viewport Descriptor, which may be used with the
 * `getTileIds` function below.
 */
struct Viewport {
    double south = .0;       // The southern boundary of the viewport (degrees).
    double west = .0;        // The western boundary of the viewport (degrees).
    double width = .0;       // The width of the viewport (degrees).
    double height = .0;      // The height of the viewport (degrees).
    double camPosLon = .0;   // The longitude of the camera position (degrees).
    double camPosLat = .0;   // The latitude of the camera position (degrees).
    double orientation = .0; // The compass orientation of the camera (radians).
};

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
 * @param viewport The viewport descriptor for which tile ids are needed.
 * @param level The zoom level for which to get the tile IDs.
 * @param limit The maximum number of tile IDs to return.
 *
 * @return An emscripten value representing an array of prioritized tile IDs.
 */
em::val getTileIds(Viewport const& vp, int level, int limit)
{
    Wgs84AABB aabb(Wgs84Point{vp.west, vp.south, .0}, {vp.width, vp.height});
    if (aabb.numTileIds(level) > limit)
        // Create a size-limited AABB from the tile limit.
        aabb = Wgs84AABB::fromCenterAndTileLimit(Wgs84Point{vp.camPosLon, vp.camPosLat, .0}, limit, level);

    std::vector<std::pair<mapget::TileId, float>> prioritizedTileIds;
    prioritizedTileIds.reserve(limit);
    aabb.tileIdsWithPriority(
        level,
        prioritizedTileIds,
        Wgs84AABB::radialDistancePrioFn({vp.camPosLon, vp.camPosLat}, vp.orientation));

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

/** Get the full string key of a map tile feature layer. */
std::string getTileFeatureLayerKey(std::string const& mapId, std::string const& layerId, uint64_t tileId) {
    auto tileKey = mapget::MapTileKey();
    tileKey.layer_ = mapget::LayerType::Features;
    tileKey.mapId_ = mapId;
    tileKey.layerId_ = layerId;
    tileKey.tileId_ = tileId;
    return tileKey.toString();
}

/** Create a test tile over New York. */
std::shared_ptr<mapget::TileFeatureLayer> generateTestTile() {
    return TestDataProvider().getTestLayer(-74.0060, 40.7128, 9);
}

/** Create a test style. */
FeatureLayerStyle generateTestStyle() {
    return TestDataProvider::style();
}

EMSCRIPTEN_BINDINGS(erdblick)
{
    // Activate this to see a lot more output from the WASM lib.
    // mapget::log().set_level(spdlog::level::debug);

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
    em::register_vector<mapget::Point>("Points");

    ////////// Viewport
    em::value_object<Viewport>("Viewport")
        .field("south", &Viewport::south)
        .field("west", &Viewport::west)
        .field("width", &Viewport::width)
        .field("height", &Viewport::height)
        .field("camPosLon", &Viewport::camPosLon)
        .field("camPosLat", &Viewport::camPosLat)
        .field("orientation", &Viewport::orientation);

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

    ////////// FeatureLayerVisualization
    em::class_<FeatureLayerVisualization>("FeatureLayerVisualization")
        .constructor<FeatureLayerStyle const&, std::shared_ptr<mapget::TileFeatureLayer>>()
        .function("primitiveCollection", &FeatureLayerVisualization::primitiveCollection);

    ////////// TileLayerParser
    em::class_<TileLayerParser>("TileLayerParser")
        .constructor<>()
        .function("setDataSourceInfo", &TileLayerParser::setDataSourceInfo)
        .function("getFieldDictOffsets", &TileLayerParser::getFieldDictOffsets)
        .function("readFieldDictUpdate", &TileLayerParser::readFieldDictUpdate)
        .function("readTileFeatureLayer", &TileLayerParser::readTileFeatureLayer)
        .function("readTileLayerKeyAndTileId", &TileLayerParser::readTileLayerKeyAndTileId)
        .function("reset", &TileLayerParser::reset);

    ////////// Viewport TileID calculation
    em::function("getTileIds", &getTileIds);
    em::function("getTilePosition", &getTilePosition);

    ////////// Get full id of a TileFeatureLayer
    em::function("getTileFeatureLayerKey", &getTileFeatureLayerKey);

    ////////// Get a test tile/style
    em::function("generateTestTile", &generateTestTile);
    em::function("generateTestStyle", &generateTestStyle);
}
