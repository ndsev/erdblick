#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include <fstream>
#include <numbers>
#include "erdblick/drawing.h"
#include "erdblick/parser.h"
#include "erdblick/style-filter-plan.h"
#include "erdblick/subset-renderer.h"
#include "erdblick/gpu-render-packet.h"

using namespace erdblick;
using Json = nlohmann::json;

TEST_CASE("Coordinate import becomes GeoJSON with units, identity and rollback", "[drawing]")
{
    DrawingSource source("virtual-test");
    std::string text = "\xef\xbb\xbf 11\t48 -12.5 \"Über gate\"\r\n12 49 \"123 gate\"\r\n\n";
    source.replace(drawingCoordinatesToGeoJson(text));
    auto rows = Json::parse(source.rows(0, 100));
    REQUIRE(rows.size() == 2);
    CHECK(rows[0]["heightCm"] == -12.5);
    CHECK(rows[0]["position"][2] == -0.125);
    CHECK(rows[1]["heightCm"] == 0);
    CHECK(rows[1]["description"] == "123 gate");
    CHECK(source.source() == drawingCoordinatesToGeoJson(text));
    auto oldModel = source.model();
    CHECK_THROWS(source.replace(drawingCoordinatesToGeoJson(text + "NaN 4 bad\n")));
    CHECK(source.model() == oldModel);
    CHECK(source.source() == drawingCoordinatesToGeoJson(text));
    source.editDescription(rows[0]["id"], "New \"description\"\nUnicode ✓");
    auto edited = Json::parse(source.rows(0, 100));
    CHECK(edited[0]["id"] == rows[0]["id"]);
    CHECK(edited[0]["description"] == "New \"description\"\nUnicode ✓");
    CHECK(Json::parse(source.source())["features"][1]["properties"]["description"] == "123 gate");
    source.append(13, 50, "new point");
    CHECK(Json::parse(source.rows(0, 100))[2]["heightCm"] == 0);
    DrawingSource reopened("virtual-reopened");
    reopened.replace(source.source());
    CHECK(Json::parse(reopened.rows(0, 100))[0]["description"] == edited[0]["description"]);
}

TEST_CASE("Join persists a polygon in GeoJSON in file order", "[drawing]")
{
    DrawingSource source("virtual-join");
    source.replace(drawingCoordinatesToGeoJson("10 10 a\n11 10 b\n11 11 c\n10 11 d\n"));
    auto const text = source.source();
    auto rows = Json::parse(source.rows(0, 10));
    source.join(Json::array({rows[3]["id"], rows[1]["id"], rows[0]["id"]}).dump());
    REQUIRE(source.model()->size() == 5);
    CHECK(source.source() != text);
    DrawingSource reloaded("joined-reload");
    reloaded.replace(source.source());
    CHECK(Json::parse(reloaded.describe())["joined"] == true);
    CHECK(reloaded.model()->size() == 5);
    auto geometry = source.model()->toJson()["features"][4]["geometry"];
    CHECK(geometry["coordinates"][0].front() == geometry["coordinates"][0].back());
    CHECK_THROWS(source.join(Json::array({rows[0]["id"], rows[1]["id"]}).dump()));
    CHECK(source.model()->size() == 5);
    source.join("[]");
    CHECK(source.model()->size() == 4);
    source.replace(drawingCoordinatesToGeoJson("10 10 a\n11 11 b\n10 11 c\n11 10 d\n"));
    rows = Json::parse(source.rows(0, 10));
    CHECK_THROWS(source.join(Json::array({rows[0]["id"], rows[1]["id"], rows[2]["id"], rows[3]["id"]}).dump()));
}

TEST_CASE("Recovery preserves surviving and retired record identities", "[drawing]")
{
    DrawingSource original("drawing-recovery");
    original.replace(drawingCoordinatesToGeoJson("0 0 a\n1 1 b\n2 2 c\n"));
    original.replace(drawingCoordinatesToGeoJson("2 2 c\n0 0 a\n"));
    auto const before = Json::parse(original.rows(0, 10));
    CHECK(before[0]["id"] == "3");
    CHECK(before[1]["id"] == "1");
    DrawingSource recovered("drawing-recovery");
    CHECK_THROWS(recovered.restore(original.source(), R"({"ids":["1","1"],"nextId":"4"})"));
    CHECK_THROWS(recovered.restore(original.source(), R"({"ids":["1"],"nextId":"4"})"));
    recovered.restore(original.source(), original.checkpoint());
    CHECK(Json::parse(recovered.rows(0, 10)) == before);
    recovered.append(3, 3, "new");
    CHECK(Json::parse(recovered.rows(0, 10))[2]["id"] == "4");
}

TEST_CASE("Standard GeoJSON remains inert and roundtrips its original source", "[drawing]")
{
    DrawingSource source("virtual-json");
    std::string text = R"({
      "type":"Feature","id":9007199254740993,"typeId":"malicious-native-type",
      "properties":{"layer":"ordinary data","nested":{"$mapgetRelation":42},
        "tagged":{"_bytes":true,"hex":"not hex"}, "multi":{"_multimap":true,"value":3},
        "mask":{"_bitmask":true,"bits":"abc","schema":"none","typeId":1}},
      "foreign":{"keep":true},
      "geometry":{"type":"GeometryCollection","geometries":[
        {"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[11,48,2]}]},
        {"type":"MultiLineString","coordinates":[[[10,47],[11,48]],[[12,49],[13,50]]]},
        {"type":"MultiPolygon","coordinates":[[[[10,10],[12,10],[12,12],[10,12],[10,10]],
            [[10.5,10.5],[10.5,11],[11,11],[11,10.5],[10.5,10.5]]]]}
      ]}})";
    source.replace(text);
    CHECK(source.source() == text);
    REQUIRE(source.model()->size() == 1);
    auto data = source.model()->toJson()["features"][0]["properties"];
    CHECK(data["user"]["layer"] == "ordinary data");
    CHECK(data["user"]["nested"]["$mapgetRelation"] == 42);
    CHECK(data["user"]["tagged"]["hex"] == "not hex");
    CHECK(data["user"]["multi"]["value"] == 3);
    CHECK(data["user"]["mask"]["schema"] == "none");
    CHECK(Json::parse(source.rows(0, 10))[0]["externalId"] == "9007199254740993");
    CHECK_THROWS(source.replace(R"({"type":"Point","type":"Point","coordinates":[1,2]})"));
    CHECK_THROWS(source.replace(R"({"type":"Point","coordinates":[1,2,3,4]})"));
    CHECK(source.source() == text);
    source.replace(R"({"type":"Feature","properties":null,"geometry":null})");
    CHECK(source.model()->size() == 1);
    CHECK(Json::parse(source.describe())["bounds"].is_null());
}

