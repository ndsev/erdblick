#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <emscripten/em_asm.h>
#include <emscripten/emscripten.h>
#include <malloc.h>
#include <stdlib.h>
#include <unistd.h>
#include <cxxabi.h>

#include <sanitizer/lsan_interface.h>
#include <sanitizer/asan_interface.h>

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
const char *__lsan_default_options() {
    return "verbosity=1:malloc_context_size=64";
}
const char *__asan_default_options() {
    return "verbosity=1:malloc_context_size=64:detect_container_overflow=0";
}
#endif
#endif

#include "aabb.h"
#include "buffer.h"
#include "interop/js-object.h"
#include "mapget/model/info.h"
#include "mapget/model/sourcedatalayer.h"
#include "mapget/model/simfilutil.h"
#include "simfil/model/nodes.h"
#include "visualization.h"
#include "parser.h"
#include "style.h"
#include "testdataprovider.h"
#include "inspection.h"
#include "geometry.h"
#include "search.h"
#include "layer.h"
#include "simfil/exception-handler.h"

#include "mapget/log.h"

using namespace erdblick;
namespace em = emscripten;

namespace
{

/**
 * Check for memory leaks -
 * see https://emscripten.org/docs/debugging/Sanitizers.html#memory-leaks
 */
void reportMemoryLeaks() {
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
    std::cout << "Running __lsan_do_recoverable_leak_check." << std::endl;
    __lsan_do_recoverable_leak_check();
#endif
#endif
}

/**
 * DisableLeakCheck -
 * see https://emscripten.org/docs/debugging/Sanitizers.html#memory-leaks
 */
void disableLeakCheck() {
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
    std::cout << "Running __lsan_disable." << std::endl;
    __lsan_disable();
#endif
#endif
}

/**
 * Enable leak check -
 * see https://emscripten.org/docs/debugging/Sanitizers.html#memory-leaks
 */
void enableLeakCheck() {
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
    std::cout << "Running __lsan_enable." << std::endl;
    __lsan_enable();
#endif
#endif
}

/**
 * Memory debug utilities -
 * see https://github.com/emscripten-core/emscripten/blob/main/test/core/test_mallinfo.c.
 */
size_t getTotalMemory() {
    return (size_t)EM_ASM_PTR(return HEAP8.length);
}

/** Same link as above. */
size_t getFreeMemory() {
    struct mallinfo i = mallinfo();
    uintptr_t totalMemory = getTotalMemory();
    uintptr_t dynamicTop = (uintptr_t)sbrk(0);
    return totalMemory - dynamicTop + i.fordblks;
}

int deckGeometryOutputAll()
{
    return static_cast<int>(DeckFeatureLayerVisualization::GeometryOutputMode::All);
}

int deckGeometryOutputPointsOnly()
{
    return static_cast<int>(DeckFeatureLayerVisualization::GeometryOutputMode::PointsOnly);
}

int deckGeometryOutputNonPointsOnly()
{
    return static_cast<int>(DeckFeatureLayerVisualization::GeometryOutputMode::NonPointsOnly);
}

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

namespace {

constexpr int MAX_TILE_RESULT_LIMIT = 1 << 20;
constexpr double PI = 3.14159265358979323846;
constexpr double RADIANS_TO_DEGREES = 180.0 / PI;
constexpr double CANONICAL_CAMERA_VERTICAL_FOV_RADIANS = 60.0 * PI / 180.0;
constexpr double CANONICAL_CAMERA_ASPECT_RATIO = 16.0 / 9.0;
constexpr double EARTH_RADIUS_METERS = 6378137.0;
constexpr double WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

double normalizeLongitude(double longitude)
{
    longitude = std::fmod(longitude + 180.0, 360.0);
    if (longitude < 0.0)
        longitude += 360.0;
    return longitude - 180.0;
}

bool isFiniteViewport(Viewport const& viewport)
{
    return std::isfinite(viewport.south) &&
        std::isfinite(viewport.west) &&
        std::isfinite(viewport.width) &&
        std::isfinite(viewport.height) &&
        std::isfinite(viewport.camPosLon) &&
        std::isfinite(viewport.camPosLat) &&
        std::isfinite(viewport.orientation) &&
        viewport.width >= 0.0 &&
        viewport.width <= 360.0 &&
        viewport.height >= 0.0 &&
        viewport.height <= 180.0;
}

Viewport canonicalViewportForAltitude(double altitudeMeters)
{
    const auto safeAltitude = std::max(1.0, altitudeMeters);
    const auto visibleHeightMeters = 2.0 * safeAltitude * std::tan(CANONICAL_CAMERA_VERTICAL_FOV_RADIANS * 0.5);
    const auto visibleWidthMeters = visibleHeightMeters * CANONICAL_CAMERA_ASPECT_RATIO;
    const auto heightDegrees = std::min(
        WEB_MERCATOR_MAX_LATITUDE * 2.0,
        visibleHeightMeters / EARTH_RADIUS_METERS * RADIANS_TO_DEGREES);
    const auto widthDegrees = std::min(
        360.0,
        visibleWidthMeters / EARTH_RADIUS_METERS * RADIANS_TO_DEGREES);
    return {
        -.5 * heightDegrees,
        -.5 * widthDegrees,
        widthDegrees,
        heightDegrees,
        .0,
        .0,
        .0
    };
}

}

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
    if (!isFiniteViewport(vp) || level < 0 || level > 62 || limit <= 0 || limit > MAX_TILE_RESULT_LIMIT)
        return em::val::array();

