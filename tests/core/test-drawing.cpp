#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include <fstream>
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