TEST_CASE("Virtual objects pass through native schema filtering and packet rendering", "[drawing]")
{
    DrawingSource source("virtual-pipeline");
    source.replace(drawingCoordinatesToGeoJson("11 48 123 \"visible\"\n12 49 0 \"hidden\"\n"));
    FeatureLayerStyle style(SharedUint8Array(R"(
name: Drawing fixture
version: 2
rules:
  - geometry: point
    filter: attributes.drawing.description == "visible"
    color: "#ff8800"
    width: 8
)"));
    INFO(style.validationReport().dump());
    REQUIRE(style.isValid());
    auto plan = planStyleFilter(style, *source.model()->layerInfo(), FeatureStyleRule::NoHighlight, 7);
    REQUIRE(plan.valid);
    SharedUint8Array subset, schema, dictionary;
    source.filter(Json{{"filterId", "local"}, {"generation", 1}, {"channels", plan.toJsValue()["channels"]}}.dump(), subset);
    source.schema(schema);
    source.dictionary(dictionary);
    auto metadata = Json::parse(source.describe())["metadata"];
    TileLayerParser parser;
    parser.installMapSchema(schema, metadata["schemaId"]);
    parser.setDataSourceInfo(SharedUint8Array(Json::array({metadata}).dump()));
    parser.addFieldDict(dictionary);
    auto decoded = parser.readTileSubsetLayer(subset);
    INFO(decoded.toJson());
    INFO(source.model()->toJson().dump());
    CHECK(decoded.numEntries() == 1);
    CHECK(decoded.partition()["kind"] == "object");
    TileSubsetLayerRenderer renderer(0, "drawing", style, FeatureStyleRule::NoHighlight, 7);
    renderer.addTileSubsetContribution(decoded, 1, 0, 1, 0, 1);
    renderer.run();
    CHECK_FALSE(renderer.renderPacketBytes().empty());
    SharedUint8Array snapshot;
    auto rows = Json::parse(source.rows(0, 10));
    source.snapshot(Json::array({rows[0]["featureId"]}).dump(), snapshot);
    auto inspection = parser.readTileFeatureLayer(snapshot);
    CHECK(inspection.numFeatures() == 1);
}

TEST_CASE("Measurement uses ellipsoidal geodesics and continuous dateline render paths", "[drawing]")
{
    CHECK(drawingDistance(0, 0, 1, 0) == Catch::Approx(111319.490793).margin(0.001));
    CHECK(drawingDistance(0, 0, 0, 1) == Catch::Approx(110574.388558).margin(0.001));
    CHECK(drawingDistance(174.81, -41.32, -5.50, 40.96) == Catch::Approx(19959679.267).margin(0.001));
    CHECK(drawingDistance(180, 0, -180, 0) == 0);
    CHECK(drawingDistance(1, 90, 80, 90) == 0);
    CHECK_THROWS(drawingDistance(0, 91, 0, 0));
    auto preview = Json::parse(drawingToolGeoJson(R"({"points":[[0,0],[179.9,0]],"maxSegmentLength":100})", true));
    for (auto const& feature : preview["features"])
        if (feature["id"] == "path") CHECK(feature["geometry"]["coordinates"].size() == 2049);
    CHECK_THROWS(drawingToolGeoJson(R"({"points":[[0,0],[1,1],[2,2]]})", true));
    DrawingSource source("virtual-measurement");
    source.replace(drawingToolGeoJson(R"({"points":[[179,0],[-179,0]]})", false));
    auto const features = Json::parse(source.source())["features"];
    CHECK(features.size() == 5); // Clicked points, segment label, path, total label.
    for (auto const& feature : features) {
        if (feature["id"] != "path") continue;
        auto const& geometry = feature["geometry"];
        CHECK(geometry["type"] == "MultiLineString");
        REQUIRE(geometry["coordinates"].size() == 2);
        for (auto const& line : geometry["coordinates"]) {
            for (size_t i = 1; i < line.size(); ++i) {
                CHECK(std::abs(line[i][0].get<double>()) <= 180);
                CHECK(std::abs(line[i][0].get<double>() - line[i - 1][0].get<double>()) < 1);
            }
        }
    }
    DrawingSource reopened("measurement-reopened");
    CHECK_NOTHROW(reopened.replace(source.source()));
}

TEST_CASE("Drawing metrics and snapping share WGS84 geodesics", "[drawing]")
{
    auto square = Json::parse(drawingMetrics("[[0,0],[1,0],[1,1],[0,1]]"));
    CHECK(square["areaSquareMeters"].get<double>() == Catch::Approx(12308778361.46945).margin(0.1));
    CHECK(Json::parse(drawingMetrics("[[0,1],[0,0],[1,0]]"))["angleDegrees"] == 90);
    auto snapped = Json::parse(drawingSnap(0, 0, 1, .8));
    CHECK(drawingDistance(0, 0, snapped[0], snapped[1]) == Catch::Approx(drawingDistance(0, 0, 1, .8)).margin(1e-6));
    auto angle = Json::parse(drawingMetrics(Json::array({Json::array({0,1}),Json::array({0,0}),snapped}).dump()));
    CHECK(angle["angleDegrees"].get<double>() == Catch::Approx(45).margin(1e-8));
    CHECK_THROWS(drawingMetrics("[[0,91]]"));
    CHECK_THROWS(drawingSnap(0, 0, 181, 0));
}

TEST_CASE("Drawing tools produce persistent geometry, colors and measurement labels", "[drawing]")
{
    for (auto mode : {"distance", "area", "angle", "point", "polygon", "pen", "ellipse"}) {
        Json request = {{"mode",mode},{"color","#123abc"},{"unit","miles"},
            {"points",Json::array({Json::array({0,0}),Json::array({1,1})})}};
        if (std::string(mode) == "area" || std::string(mode) == "polygon" || std::string(mode) == "angle") request["points"].push_back({2,0});
        auto text = drawingToolGeoJson(request.dump(), false);
        DrawingSource source("drawing-tool-test");
        CHECK_NOTHROW(source.replace(text));
        auto collection = Json::parse(text);
        bool shape = false, labels = false;
        for (auto const& feature : collection["features"]) {
            CHECK(feature["properties"]["color"] == "#123abc");
            shape |= feature["geometry"]["type"] == "Polygon";
            labels |= feature["properties"]["role"] == "measurement-label";
        }
        CHECK(shape == (std::string(mode) == "area" || std::string(mode) == "polygon" || std::string(mode) == "ellipse"));
        CHECK(labels == (std::string(mode) == "area" || std::string(mode) == "distance" || std::string(mode) == "angle"));
    }
    auto crossing = Json::parse(drawingToolGeoJson(R"({"mode":"area","points":[[179,0],[-179,0],[-179,1],[179,1]]})", false));
    for (auto const& feature : crossing["features"])
        if (feature["id"] == "shape") CHECK(feature["geometry"]["type"] == "MultiPolygon");
    CHECK_THROWS(drawingToolGeoJson(R"({"mode":"unknown","points":[]})", false));
}


TEST_CASE("Bundled drawing style is valid for coordinate, imported and measurement roles", "[drawing]")
{
    std::ifstream input(std::string(ERDBLICK_TEST_STYLES_DIRECTORY) + "/drawing-style.yaml");
    REQUIRE(input.good());
    std::string text((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    FeatureLayerStyle style{SharedUint8Array(text)};
    INFO(style.validationReport().dump());
    REQUIRE(style.isValid());
    REQUIRE(style.validationReport()["valid"] == true);
    DrawingSource source("drawing-style-test");
    for (auto const& data : {
        drawingCoordinatesToGeoJson("0 0 a\n1 0 b\n1 1 c\n"),
        std::string(R"({"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[0,0],[1,1]]}})"),
        drawingToolGeoJson(R"({"points":[[0,0],[1,0]],"color":"#12ab78"})", false)
    }) {
        source.replace(data);
        auto const plan = planStyleFilter(style, *source.model()->layerInfo(), FeatureStyleRule::NoHighlight, 7);
        REQUIRE(plan.valid);
        SharedUint8Array subset, schema, dictionary;
        auto request = Json{{"filterId", "local"}, {"generation", 1}, {"channels", plan.toJsValue()["channels"]},
            {"bindings", {{"drawingColor", "#20a6d2"}, {"measurementColor", "#ff8a24"}}}};
        source.filter(request.dump(), subset);
        source.schema(schema); source.dictionary(dictionary);
        auto metadata = Json::parse(source.describe())["metadata"];
        TileLayerParser parser;
        parser.installMapSchema(schema, metadata["schemaId"]);
        parser.setDataSourceInfo(SharedUint8Array(Json::array({metadata}).dump())); parser.addFieldDict(dictionary);
        auto decoded = parser.readTileSubsetLayer(subset);
        INFO(decoded.toJson());
        TileSubsetLayerRenderer renderer(0, "drawing", style, FeatureStyleRule::NoHighlight, 7);
        renderer.addTileSubsetContribution(decoded, 1, 0, 1, 0, 1); renderer.run();
        auto packet = GpuRenderPacketCodec::validate(renderer.renderPacketBytes());
        CHECK(packet.streamCount > 0);
        CHECK(packet.labelCount == (data.find("measurement-label") == std::string::npos ? 0 : 2));
    }
}

TEST_CASE("Local filter grouping uses mapget model semantics", "[drawing]")
{
    DrawingSource source("drawing-groups-test");
    source.replace(drawingCoordinatesToGeoJson("0 0 a\n0.01 0 b\n1 1 c\n"));
    auto rows = Json::parse(source.rows(0, 10));
    Json channel = {{"channelId", "grouped"}, {"scope", "feature"}, {"geometryTypes", 1},
        {"group", {{"kind", "point-grid"}, {"origin", {0, 0, 0}}, {"cellSize", {0.1, 0.1, 1}}}}};
    SharedUint8Array subset, schema, dictionary;
    Json request = {{"filterId", "groups"}, {"generation", 1}, {"channels", Json::array({channel})}};
    CHECK_NOTHROW(source.filter(request.dump(), subset));
    source.schema(schema); source.dictionary(dictionary);
    auto metadata = Json::parse(source.describe())["metadata"];
    TileLayerParser parser;
    parser.installMapSchema(schema, metadata["schemaId"]);
    parser.setDataSourceInfo(SharedUint8Array(Json::array({metadata}).dump())); parser.addFieldDict(dictionary);
    CHECK(parser.readTileSubsetLayer(subset).numEntries() == 2);
    request["channels"][0].erase("group");
    request["roots"] = Json::array({{{"featureId", rows[2]["featureId"]}}});
    source.filter(request.dump(), subset);
    // Relation traversal roots do not restrict ordinary feature channels.
    CHECK(parser.readTileSubsetLayer(subset).numEntries() == 3);
    request["channels"][0]["scope"] = "relation";
    CHECK_THROWS(source.filter(request.dump(), subset));
}

TEST_CASE("Input limits fail transactionally before publishing a source", "[drawing]")
{
    DrawingSource source("drawing-limits");
    source.replace(drawingCoordinatesToGeoJson("0 0 original\n"));
    CHECK_THROWS(source.replace(std::string(32U * 1024U * 1024U + 1, ' ')));
    CHECK_THROWS(source.replace(std::string("0 0 ") + char(0xff)));
    std::string manyRows;
    for (size_t i = 0; i < 100001; ++i) manyRows += "0 0 row\n";
    CHECK_THROWS(source.replace(drawingCoordinatesToGeoJson(manyRows)));
    CHECK(source.source() == drawingCoordinatesToGeoJson("0 0 original\n"));
    DrawingSource geojson("drawing-json-limits");
    CHECK_THROWS(geojson.replace(R"({"type":"Feature","geometry":null,"properties":{"id":9223372036854775808}})"));
    CHECK_THROWS(geojson.replace(std::string(66, '[') + "0" + std::string(66, ']')));
}

TEST_CASE("Maximum coordinate row capacity passes native filtering", "[.drawing-capacity]")
{
    DrawingSource source("drawing-capacity");
    std::string text;
    for (size_t i = 0; i < 100000; ++i) text += std::to_string(double(i) / 1000) + " 0 row\n";
    source.replace(drawingCoordinatesToGeoJson(text));
    CHECK(source.model()->size() == 100000);
    CHECK(Json::parse(source.rows(99900, 200)).size() == 100);
    SharedUint8Array subset;
    source.filter(R"({"filterId":"capacity","generation":1,"channels":[{"channelId":"points","scope":"feature","geometryTypes":1}]})", subset);
    CHECK_FALSE(subset.toString().empty());
}


TEST_CASE("Structured GeoJSON edits preserve user roles, foreign members and exact integer IDs", "[drawing]")
{
    DrawingSource source("drawing-unified-edits");
    source.replace(R"({"type":"FeatureCollection","foreign":{"keep":true},"features":[
        {"type":"Feature","id":9007199254740993,"properties":{"description":"user join","role":"join"},"geometry":{"type":"Point","coordinates":[0,0]}},
        {"type":"Feature","properties":null,"geometry":{"type":"Point","coordinates":[1,0]}},
        {"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[1,1]}}
    ]})");
    CHECK_FALSE(Json::parse(source.describe())["joined"].get<bool>());
    source.join("[]");
    CHECK(source.model()->size() == 3);
    auto rows = Json::parse(source.rows(0, 10));
    source.join(Json::array({rows[2]["id"], rows[0]["id"], rows[1]["id"]}).dump());
    auto joined = Json::parse(source.source());
    CHECK(joined["features"].size() == 4);
    CHECK(joined["foreign"]["keep"] == true);
    CHECK(joined["features"][3]["erdblick:generated"] == "join");
    CHECK(joined["features"][3]["geometry"]["coordinates"][0][0] == Json::array({0,0}));
    DrawingSource restored("drawing-unified-restored"); restored.replace(source.source());
    restored.join("[]");
    CHECK(restored.model()->size() == 3);
    auto row = Json::parse(restored.rows(0, 1))[0];
    restored.editDescription(row["id"], "changed");
    auto edited = Json::parse(restored.source());
    CHECK(edited["features"][0]["id"].get<uint64_t>() == 9007199254740993ULL);
    CHECK(edited["features"][0]["properties"]["role"] == "join");
    CHECK(edited["features"][0]["properties"]["description"] == "changed");
    CHECK(edited["foreign"]["keep"] == true);
    source.replace(R"({"type":"Feature","id":123456789012345678901234567890,"properties":{},"geometry":null})");
    auto const raw = source.source();
    CHECK_THROWS(source.editDescription(Json::parse(source.rows(0, 1))[0]["id"], "blocked"));
    CHECK(source.source() == raw);
    source.replace(R"({"type":"Point","coordinates":[2,3]})");
    source.append(3, 4, "appended");
    CHECK(Json::parse(source.source())["features"][0]["geometry"]["coordinates"] == Json::array({2,3}));
}