    auto west = normalizeLongitude(vp.west);
    auto camPosLon = normalizeLongitude(vp.camPosLon);
    Wgs84AABB aabb(Wgs84Point{west, vp.south, .0}, {vp.width, vp.height});
    if (aabb.numTileIds(level) > limit)
        // Create a size-limited AABB from the tile limit.
        aabb = Wgs84AABB::fromCenterAndTileLimit(Wgs84Point{camPosLon, vp.camPosLat, .0}, limit, level);

    std::vector<std::pair<mapget::TileId, float>> prioritizedTileIds;
    prioritizedTileIds.reserve(limit);
    aabb.tileIdsWithPriority(
        level,
        prioritizedTileIds,
        Wgs84AABB::radialDistancePrioFn({camPosLon, vp.camPosLat}, vp.orientation));

    std::sort(
        prioritizedTileIds.begin(),
        prioritizedTileIds.end(),
        [](auto const& l, auto const& r)
        {
            if (l.second != r.second)
                return l.second < r.second;
            return l.first.value_ < r.first.value_;
        });

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
    if (!isFiniteViewport(vp) || level < 0 || level > 62)
        return 0;
    Wgs84AABB aabb(Wgs84Point{normalizeLongitude(vp.west), vp.south, .0}, {vp.width, vp.height});
    return aabb.numTileIds(level);
}

/**
 * Returns the tile count for a deterministic canonical camera used for fidelity policy decisions.
 *
 * The canonical camera is fixed at the equator, points straight down, and uses a 60-degree
 * vertical field of view with a 16:9 aspect ratio. Only the altitude varies.
 */
uint32_t getNumTileIdsForCanonicalCamera(double altitudeMeters, int level)
{
    if (!std::isfinite(altitudeMeters) || altitudeMeters < 0.0 || level < 0 || level > 62)
        return 0;
    return getNumTileIds(canonicalViewportForAltitude(altitudeMeters), level);
}

