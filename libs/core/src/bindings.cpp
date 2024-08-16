#include <emscripten/bind.h>
#include <cxxabi.h>

#include "aabb.h"
#include "buffer.h"
#include "cesium-interface/object.h"
#include "mapget/model/info.h"
#include "mapget/model/sourcedatalayer.h"
#include "simfil/model/nodes.h"
#include "visualization.h"
#include "parser.h"
#include "style.h"
#include "testdataprovider.h"
#include "inspection.h"
#include "geometry.h"
#include "search.h"
#include "sourcedata.hpp"

#include "cesium-interface/point-conversion.h"
#include "cesium-interface/primitive.h"
#include "simfil/exception-handler.h"

#include "mapget/log.h"

using namespace erdblick;
namespace em = emscripten;

namespace
{

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

uint32_t getNumTileIds(Viewport const& vp, int level) {
    Wgs84AABB aabb(Wgs84Point{vp.west, vp.south, .0}, {vp.width, vp.height});
    return aabb.numTileIds(level);
}

double getTilePriorityById(Viewport const& vp, uint64_t tileId) {
    return Wgs84AABB::radialDistancePrioFn({vp.camPosLon, vp.camPosLat}, vp.orientation)(tileId);
}

/** Get the center position for a mapget tile id in WGS84. */
mapget::Point getTilePosition(uint64_t tileIdValue) {
    return mapget::TileId(tileIdValue).center();
}

/** Get the level for a mapget tile id. */
uint16_t getTileLevel(uint64_t tileIdValue) {
    return mapget::TileId(tileIdValue).z();
}

/** Get the tile ID for the given level and position. */
uint64_t getTileIdFromPosition(double longitude, double latitude, uint16_t level) {
    return mapget::TileId::fromWgs84(longitude, latitude, level).value_;
}

/** Get the bounding box for a mapget tile id in WGS84. */
em::val getTileBox(uint64_t tileIdValue) {
    mapget::TileId tid(tileIdValue);
    return *JsValue::List({
        JsValue(tid.sw().x),
        JsValue(tid.sw().y),
        JsValue(tid.ne().x),
        JsValue(tid.ne().y)
    });
}

/**
 * Get the neighbor for a mapget tile id. Tile row will be clamped to [0, maxForLevel],
 * so a positive/negative wraparound is not possible. The tile id column will wrap at the
 * antimeridian.
 */
uint64_t getTileNeighbor(uint64_t tileIdValue, int32_t offsetX, int32_t offsetY) {
    return mapget::TileId(tileIdValue).neighbor(offsetX, offsetY).value_;
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

/** Get mapId, layerId and tileId of a MapTileKey. */
NativeJsValue parseTileFeatureLayerKey(std::string const& key) {
    auto tileKey = mapget::MapTileKey(key);
    return *JsValue::List({JsValue(tileKey.mapId_), JsValue(tileKey.layerId_), JsValue(tileKey.tileId_.value_)});
}

/** Create a test tile over New York. */
void generateTestTile(SharedUint8Array& output, TileLayerParser& parser) {
    auto tile = TestDataProvider(parser).getTestLayer(-74.0060, 40.7128, 9);
    std::stringstream blob;
    tile->write(blob);
    output.writeToArray(blob.str());
}

/** Create a test style. */
FeatureLayerStyle generateTestStyle() {
    return TestDataProvider::style();
}


/** Demangle a C++ type name. */
std::string demangle(const char* name) {
    int status = -4; // some arbitrary value to eliminate the compiler warning
    // enable c++11 by passing the flag -std=c++11 to g++
    std::unique_ptr<char, void(*)(void*)> res {
        abi::__cxa_demangle(name, NULL, NULL, &status),
        std::free
    };
    return (status==0) ? res.get() : name ;
}

/** Create a test style. */
void setExceptionHandler(em::val handler) {
    simfil::ThrowHandler::instance().set([handler](auto&& type, auto&& message){
        handler(demangle(type.c_str()), message);
    });
}

/**  Validate provided SIMFIL query */
void validateSimfil(const std::string &query) {
    auto simfilEnv = std::make_shared<simfil::Environment>(simfil::Environment::WithNewStringCache);
    simfil::compile(*simfilEnv, query, false);
}

}

EMSCRIPTEN_BINDINGS(erdblick)
{
    // Activate this to see a lot more output from the WASM lib.
    // mapget::log().set_level(spdlog::level::debug);

    ////////// LayerType
    em::enum_<mapget::LayerType>("LayerType")
        .value("FEATURES", mapget::LayerType::Features)
        .value("HEIGHTMAP", mapget::LayerType::Heightmap)
        .value("ORTHOiMAGE", mapget::LayerType::OrthoImage)
        .value("GLTF", mapget::LayerType::GLTF)
        .value("SOURCEDATA", mapget::LayerType::SourceData);

    ////////// ValueType
    em::enum_<InspectionConverter::ValueType>("ValueType")
        .value("NULL", InspectionConverter::ValueType::Null)
        .value("NUMBER", InspectionConverter::ValueType::Number)
        .value("STRING", InspectionConverter::ValueType::String)
        .value("BOOLEAN", InspectionConverter::ValueType::Boolean)
        .value("FEATUREID", InspectionConverter::ValueType::FeatureId)
        .value("SECTION", InspectionConverter::ValueType::Section)
        .value("ARRAY", InspectionConverter::ValueType::ArrayBit);

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

    ////////// Viewport
    em::value_object<Viewport>("Viewport")
        .field("south", &Viewport::south)
        .field("west", &Viewport::west)
        .field("width", &Viewport::width)
        .field("height", &Viewport::height)
        .field("camPosLon", &Viewport::camPosLon)
        .field("camPosLat", &Viewport::camPosLat)
        .field("orientation", &Viewport::orientation);

    ////////// FeatureStyleOptionType
    em::enum_<FeatureStyleOptionType>("FeatureStyleOptionType")
        .value("Bool", FeatureStyleOptionType::Bool);

    ////////// FeatureStyleOption
    em::value_object<FeatureStyleOption>("FeatureStyleOption")
        .field("label", &FeatureStyleOption::label_)
        .field("id", &FeatureStyleOption::id_)
        .field("type", &FeatureStyleOption::type_)
        .field("defaultValue", &FeatureStyleOption::defaultValue_) // Ensure correct binding/conversion for YAML::Node
        .field("description", &FeatureStyleOption::description_);

    ////////// FeatureLayerStyle
    em::register_vector<FeatureStyleOption>("FeatureStyleOptions");
    em::class_<FeatureLayerStyle>("FeatureLayerStyle").constructor<SharedUint8Array&>()
        .function("options", &FeatureLayerStyle::options, em::allow_raw_pointers());

    ////////// SourceDataAddressFormat
    em::enum_<mapget::TileSourceDataLayer::SourceDataAddressFormat>("SourceDataAddressFormat")
        .value("UNKNOWN", mapget::TileSourceDataLayer::SourceDataAddressFormat::Unknown)
        .value("BIT_RANGE", mapget::TileSourceDataLayer::SourceDataAddressFormat::BitRange);

    ////////// TileSourceDataLayer
    em::class_<mapget::TileSourceDataLayer>("TileSourceDataLayer")
        .smart_ptr<std::shared_ptr<mapget::TileSourceDataLayer>>(
            "std::shared_ptr<mapget::TileSourceDataLayer>")
        .function(
            "addressFormat",
            &mapget::TileSourceDataLayer::sourceDataAddressFormat)
        .function(
            "toJson",
            std::function<std::string(const mapget::TileSourceDataLayer&)>([](const mapget::TileSourceDataLayer& self) {
                return self.toJson().dump(2);
            }))
        .function(
            "toObject", std::function<em::val(const mapget::TileSourceDataLayer&)>([](const mapget::TileSourceDataLayer& self) {
                return *tileSourceDataLayerToObject(self);
            }));

    ////////// Feature
    using FeaturePtr = mapget::model_ptr<mapget::Feature>;
    em::class_<FeaturePtr>("Feature")
        .function(
            "isNull",
            std::function<bool(FeaturePtr& self)>(
                [](FeaturePtr& self) { return !self; }))
        .function(
            "id",
            std::function<std::string(FeaturePtr&)>(
                [](FeaturePtr& self) { return self->id()->toString(); }))
        .function(
            "geojson",
            std::function<std::string(FeaturePtr&)>(
                [](FeaturePtr& self) {
                    return self->toJson().dump(4); }))
        .function(
            "inspectionModel",
            std::function<em::val(FeaturePtr&)>(
                [](FeaturePtr& self) {
                    return *InspectionConverter().convert(self); }))
        .function(
            "center",
            std::function<mapget::Point(FeaturePtr&)>(
                [](FeaturePtr& self){
                    return geometryCenter(self->firstGeometry());
                }))
        .function(
            "boundingRadiusEndPoint",
            std::function<mapget::Point(FeaturePtr&)>(
                [](FeaturePtr& self){
                    return boundingRadiusEndPoint(self->firstGeometry());
                }))
        .function(
            "getGeometryType",
            std::function<mapget::GeomType(FeaturePtr&)>(
                [](FeaturePtr& self){
                    return getGeometryType(self->firstGeometry());
                }));

    ////////// GeomType
    em::enum_<mapget::GeomType>("GeomType")
        .value("Points", mapget::GeomType::Points)
        .value("Line", mapget::GeomType::Line)
        .value("Polygon", mapget::GeomType::Polygon)
        .value("Mesh", mapget::GeomType::Mesh);

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
            "numFeatures",
            std::function<uint32_t(mapget::TileFeatureLayer const&)>(
                [](mapget::TileFeatureLayer const& self) { return self.numRoots(); }))
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
            "find",
            std::function<
                mapget::model_ptr<mapget::Feature>(mapget::TileFeatureLayer const&, std::string const& id)>(
                [](mapget::TileFeatureLayer const& self, std::string const& id)
                {
                    return self.find(id);
                }))
        .function(
            "findFeatureIndex",
            std::function<

                int32_t(mapget::TileFeatureLayer const&, std::string, em::val)>(
                [](mapget::TileFeatureLayer const& self, std::string type, em::val idParts) -> int32_t
                {
                    auto idPartsKvp = JsValue(idParts).toKeyValuePairs();
                    if (auto result = self.find(type, idPartsKvp))
                        return result->addr().index();
                    return -1;
                }));
    em::register_vector<std::shared_ptr<mapget::TileFeatureLayer>>("TileFeatureLayers");

    ////////// Highlight Modes
    em::enum_<FeatureStyleRule::HighlightMode>("HighlightMode")
        .value("NO_HIGHLIGHT", FeatureStyleRule::NoHighlight)
        .value("HOVER_HIGHLIGHT", FeatureStyleRule::HoverHighlight)
        .value("SELECTION_HIGHLIGHT", FeatureStyleRule::SelectionHighlight);

    ////////// FeatureLayerVisualization
    em::class_<FeatureLayerVisualization>("FeatureLayerVisualization")
        .constructor<FeatureLayerStyle const&, em::val, em::val, FeatureStyleRule::HighlightMode, em::val>()
        .function("addTileFeatureLayer", &FeatureLayerVisualization::addTileFeatureLayer)
        .function("run", &FeatureLayerVisualization::run)
        .function("primitiveCollection", &FeatureLayerVisualization::primitiveCollection)
        .function("externalReferences", &FeatureLayerVisualization::externalReferences)
        .function("processResolvedExternalReferences", &FeatureLayerVisualization::processResolvedExternalReferences);

    ////////// FeatureLayerSearch
    em::class_<FeatureLayerSearch>("FeatureLayerSearch")
        .constructor<mapget::TileFeatureLayer&>()
        .function("filter", &FeatureLayerSearch::filter)
        .function("traceResults", &FeatureLayerSearch::traceResults);

    ////////// TileLayerMetadata
    em::value_object<TileLayerParser::TileLayerMetadata>("TileLayerMetadata")
        .field("id", &TileLayerParser::TileLayerMetadata::id)
        .field("nodeId", &TileLayerParser::TileLayerMetadata::nodeId)
        .field("mapName", &TileLayerParser::TileLayerMetadata::mapName)
        .field("layerName", &TileLayerParser::TileLayerMetadata::layerName)
        .field("tileId", &TileLayerParser::TileLayerMetadata::tileId)
        .field("numFeatures", &TileLayerParser::TileLayerMetadata::numFeatures);

    ////////// TileLayerParser
    em::class_<TileLayerParser>("TileLayerParser")
        .constructor<>()
        .function("setDataSourceInfo", &TileLayerParser::setDataSourceInfo)
        .function("getDataSourceInfo", &TileLayerParser::getDataSourceInfo)
        .function("getFieldDictOffsets", &TileLayerParser::getFieldDictOffsets)
        .function("getFieldDict", &TileLayerParser::getFieldDict)
        .function("addFieldDict", &TileLayerParser::addFieldDict)
        .function("readFieldDictUpdate", &TileLayerParser::readFieldDictUpdate)
        .function("readTileFeatureLayer", &TileLayerParser::readTileFeatureLayer)
        .function("readTileSourceDataLayer", &TileLayerParser::readTileSourceDataLayer)
        .function("readTileLayerMetadata", &TileLayerParser::readTileLayerMetadata)
        .function(
            "filterFeatureJumpTargets",
            std::function<
                NativeJsValue(TileLayerParser const&, std::string)>(
                [](TileLayerParser const& self, std::string input)
                {
                    auto result = self.filterFeatureJumpTargets(input);
                    auto convertedResult = JsValue::List();
                    for (auto const& r : result)
                        convertedResult.push(r.toJsValue());
                    return *convertedResult;
                }))
        .function("reset", &TileLayerParser::reset);

    ////////// Viewport TileID calculation
    em::function("getTileIds", &getTileIds);
    em::function("getNumTileIds", &getNumTileIds);
    em::function("getTilePriorityById", &getTilePriorityById);
    em::function("getTilePosition", &getTilePosition);
    em::function("getTileIdFromPosition", &getTileIdFromPosition);
    em::function("getTileBox", &getTileBox);
    em::function("getTileLevel", &getTileLevel);

    ////////// Get/Parse full id of a TileFeatureLayer
    em::function("getTileFeatureLayerKey", &getTileFeatureLayerKey);
    em::function("parseTileFeatureLayerKey", &parseTileFeatureLayerKey);

    ////////// Get tile id with vertical/horizontal offset
    em::function("getTileNeighbor", &getTileNeighbor);

    ////////// Get a test tile/style
    em::function("generateTestTile", &generateTestTile);
    em::function("generateTestStyle", &generateTestStyle);

    ////////// Set an exception handler
    em::function("setExceptionHandler", &setExceptionHandler);

    ////////// Validate SIMFIL query
    em::function("validateSimfilQuery", &validateSimfil);
}