namespace {
Json authored(std::string kind, Json points, std::string space = "2d") {
    return {{"version", 1}, {"kind", kind}, {"space", space}, {"points", points}};
}
std::string insertObject(DrawingSource& source, Json author) {
    auto revision = Json::parse(source.describe())["revision"];
    Json feature = {{"type", "Feature"}, {"geometry", nullptr}, {"properties", {{"color", "#20a6d2"}}},
        {"erdblick:object", "persistent-object"}, {"erdblick:drawing", author}};
    Json operation = {{"type", "insert"}, {"feature", feature}};
    source.editObjects(Json{{"revision", revision}, {"operations", Json::array({operation})}}.dump());
    return Json::parse(source.rows(0, 1))[0]["id"];
}
}

TEST_CASE("One authored object owns its derived labels, ticks and atomic edits", "[drawing][drawing-shape]") {
    DrawingSource source("shape-test");
    auto author = authored("polyline", {{11, 48}, {11.01, 48}, {11.01, 48.01}});
    author["measurements"] = {{"distances", true}, {"angles", true}, {"ticks", true}, {"intervalMeters", 100}};
    auto id = insertObject(source, author);
    auto root = Json::parse(source.source());
    REQUIRE(root["features"].size() == 1);
    REQUIRE(source.model()->size() == 1);
    CHECK(source.source().find("Total ") == std::string::npos);
    CHECK(source.model()->at(0)->attributeLayers()->size() == 1);
    auto object = Json::parse(source.object(id));
    CHECK(object["metrics"]["lengthMeters"].get<double>() > 1800);
    auto saved = source.source();
    CHECK_THROWS(source.editObjects(Json{{"revision", 0}, {"operations", Json::array({{{"type", "delete"}, {"id", id}}})}}.dump()));
    CHECK(source.source() == saved);
    CHECK_THROWS(source.editObjects(Json{{"revision", object["revision"]}, {"operations", Json::array({
        {{"type", "set"}, {"id", id}, {"path", "/properties/name"}, {"value", "must rollback"}},
        {{"type", "set"}, {"id", id}, {"path", "/erdblick:drawing/points/0/1"}, {"value", 91}}
    })}}.dump()));
    CHECK(source.source() == saved);
    source.editObjects(Json{{"revision", object["revision"]}, {"operations", Json::array({
        {{"type", "author"}, {"id", id}, {"value", {{"measurements", {{"distances", false}, {"angles", false}, {"ticks", false}}}}}}
    })}}.dump());
    CHECK(Json::parse(source.rows(0, 1))[0]["id"] == id);
    CHECK(Json::parse(source.source())["features"][0]["geometry"] == root["features"][0]["geometry"]);
    CHECK(Json::parse(source.object(id))["metrics"]["lengthMeters"] == object["metrics"]["lengthMeters"]);
}