double getTilePriorityById(Viewport const& vp, uint64_t tileId) {
    if (!isFiniteViewport(vp))
        return 0.0;
    return Wgs84AABB::radialDistancePrioFn(
        {normalizeLongitude(vp.camPosLon), vp.camPosLat},
        vp.orientation)(tileId);
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
 * Get the bounding box for a mapget corner tile id in WGS84.
 * A corner tile box is the original tile box, shifted by half
 * the width and height on both axes, so it sits squarely at
 * the intersection point of four tiles.
 */
em::val getCornerTileBox(uint64_t tileIdValue) {
    mapget::TileId tid(tileIdValue);
    auto halfSize = tid.size() * mapget::Point(.5, -.5);
    auto sw = tid.sw() + halfSize;
    auto ne = tid.ne() + halfSize;
    return *JsValue::List({
        JsValue(sw.x),
        JsValue(sw.y),
        JsValue(ne.x),
        JsValue(ne.y)
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
    return mapget::MapTileKey(mapget::LayerType::Features, mapId, layerId, tileId).toString();
}

/** Get the full string key of a map SourceData layer. */
std::string getSourceDataLayerKey(std::string const& mapId, std::string const& layerId, uint64_t tileId) {
    return mapget::MapTileKey(mapget::LayerType::SourceData, mapId, layerId, tileId).toString();
}

/** Get mapId, layerId, tileId and stage of a MapTileKey. */
NativeJsValue parseMapTileKey(std::string const& key) {
    auto tileKey = mapget::MapTileKey(key);
    return *JsValue::List({
        JsValue(tileKey.mapId_),
        JsValue(tileKey.layerId_),
        JsValue(tileKey.tileId_.value_),
        JsValue(tileKey.stage_)
    });
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
    auto env = mapget::makeEnvironment(simfil::Environment::WithNewStringCache);
    simfil::compile(*env, query, false, true);
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
        .value("Bool", FeatureStyleOptionType::Bool)
        .value("Color", FeatureStyleOptionType::Color)
        .value("String", FeatureStyleOptionType::String);

    ////////// FeatureStyleOption
    em::value_object<FeatureStyleOption>("FeatureStyleOption")
        .field("label", &FeatureStyleOption::label_)
        .field("id", &FeatureStyleOption::id_)
        .field("type", &FeatureStyleOption::type_)
        .field("defaultValue", &FeatureStyleOption::defaultValue_) // Ensure correct binding/conversion for YAML::Node
        .field("description", &FeatureStyleOption::description_)
        .field("internal", &FeatureStyleOption::internal_);

    ////////// FeatureLayerStyle
    em::register_vector<FeatureStyleOption>("FeatureStyleOptions");
    em::class_<FeatureLayerStyle>("FeatureLayerStyle").constructor<SharedUint8Array&>()
        .function("options", &FeatureLayerStyle::options, em::allow_raw_pointers())
        .function("name", &FeatureLayerStyle::name)
        .function("hasLayerAffinity", &FeatureLayerStyle::hasLayerAffinity)
        .function("defaultEnabled", &FeatureLayerStyle::defaultEnabled)
        .function("minimumStage", &FeatureLayerStyle::minimumStage)
        .function("hasExplicitLowFidelityRules", &FeatureLayerStyle::hasExplicitLowFidelityRules)
        .function("hasRelationRules", &FeatureLayerStyle::hasRelationRules)
        .function("supportsHighlightMode", &FeatureLayerStyle::supportsHighlightMode);

    ////////// SourceDataAddressFormat
    em::enum_<mapget::TileSourceDataLayer::SourceDataAddressFormat>("SourceDataAddressFormat")
        .value("UNKNOWN", mapget::TileSourceDataLayer::SourceDataAddressFormat::Unknown)
        .value("BIT_RANGE", mapget::TileSourceDataLayer::SourceDataAddressFormat::BitRange);

    ////////// TileSourceDataLayer
    em::class_<TileSourceDataLayer>("TileSourceDataLayer")
        .function("addressFormat", &TileSourceDataLayer::addressFormat)
        .function("toJson", &TileSourceDataLayer::toJson)
        .function("toObject", &TileSourceDataLayer::toObject)
        .function("getError", &TileSourceDataLayer::getError);

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
                    return self->firstGeometry().geomType_;
                }));

    ////////// GeomType
    em::enum_<mapget::GeomType>("GeomType")
        .value("Points", mapget::GeomType::Points)
        .value("Line", mapget::GeomType::Line)
        .value("Polygon", mapget::GeomType::Polygon)
        .value("Mesh", mapget::GeomType::Mesh);

    ////////// TileFeatureLayer
    em::class_<TileFeatureLayer>("TileFeatureLayer")
        .function("id", &TileFeatureLayer::id)
        .function("stage", &TileFeatureLayer::stage)
        .function("tileId", &TileFeatureLayer::tileId)
        .function("numFeatures", &TileFeatureLayer::numFeatures)
        .function("numVertices", &TileFeatureLayer::numVertices)
        .function("center", &TileFeatureLayer::center)
        .function("find", &TileFeatureLayer::find)
        .function("attachOverlay", &TileFeatureLayer::attachOverlay)
        .function("featureIdByIndex", &TileFeatureLayer::featureIdByIndex)
        .function("featureByIndex", &TileFeatureLayer::featureByIndex)
        .function("findFeatureIndex", &TileFeatureLayer::findFeatureIndex);

    ////////// Highlight Modes
    em::enum_<FeatureStyleRule::HighlightMode>("HighlightMode")
        .value("NO_HIGHLIGHT", FeatureStyleRule::NoHighlight)
        .value("HOVER_HIGHLIGHT", FeatureStyleRule::HoverHighlight)
        .value("SELECTION_HIGHLIGHT", FeatureStyleRule::SelectionHighlight);

    em::enum_<FeatureStyleRule::Fidelity>("RuleFidelity")
        .value("ANY", FeatureStyleRule::AnyFidelity)
        .value("HIGH", FeatureStyleRule::HighFidelity)
        .value("LOW", FeatureStyleRule::LowFidelity);

    ////////// DeckFeatureLayerVisualization
    em::class_<DeckFeatureLayerVisualization>("DeckFeatureLayerVisualization")
        .constructor<int, std::string, FeatureLayerStyle const&, em::val, em::val, FeatureStyleRule::HighlightMode, FeatureStyleRule::Fidelity, int, int, int, em::val>()
        .class_function("GEOMETRY_OUTPUT_ALL", &deckGeometryOutputAll)
        .class_function("GEOMETRY_OUTPUT_POINTS_ONLY", &deckGeometryOutputPointsOnly)
        .class_function("GEOMETRY_OUTPUT_NON_POINTS_ONLY", &deckGeometryOutputNonPointsOnly)
        .function("setGeometryOutputMode", &DeckFeatureLayerVisualization::setGeometryOutputMode)
        .function("geometryOutputMode", &DeckFeatureLayerVisualization::geometryOutputMode)
        .function("setLowFiOutputLod", &DeckFeatureLayerVisualization::setLowFiOutputLod)
        .function("availableLowFiLodsRaw", &DeckFeatureLayerVisualization::availableLowFiLodsRaw)
        .function(
            "addTileFeatureLayer",
            std::function<void(DeckFeatureLayerVisualization&, TileFeatureLayer const&)>(
                [](DeckFeatureLayerVisualization& self, TileFeatureLayer const& tile)
                {
                    self.addTileFeatureLayer(tile);
                }))
        .function(
            "run",
            std::function<void(DeckFeatureLayerVisualization&)>(
                [](DeckFeatureLayerVisualization& self)
                {
                    self.FeatureLayerVisualizationBase::run();
                }))
        .function("abiVersion", &DeckFeatureLayerVisualization::abiVersion)
        .function("pointPositionsRaw", &DeckFeatureLayerVisualization::pointPositionsRaw)
        .function("pointColorsRaw", &DeckFeatureLayerVisualization::pointColorsRaw)
        .function("pointRadiiRaw", &DeckFeatureLayerVisualization::pointRadiiRaw)
        .function("pointFeatureIdsRaw", &DeckFeatureLayerVisualization::pointFeatureIdsRaw)
        .function("pointBillboardsRaw", &DeckFeatureLayerVisualization::pointBillboardsRaw)
        .function("surfacePositionsRaw", &DeckFeatureLayerVisualization::surfacePositionsRaw)
        .function("surfaceStartIndicesRaw", &DeckFeatureLayerVisualization::surfaceStartIndicesRaw)
        .function("surfaceColorsRaw", &DeckFeatureLayerVisualization::surfaceColorsRaw)
        .function("surfaceFeatureIdsRaw", &DeckFeatureLayerVisualization::surfaceFeatureIdsRaw)
        .function("pathPositionsRaw", &DeckFeatureLayerVisualization::pathPositionsRaw)
        .function("pathStartIndicesRaw", &DeckFeatureLayerVisualization::pathStartIndicesRaw)
        .function("pathColorsRaw", &DeckFeatureLayerVisualization::pathColorsRaw)
        .function("pathWidthsRaw", &DeckFeatureLayerVisualization::pathWidthsRaw)
        .function("pathFeatureIdsRaw", &DeckFeatureLayerVisualization::pathFeatureIdsRaw)
        .function("pathBillboardsRaw", &DeckFeatureLayerVisualization::pathBillboardsRaw)
        .function("pathDashArrayRaw", &DeckFeatureLayerVisualization::pathDashArrayRaw)
        .function("pathDashOffsetsRaw", &DeckFeatureLayerVisualization::pathDashOffsetsRaw)
        .function("pathCoordinateOriginRaw", &DeckFeatureLayerVisualization::pathCoordinateOriginRaw)
        .function("arrowPositionsRaw", &DeckFeatureLayerVisualization::arrowPositionsRaw)
        .function("arrowStartIndicesRaw", &DeckFeatureLayerVisualization::arrowStartIndicesRaw)
        .function("arrowColorsRaw", &DeckFeatureLayerVisualization::arrowColorsRaw)
        .function("arrowWidthsRaw", &DeckFeatureLayerVisualization::arrowWidthsRaw)
        .function("arrowFeatureIdsRaw", &DeckFeatureLayerVisualization::arrowFeatureIdsRaw)
        .function("arrowBillboardsRaw", &DeckFeatureLayerVisualization::arrowBillboardsRaw)
        .function("mergedPointFeatures", &DeckFeatureLayerVisualization::mergedPointFeatures)
        .function("externalRelationReferences", &DeckFeatureLayerVisualization::externalRelationReferences)
        .function(
            "processResolvedExternalReferences",
            &DeckFeatureLayerVisualization::processResolvedExternalReferences);

    ////////// FeatureLayerSearch
    em::class_<FeatureLayerSearch>("FeatureLayerSearch")
        .constructor<TileFeatureLayer&>()
        .function("filter", &FeatureLayerSearch::filter)
        .function("complete", &FeatureLayerSearch::complete)
        .function("diagnostics", &FeatureLayerSearch::diagnostics);

    ////////// TileLayerMetadata
    em::value_object<TileLayerParser::TileLayerMetadata>("TileLayerMetadata")
        .field("id", &TileLayerParser::TileLayerMetadata::id)
        .field("nodeId", &TileLayerParser::TileLayerMetadata::nodeId)
        .field("mapName", &TileLayerParser::TileLayerMetadata::mapName)
        .field("layerName", &TileLayerParser::TileLayerMetadata::layerName)
        .field("tileId", &TileLayerParser::TileLayerMetadata::tileId)
        .field("stage", &TileLayerParser::TileLayerMetadata::stage)
        .field("legalInfo", &TileLayerParser::TileLayerMetadata::legalInfo)
        .field("error", &TileLayerParser::TileLayerMetadata::error)
        .field("numFeatures", &TileLayerParser::TileLayerMetadata::numFeatures)
        .field("scalarFields", &TileLayerParser::TileLayerMetadata::scalarFields);

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
    em::function("getNumTileIdsForCanonicalCamera", &getNumTileIdsForCanonicalCamera);
    em::function("getTilePriorityById", &getTilePriorityById);
    em::function("getTilePosition", &getTilePosition);
    em::function("getTileIdFromPosition", &getTileIdFromPosition);
    em::function("getTileBox", &getTileBox);
    em::function("getCornerTileBox", &getCornerTileBox);
    em::function("getTileLevel", &getTileLevel);

    ////////// Get/Parse full id of a TileFeatureLayer
    em::function("getTileFeatureLayerKey", &getTileFeatureLayerKey);
    em::function("getSourceDataLayerKey", &getSourceDataLayerKey);
    em::function("parseMapTileKey", &parseMapTileKey);

    ////////// Get tile id with vertical/horizontal offset
    em::function("getTileNeighbor", &getTileNeighbor);

    ////////// Get a test tile/style
    em::function("generateTestTile", &generateTestTile);
    em::function("generateTestStyle", &generateTestStyle);

    ////////// Set an exception handler
    em::function("setExceptionHandler", &setExceptionHandler);

    ////////// Validate SIMFIL query
    em::function("validateSimfilQuery", &validateSimfil);

    ////////// Memory utilities
    em::function("getTotalMemory", &getTotalMemory);
    em::function("getFreeMemory", &getFreeMemory);
    em::function("reportMemoryLeaks", &reportMemoryLeaks);
    em::function("enableLeakCheck", &enableLeakCheck);
    em::function("disableLeakCheck", &disableLeakCheck);
}