TEST_CASE("Lifted paths measure altitude and Earth curvature independently of rendering", "[drawing][drawing-shape]") {
    auto vertical = evaluateDrawingShape(authored("polyline", {{11,48,0},{11,48,100}}, "3d"));
    CHECK(vertical["metrics"]["lengthMeters"].get<double>() == Catch::Approx(100).margin(1e-7));
    auto elevated = evaluateDrawingShape(authored("polyline", {{0,0,1000},{1,0,1000}}, "3d"));
    auto expected = drawingDistance(0,0,1,0) * (1+1000.0/6378137);
    CHECK(elevated["metrics"]["lengthMeters"].get<double>() == Catch::Approx(expected).margin(0.001));
    auto surface = evaluateDrawingShape(authored("polyline", {{0,0,1000},{1,0,1000}}));
    CHECK(surface["metrics"]["lengthMeters"].get<double>() == Catch::Approx(drawingDistance(0,0,1,0)).margin(1e-6));
}

TEST_CASE("Planar polygons retain a vertical frame and physical area", "[drawing][drawing-shape]") {
    auto frame = Json::parse(drawingPlane(R"({"action":"horizontal","origin":[11,48,100]})"));
    auto u = frame["u"].get<std::array<double,3>>(), v = frame["v"].get<std::array<double,3>>();
    frame["v"] = {u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]}; // local up, computed from orthonormal EN axes
    auto point = [&](double x, double y) { return Json::parse(drawingPlane(Json{{"action","global"},{"plane",frame},{"position",{x,y}}}.dump())); };
    auto author = authored("polygon", {point(0,0),point(100,0),point(100,50),point(0,50)}, "3d");
    author["plane"] = frame;
    auto shape = evaluateDrawingShape(author);
    REQUIRE_FALSE(shape["metrics"]["areaSquareMeters"].is_null());
    CHECK(shape["metrics"]["areaSquareMeters"].get<double>() == Catch::Approx(5000).margin(1e-4));
    CHECK(shape["metrics"]["perimeterMeters"].get<double>() == Catch::Approx(300).margin(1e-5));
    DrawingSource source("vertical");
    CHECK_NOTHROW(insertObject(source, author));
    CHECK_NOTHROW(source.replace(source.source()));
}

TEST_CASE("Geographic cubic curves use one deterministic evaluator across the dateline", "[drawing][drawing-shape]") {
    auto author = authored("polyline", {{179.9,70,100},{-179.9,70,200}}, "3d");
    author["curves"] = {{"0", {{179.95,70.02,140},{-179.95,70.02,160}}}};
    author["measurements"] = {{"ticks",true},{"intervalMeters",1000}};
    auto shape = evaluateDrawingShape(author);
    CHECK(shape["geometry"]["type"] == "MultiLineString");
    CHECK(shape["metrics"]["lengthMeters"].get<double>() > drawingDistance(179.9,70,-179.9,70));
    CHECK(shape["decorations"].size() > 5);
    author["unit"] = "miles";
    auto miles = evaluateDrawingShape(author);
    CHECK(shape["geometry"] == miles["geometry"]);
    CHECK(shape["metrics"] == miles["metrics"]);
    DrawingSource source("curve"); CHECK_NOTHROW(insertObject(source, author));
    auto root = Json::parse(source.source()); root["features"][0]["geometry"]["coordinates"][0][0][0] = 179.8;
    CHECK_THROWS(source.replace(root.dump()));
}

TEST_CASE("Polar coordinates remain measurable and serializable without false Mercator fills", "[drawing][drawing-shape]") {
    auto author = authored("polygon", {{0,89},{120,89},{-120,89}});
    author["measurements"] = {{"area",true}};
    auto result = evaluateDrawingShape(author);
    REQUIRE_FALSE(result["metrics"]["areaSquareMeters"].is_null());
    CHECK(result["metrics"]["areaSquareMeters"].get<double>() > 1e9);
    DrawingSource source("polar"); auto id = insertObject(source, author);
    CHECK(Json::parse(source.describe())["projectionLimited"] == true);
    CHECK(Json::parse(source.source())["features"][0]["erdblick:drawing"]["points"][0][1] == 89);
    CHECK(source.model()->at(0)->geom()->numGeometries() == 0);
    auto path = evaluateDrawingShape(authored("polyline", {{0,90},{0,89.99}}));
    CHECK(path["metrics"]["lengthMeters"].get<double>() > 1000);
}

TEST_CASE("Ordinary polygon holes share validity and preserve non-planar 3D data", "[drawing][drawing-shape]") {
    Json outer={{0,0},{2,0},{2,2},{0,2},{0,0}}, hole={{.5,.5},{.5,1},{1,1},{1,.5},{.5,.5}};
    Json author={{"version",1},{"kind","ordinary"},{"space","2d"},{"measurements",{{"area",true}}}};
    auto geometry=Json{{"type","Polygon"},{"coordinates",{outer,hole}}};
    auto result=evaluateDrawingShape(author,geometry);
    REQUIRE(result["metrics"]["areaSquareMeters"].is_number());
    CHECK(result["geometry"]==geometry);
    geometry["coordinates"][1]={{3,3},{4,3},{4,4},{3,4},{3,3}};
    CHECK(evaluateDrawingShape(author,geometry)["metrics"]["areaSquareMeters"].is_null());
    author["space"]="3d";
    CHECK(evaluateDrawingShape(author,geometry)["metrics"]["areaSquareMeters"].is_null());
}

TEST_CASE("Ordinary paths use coordinate-linear tangents and an ellipsoidal boundary integral", "[drawing][drawing-shape]") {
    Json author={{"version",1},{"kind","ordinary"},{"space","2d"}};
    auto line=evaluateDrawingShape(author,{{"type","LineString"},{"coordinates",{{0,60},{30,60},{30,70}}}});
    CHECK(line["metrics"]["anglesDegrees"][0].get<double>()==Catch::Approx(90).margin(1e-5));
    // Independent analytic ellipsoid surface integral for a latitude/longitude rectangle.
    constexpr double a=6378137, f=1/298.257223563, e2=f*(2-f);
    auto primitive=[](double degrees) {
        auto u=std::sin(degrees*std::numbers::pi/180), e=std::sqrt(e2);
        return (u/(1-e2*u*u)+std::atanh(e*u)/e)/2;
    };
    auto expected=a*a*(1-e2)*(40*std::numbers::pi/180)*(primitive(70)-primitive(60));
    auto polygon=evaluateDrawingShape(author,{{"type","Polygon"},{"coordinates",{{{-20,60},{20,60},{20,70},{-20,70},{-20,60}}}}});
    REQUIRE(polygon["metrics"]["areaSquareMeters"].is_number());
    CHECK(polygon["metrics"]["areaSquareMeters"].get<double>()==Catch::Approx(expected).epsilon(3e-8));
    author["space"]="3d";
    auto missing=evaluateDrawingShape(author,{{"type","LineString"},{"coordinates",{{0,60,100},{30,60},{30,70,200}}}});
    CHECK(missing["metrics"]["lengthMeters"].is_null());
    CHECK(missing["metrics"]["availability"]["length"]["reason"]=="missing_height");
}

TEST_CASE("Native preparation keeps accepted reads and identity allocation unchanged until commit", "[drawing]") {
    DrawingSource source("prepared");
    source.replace(R"({"type":"FeatureCollection","features":[]})");
    auto before=source.source(), checkpoint=source.checkpoint();
    auto revision=Json::parse(source.describe())["revision"];
    Json mutation={{"type","objects"},{"request",{{"revision",revision},{"operations",Json::array({
        {{"type","insert"},{"feature",{{"type","Feature"},{"geometry",{{"type","Point"},{"coordinates",{1,2}}}},{"properties",nullptr}}}}
    })}}}};
    source.stage(mutation.dump());
    CHECK(source.source()==before);
    CHECK(source.checkpoint()==checkpoint);
    CHECK(source.model()->size()==0);
    source.cancelStage();
    CHECK_THROWS(source.commitStage());
    source.stage(mutation.dump());
    source.commitStage();
    CHECK(source.model()->size()==1);
    CHECK(Json::parse(source.describe())["revision"]==revision.get<uint32_t>()+1);
    CHECK(Json::parse(source.rows(0,1))[0]["id"]=="1");
}

TEST_CASE("Quick branches page geometry and retain exact foreign numeric lexemes", "[drawing]") {
    DrawingSource source("branches");
    source.replace(R"({"type":"Feature","id":9007199254740993,"geometry":{"type":"LineString","coordinates":[[0,0],[1,1],[2,2]]},"properties":{"exact":9007199254740993}})");
    auto id=Json::parse(source.rows(0,1))[0]["id"];
    auto page=Json::parse(source.branch(Json{{"id",id},{"path","/geometry/coordinates"},{"count",2}}.dump()));
    REQUIRE(page["entries"].size()==2);
    CHECK(page["nextOffset"]==2);
    CHECK_FALSE(page["entries"][0].contains("text"));
    auto exact=Json::parse(source.branch(Json{{"id",id},{"path","/properties/exact"}}.dump()));
    CHECK(exact["text"]=="9007199254740993");
    auto root=Json::parse(source.branch(Json{{"id",id}}.dump()));
    CHECK_FALSE(root["object"]["feature"]["geometry"].contains("coordinates"));
    CHECK_THROWS(source.branch(Json{{"id",id},{"revision",0}}.dump()));
    auto handles=Json::parse(source.branch(Json{{"id",id},{"editing",true}}.dump()));
    CHECK(handles["object"]["feature"]["geometry"]["coordinates"].size()==3);
    CHECK_FALSE(handles["object"]["feature"]["properties"].contains("exact"));
    auto author=authored("polyline",{{0,0},{90,60}},"2d");
    auto shape=evaluateDrawingShape(author);
    source.replace(Json{{"type","Feature"},{"properties",Json::object()},
        {"geometry",shape["geometry"]},{"erdblick:drawing",shape["authoring"]}}.dump());
    id=Json::parse(source.rows(0,1))[0]["id"];
    handles=Json::parse(source.branch(Json{{"id",id},{"editing",true}}.dump()));
    CHECK(handles["object"]["feature"]["geometry"].is_null());
    CHECK(handles["object"]["feature"]["erdblick:drawing"]["points"].size()==2);
    CHECK(handles.dump().size()<4096);
}

TEST_CASE("Authored plane constraints reject silent projection", "[drawing][drawing-shape]") {
    auto frame=Json::parse(drawingPlane(R"({"action":"horizontal","origin":[0,0,0]})"));
    auto author=authored("polygon",{{0,0,0},{.01,0,100},{0,.01,0}},"3d");
    author["plane"]=frame;
    CHECK_THROWS(evaluateDrawingShape(author));
    author.erase("plane");
    CHECK_THROWS(evaluateDrawingShape(author));
}

TEST_CASE("Closed-ring edits and authored identities survive undo and worker recovery", "[drawing]") {
    DrawingSource source("ring-edit");
    auto id=insertObject(source,authored("polygon",{{0,0},{1,0},{1,1},{0,1}}));
    auto initial=source.source(); auto revision=[&]{return Json::parse(source.describe())["revision"];};
    source.editObjects(Json{{"revision",revision()},{"operations",Json::array({{{"type","delete"},{"id",id}}})}}.dump());
    auto checkpoint=source.checkpoint();
    DrawingSource recovered("ring-edit"); recovered.restore(source.source(),checkpoint); recovered.replace(initial);
    CHECK(Json::parse(recovered.rows(0,1))[0]["id"]==id);
    source.replace(initial);
    source.editObjects(Json{{"revision",revision()},{"operations",Json::array({{{"type","convert"},{"id",id}},{{"type","set"},{"id",id},{"path","/geometry/coordinates/0/0/0"},{"value",-.1}}})}}.dump());
    auto ring=Json::parse(source.source())["features"][0]["geometry"]["coordinates"][0];
    CHECK(ring.front()==ring.back()); CHECK(ring[0][0]==-.1);
    auto before=source.source();
    CHECK_THROWS(source.editObjects(Json{{"revision",revision()},{"operations",Json::array({{{"type","set"},{"id",id},{"path","/propertiesOther"},{"value",42}}})}}.dump()));
    CHECK(source.source()==before);
}

TEST_CASE("Authored annotations render native labels with object color, size and parent identity", "[drawing][drawing-shape]") {
    std::ifstream input(std::string(ERDBLICK_TEST_STYLES_DIRECTORY)+"/drawing-style.yaml");
    std::string yaml((std::istreambuf_iterator<char>(input)),{}); FeatureLayerStyle style{SharedUint8Array(yaml)};
    REQUIRE(style.validationReport()["valid"]==true);
    DrawingSource source("annotation-render");
    auto author=authored("annotation",{{11,48,123}},"3d"); author["text"]="Plain <b>Über</b>";author["fontSize"]=24;
    auto id=insertObject(source,author);
    source.editObjects(Json{{"revision",Json::parse(source.describe())["revision"]},{"operations",Json::array({{{"type","set"},{"id",id},{"path","/properties/color"},{"value","#12ab78"}}})}}.dump());
    auto plan=planStyleFilter(style,*source.model()->layerInfo(),FeatureStyleRule::NoHighlight,7); REQUIRE(plan.valid);
    SharedUint8Array subset,schema,dictionary;
    source.filter(Json{{"filterId","annotation"},{"generation",1},{"channels",plan.toJsValue()["channels"]},{"bindings",{{"drawingColor","#20a6d2"}}}}.dump(),subset);
    source.schema(schema);source.dictionary(dictionary);
    auto metadata=Json::parse(source.describe())["metadata"];TileLayerParser parser;parser.installMapSchema(schema,metadata["schemaId"]);
    parser.setDataSourceInfo(SharedUint8Array(Json::array({metadata}).dump()));parser.addFieldDict(dictionary);
    auto decoded=parser.readTileSubsetLayer(subset);
    TileSubsetLayerRenderer renderer(0,"annotation",style,FeatureStyleRule::NoHighlight,7);
    renderer.addTileSubsetContribution(decoded,1,0,1,0,1);renderer.run();
    auto bytes=renderer.renderPacketBytes();auto packet=GpuRenderPacketCodec::validate(bytes); REQUIRE(packet.labelCount==1);
    auto read=[&]<class T>(size_t offset){T value;std::memcpy(&value,bytes.data()+offset,sizeof(T));return value;};
    auto labelOffset=read.template operator()<uint32_t>(112);
    // These are the public packet ABI's label size and color fields.
    CHECK(read.template operator()<float>(labelOffset+48)==24);
    CHECK(read.template operator()<uint8_t>(labelOffset+72)==0x12);
    CHECK(read.template operator()<uint8_t>(labelOffset+73)==0xab);
    CHECK(read.template operator()<uint8_t>(labelOffset+74)==0x78);
    CHECK(source.model()->size()==1);
    auto labelPick=read.template operator()<uint32_t>(labelOffset+4);
    CHECK(labelPick<packet.pickCount);
}

TEST_CASE("Planar ellipse retains its center and raw conversion preserves exact foreign IDs", "[drawing][drawing-shape]") {
    Json plane={{"origin",{0,0,0}},{"u",{0,1,0}},{"v",{1,0,0}}};
    auto global=[&](double x,double y){return Json::parse(drawingPlane(Json{{"action","global"},{"plane",plane},{"position",{x,y}}}.dump()));};
    auto author=authored("ellipse",{global(500,500),global(520,510)},"3d"); author["plane"]=plane;
    auto shape=evaluateDrawingShape(author);
    CHECK(shape["metrics"]["areaSquareMeters"].get<double>()==Catch::Approx(std::numbers::pi*200).epsilon(.001));
    auto first=Json::parse(drawingPlane(Json{{"action","local"},{"plane",plane},{"position",shape["geometry"]["coordinates"][0][0]}}.dump()));
    CHECK(first[0].get<double>()==Catch::Approx(520).margin(.001));
    CHECK(first[1].get<double>()==Catch::Approx(500).margin(.001));
    DrawingSource source("convert-draft");insertObject(source,authored("polyline",{{0,0},{1,1}}));
    auto root=Json::parse(source.source());root["features"][0]["geometry"]["coordinates"][0][0]=.1;
    root["features"][0]["id"]=uint64_t{9007199254740993};
    auto converted=Json::parse(drawingCompose(Json{{"sources",{root.dump()}},{"ordinary",true}}.dump(),false));
    REQUIRE(converted.size()==1);CHECK_NOTHROW(source.replace(converted[0].get<std::string>()));
    auto feature=Json::parse(source.source())["features"][0];
    CHECK(feature["id"].get<uint64_t>()==uint64_t{9007199254740993});
    CHECK(feature["geometry"]==root["features"][0]["geometry"]);
    CHECK(feature["erdblick:drawing"]["kind"]=="ordinary");
}

TEST_CASE("Interval markers are bounded per object and empty ordinary geometry remains editable", "[drawing][drawing-shape]") {
    Json author={{"version",1},{"kind","ordinary"},{"space","2d"},{"measurements",{{"ticks",true},{"intervalMeters",1}}}};
    auto result=evaluateDrawingShape(author,{{"type","MultiLineString"},{"coordinates",{{{0,0},{.01,0}},{{0,1},{.01,1}}}}});
    CHECK(result["decorations"].size()<=1000);
    CHECK(result["decorations"].size()>0);
    CHECK(result["decorations"].back()["position"][1].get<double>()==Catch::Approx(1));
    CHECK(result["metrics"]["markerLimit"]==true);
    CHECK_NOTHROW(evaluateDrawingShape(author,{{"type","LineString"},{"coordinates",Json::array()}}));
}

TEST_CASE("Drawing lines and vertical polygons render without a preview property and expose snap geometry", "[drawing][drawing-shape]") {
    std::ifstream input(std::string(ERDBLICK_TEST_STYLES_DIRECTORY)+"/drawing-style.yaml");
    std::string yaml((std::istreambuf_iterator<char>(input)),{});FeatureLayerStyle style{SharedUint8Array(yaml)};
    Json plane={{"origin",{0,0,0}},{"u",{0,1,0}},{"v",{1,0,0}}};
    Json points=Json::array();for(auto xy:std::vector<std::pair<double,double>>{{0,0},{100,0},{100,50},{0,50}})
        points.push_back(Json::parse(drawingPlane(Json{{"action","global"},{"plane",plane},{"position",{xy.first,xy.second}}}.dump())));
    DrawingSource source("vertical-render"); bool polygon=true;
    SECTION("vertical polygon") { polygon=true; }
    SECTION("line without preview metadata") { polygon=false; }
    auto author=authored(polygon?"polygon":"polyline",points,"3d");author["plane"]=plane;insertObject(source,author);
    auto plan=planStyleFilter(style,*source.model()->layerInfo(),FeatureStyleRule::NoHighlight,7);REQUIRE(plan.valid);
    SharedUint8Array subset,schema,dictionary;
    source.filter(Json{{"filterId","vertical"},{"generation",1},{"channels",plan.toJsValue()["channels"]},{"bindings",{{"drawingColor","#20a6d2"}}}}.dump(),subset);
    source.schema(schema);source.dictionary(dictionary);auto metadata=Json::parse(source.describe())["metadata"];
    TileLayerParser parser;parser.installMapSchema(schema,metadata["schemaId"]);parser.setDataSourceInfo(SharedUint8Array(Json::array({metadata}).dump()));parser.addFieldDict(dictionary);
    auto decoded=parser.readTileSubsetLayer(subset);
    bool snapFound=false;
    for(uint32_t channel=0;channel<plan.toJsValue()["channels"].size();++channel)
        snapFound |= !Json::parse(decoded.snapGeometry(channel,0)).empty();
    CHECK(snapFound);
    TileSubsetLayerRenderer renderer(0,"vertical",style,FeatureStyleRule::NoHighlight,7);renderer.addTileSubsetContribution(decoded,1,0,1,0,1);renderer.run();
    auto bytes=renderer.renderPacketBytes();auto packet=GpuRenderPacketCodec::validate(bytes);
    auto read=[&]<class T>(size_t offset){T value;std::memcpy(&value,bytes.data()+offset,sizeof(T));return value;};
    uint32_t triangles=0, paths=0;auto table=read.template operator()<uint32_t>(72);
    for(uint32_t i=0;i<packet.streamCount;++i) if(read.template operator()<uint16_t>(table+i*48)==static_cast<uint16_t>(GpuPrimitiveKind::SurfaceTriangle))triangles+=read.template operator()<uint32_t>(table+i*48+16);
    for(uint32_t i=0;i<packet.streamCount;++i) if(read.template operator()<uint16_t>(table+i*48)==static_cast<uint16_t>(GpuPrimitiveKind::PathSegment))paths+=read.template operator()<uint32_t>(table+i*48+16);
    if(polygon)CHECK(triangles>=2);else CHECK(paths>0);
}

TEST_CASE("Unknown drawing authoring metadata stays inert during ordinary property edits", "[drawing]") {
    DrawingSource source("future-authoring");
    source.replace(R"({"type":"Feature","id":9007199254740993,"geometry":{"type":"Point","coordinates":[1,2]},"properties":{},"erdblick:drawing":{"version":"future","kind":"new-shape"}})");
    auto row=Json::parse(source.rows(0,1))[0];
    source.editObjects(Json{{"revision",Json::parse(source.describe())["revision"]},{"operations",Json::array({{{"type","set"},{"id",row["id"]},{"path","/properties/name"},{"value","Edited"}}})}}.dump());
    auto feature=Json::parse(source.source())["features"][0];
    CHECK(feature["erdblick:drawing"]["version"]=="future");
    CHECK(feature["geometry"]["coordinates"]==Json::array({1,2}));
    CHECK(feature["id"].get<uint64_t>()==uint64_t{9007199254740993});
}

TEST_CASE("Large polygon area validation stays bounded without changing geometry", "[drawing]")
{
    Json ring = Json::array();
    for (size_t i = 0; i < 8193; ++i) {
        double angle = i * 2 * std::numbers::pi / 8193;
        ring.push_back({0.01 * std::cos(angle), 0.01 * std::sin(angle)});
    }
    ring.push_back(ring.front());
    Json geometry = {{"type", "Polygon"}, {"coordinates", Json::array({ring})}};
    auto result = Json::parse(drawingEvaluate(Json{{"authoring", {{"version", 1}, {"kind", "ordinary"}, {"space", "2d"}}}, {"geometry", geometry}}.dump()));
    CHECK(result["geometry"] == geometry);
    CHECK(result["metrics"]["areaSquareMeters"].is_null());
    CHECK(result["metrics"]["warning"].get<std::string>().find("8,192") != std::string::npos);
}

TEST_CASE("Imported identities survive first structured edits, undo, redo and recovery", "[drawing]")
{
    DrawingSource source("imported-history");
    std::string original = R"({"type":"FeatureCollection","features":[{"type":"Feature","id":7,"geometry":{"type":"Point","coordinates":[1,2,123]},"properties":{}},{"type":"Feature","id":7,"geometry":{"type":"Point","coordinates":[3,4,456]},"properties":{}}]})";
    source.replace(original);
    auto rows = Json::parse(source.rows(0,10));
    auto edit = Json{{"revision",Json::parse(source.describe())["revision"]},{"operations",Json::array({{{"type","set"},{"id",rows[0]["id"]},{"path","/geometry/coordinates/0"},{"value",5}}})}};
    source.editObjects(edit.dump()); auto changed = source.source();
    source.replace(original);
    CHECK(Json::parse(source.rows(0,10))[0]["id"] == rows[0]["id"]);
    CHECK(Json::parse(source.rows(0,10))[1]["id"] == rows[1]["id"]);
    source.replace(changed);
    CHECK(Json::parse(source.rows(0,10))[1]["id"] == rows[1]["id"]);
    DrawingSource recovered("imported-history"); recovered.restore(changed,source.checkpoint());
    recovered.replace(original);
    CHECK(Json::parse(recovered.rows(0,10))[0]["id"] == rows[0]["id"]);
    CHECK(Json::parse(recovered.rows(0,10))[1]["id"] == rows[1]["id"]);
}

TEST_CASE("Duplicate external IDs inserted by the first edit retain every native identity", "[drawing]")
{
    DrawingSource source("duplicate-insert");
    Json feature = {{"type","Feature"},{"id",7},{"geometry",{{"type","Point"},{"coordinates",{1,2}}}},{"properties",Json::object()}};
    auto original = Json{{"type","FeatureCollection"},{"features",Json::array({feature,feature})}}.dump();
    source.replace(original);
    auto before = Json::parse(source.rows(0,10));
    source.editObjects(Json{{"revision",Json::parse(source.describe())["revision"]},{"operations",Json::array({{{"type","insert"},{"feature",feature}}})}}.dump());
    auto changed = source.source(), checkpoint = source.checkpoint();
    auto after = Json::parse(source.rows(0,10));
    REQUIRE(after.size() == 3);
    source.replace(original);
    CHECK(Json::parse(source.rows(0,10)) == before);
    source.replace(changed);
    CHECK(Json::parse(source.rows(0,10)) == after);
    DrawingSource recovered("duplicate-insert"); recovered.restore(changed,checkpoint);
    recovered.replace(original); CHECK(Json::parse(recovered.rows(0,10)) == before);
    recovered.replace(changed); CHECK(Json::parse(recovered.rows(0,10)) == after);
    recovered.append(3,4,"new");
    CHECK(Json::parse(recovered.rows(0,10))[3]["id"] != after[2]["id"]);
}

TEST_CASE("Polar crossing lines retain their visible portions and interpolated height", "[drawing]")
{
    DrawingSource source("polar-line");
    Json coordinates = {{10,80,100},{19,89,190},{28,80,280}};
    source.replace(Json{{"type","LineString"},{"coordinates",coordinates}}.dump());
    auto display = source.model()->toJson()["features"][0]["geometry"];
    REQUIRE(display["type"] == "GeometryCollection");
    REQUIRE(display["geometries"].size() == 2);
    double boundary = 85.0511287798066;
    auto first = display["geometries"][0]["coordinates"], second = display["geometries"][1]["coordinates"];
    CHECK(first[0] == coordinates[0]);
    CHECK(first.back()[1].get<double>() == Catch::Approx(boundary).margin(1e-10));
    CHECK(first.back()[2].get<double>() == Catch::Approx(100+(boundary-80)*10).margin(1e-8));
    CHECK(second.back() == coordinates[2]);
    CHECK(Json::parse(source.source())["coordinates"] == coordinates);
    source.replace(R"({"type":"LineString","coordinates":[[0,-89],[0,89]]})");
    display = source.model()->toJson()["features"][0]["geometry"];
    CHECK(display["coordinates"][0][1].get<double>() == Catch::Approx(-boundary).margin(1e-10));
    CHECK(display["coordinates"].back()[1].get<double>() == Catch::Approx(boundary).margin(1e-10));
}

TEST_CASE("Drawing bounds include ordinary long segments and explicit dateline splits", "[drawing]")
{
    DrawingSource source("line-bounds");
    source.replace(R"({"type":"LineString","coordinates":[[-170,0],[170,1]]})");
    CHECK(Json::parse(source.describe())["bounds"] == Json::array({-170,0,170,1}));
    auto id = Json::parse(source.rows(0,1))[0]["id"].get<std::string>();
    CHECK(Json::parse(source.object(id))["presentation"]["bounds"] == Json::array({-170,0,170,1}));
    source.replace(R"({"type":"MultiLineString","coordinates":[[[170,0],[180,1]],[[-180,1],[-170,2]]]})");
    CHECK(Json::parse(source.describe())["bounds"] == Json::array({170,0,190,2}));
    source.replace(R"({"type":"LineString","coordinates":[[-180,0],[180,1]]})");
    auto bounds = Json::parse(source.describe())["bounds"];
    CHECK(bounds[2].get<double>()-bounds[0].get<double>() == 360);
}

TEST_CASE("Visible markers span the far end and ticks are physical perpendicular strokes", "[drawing][drawing-shape]")
{
    Json author={{"version",1},{"kind","polyline"},{"space","2d"},{"points",{{0,0},{1,0}}},
        {"measurements",{{"ticks",true},{"marker","tick"},{"intervalMeters",10}}}};
    auto shape=evaluateDrawingShape(author);
    auto far=drawingMarkerDecorations(shape["markerPaths"],author,{{"west",.99},{"south",-.001},{"width",.01},{"height",.002},{"metersPerPixel",1}});
    REQUIRE(!far["decorations"].empty());
    CHECK(far["decorations"].size()<=1000);
    for(auto const& marker:far["decorations"]){
        CHECK(marker["position"][0].get<double>()>=.99);
        REQUIRE(marker.contains("line"));
        CHECK(marker["line"][0][0].get<double>()==Catch::Approx(marker["line"][1][0].get<double>()).margin(1e-9));
        CHECK(marker["line"][0][1].get<double>()>marker["line"][1][1].get<double>());
        CHECK(marker["text"].get<std::string>().find("│")==std::string::npos);
    }
    auto distant=drawingMarkerDecorations(shape["markerPaths"],author,{{"west",0},{"south",-.1},{"width",1},{"height",.2},{"metersPerPixel",100}});
    CHECK(distant["limited"]==true);
    CHECK(distant["decorations"].size()<far["decorations"].size()*2);
    CHECK(shape["authoring"]["measurements"]["intervalMeters"]==10);
}

TEST_CASE("Native curve subdivision preserves shape and reindexes unaffected controls", "[drawing][drawing-shape]")
{
    Json author={{"version",1},{"kind","polyline"},{"space","2d"},{"points",{{0,0},{.01,0},{.02,0}}},
        {"curves",{{"0",{{.003,.002},{.007,.002}}},{"1",{{.013,0},{.017,0}}}}}};
    auto before=evaluateDrawingShape(author);
    auto split=editDrawingControls(author,{{"type","insertVertex"},{"index",0}});
    REQUIRE(split["points"].size()==4);
    CHECK(split["curves"].contains("2"));
    auto after=evaluateDrawingShape(split);
    CHECK(after["metrics"]["lengthMeters"].get<double>()==Catch::Approx(before["metrics"]["lengthMeters"].get<double>()).margin(.01));
    auto removed=editDrawingControls(split,{{"type","deleteVertex"},{"index",1}});
    CHECK(removed["points"].size()==3);
    CHECK(removed["curves"].contains("1"));
    CHECK(!removed["curves"].contains("0"));
    DrawingSource source("exact-leaf");source.replace(R"({"type":"Feature","geometry":null,"properties":{"number":1}})");
    auto row=Json::parse(source.rows(0,1))[0];
    source.editObjects(Json{{"revision",Json::parse(source.describe())["revision"]},{"operations",Json::array({{{"type","setExact"},{"id",row["id"]},{"path","/properties/number"},{"text","9007199254740993"}}})}}.dump());
    CHECK(Json::parse(source.source())["features"][0]["properties"]["number"].get<uint64_t>()==uint64_t{9007199254740993});
}
