#include <catch2/catch_test_macros.hpp>

#include "../support/scalar-schema.h"
#include "erdblick/inspection.h"
#include "erdblick/interop/js-object.h"
#include "erdblick/layer.h"
#include "erdblick/parser.h"
#include "erdblick/rule.h"
#include "mapget/model/mapschema.h"
#include "mapget/model/sourcedata.h"
#include "mapget/model/subsetlayer.h"

#include <sstream>

namespace
{

/** One produced root and one reference-only identity in the same authoritative graph. */
std::shared_ptr<mapget::MapSchema const> schemaFixture(std::string version = "1")
{
    auto graph = std::make_shared<mapget::MapSchema>(
        mapget::MapFormat{"erdblick-test", std::move(version), {}});
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    for (auto const* name : {"Road", "Junction"}) {
        auto info = mapget::FeatureTypeInfo::fromJson(
            {{"name", name},
             {"uniqueIdCompositions", {{{{"partId", "id"}, {"datatype", "U32"}}}}}});
        auto root = layer->addSchema(simfil::Schema::Kind::Object);
        layer->addFeatureType(std::move(info), root, std::string_view(name) == "Road");
        if (std::string_view(name) == "Road")
            layer->setRootSchema(root);
    }
    graph->finalize();
    return graph;
}

/** Small canonical metadata intentionally carries no duplicate feature type definitions. */
erdblick::SharedUint8Array sourceFixture(std::string const& mapId, std::string const& schemaId)
{
    return erdblick::SharedUint8Array(
        nlohmann::json::array(
            {{{"mapId", mapId},
              {"stringPoolId", mapId},
              {"schemaId", schemaId},
              {"layers", {{"Road", {{"layerId", "Road"}, {"type", "Features"}}}}}}})
            .dump());
}

/** Serialize through the actual native binary writer rather than a hand-maintained fixture blob. */
erdblick::SharedUint8Array schemaBytes(mapget::MapSchema const& graph)
{
    std::ostringstream stream;
    REQUIRE(graph.write(stream));
    return erdblick::SharedUint8Array(stream.str());
}

}  // namespace

TEST_CASE(
    "Schema installation validates supplied bytes even with a warm graph cache",
    "[erdblick.schema]")
{
    auto graph = schemaFixture();
    auto bytes = schemaBytes(*graph);
    auto const id = std::string(graph->schemaId());
    erdblick::TileLayerParser parser;
    parser.installMapSchema(bytes, id);
    auto different = schemaFixture("2");
    REQUIRE(different->schemaId() != id);
    REQUIRE_THROWS(parser.installMapSchema(schemaBytes(*different), id));
    auto corrupt = bytes.toString();
    corrupt.back() ^= 1;
    REQUIRE_THROWS(parser.installMapSchema(erdblick::SharedUint8Array(corrupt), id));
    REQUIRE_THROWS(parser.installMapSchema(erdblick::SharedUint8Array("truncated"), id));
    parser.addDataSourceInfo(sourceFixture("StillReady", id));
    REQUIRE(parser.featureTypes("StillReady", "Road", false) == nlohmann::json::array({"Road"}));
}

TEST_CASE(
    "Parser requires an exact installed schema and shares owners between parsers",
    "[erdblick.schema]")
{
    auto graph = schemaFixture();
    auto bytes = schemaBytes(*graph);
    auto const id = std::string(graph->schemaId());
    erdblick::TileLayerParser first;
    erdblick::TileLayerParser second;
    REQUIRE_THROWS(first.addDataSourceInfo(sourceFixture("First", id)));
    REQUIRE_THROWS(first.installMapSchema(bytes, id + "-wrong"));
    first.installMapSchema(bytes, id);
    second.installMapSchema(bytes, id);
    first.addDataSourceInfo(sourceFixture("First", id));
    second.addDataSourceInfo(sourceFixture("Second", id));
    REQUIRE(first.info_.at("First").mapSchema_ == second.info_.at("Second").mapSchema_);
    REQUIRE(first.featureTypes("First", "Road", false) == nlohmann::json::array({"Road"}));
    REQUIRE(first.featureTypes("First", "Road", true).size() == 2);
}

TEST_CASE("Invalid metadata replacement preserves the previous bound graph", "[erdblick.schema]")
{
    auto graph = schemaFixture();
    auto const id = std::string(graph->schemaId());
    erdblick::TileLayerParser parser;
    parser.installMapSchema(schemaBytes(*graph), id);
    parser.addDataSourceInfo(sourceFixture("First", id));
    auto retained = parser.info_.at("First").mapSchema_;
    REQUIRE_THROWS(parser.setDataSourceInfo(sourceFixture("Replacement", "unknown-schema")));
    REQUIRE(parser.info_.at("First").mapSchema_ == retained);
    REQUIRE(parser.featureTypes("First", "Road", false) == nlohmann::json::array({"Road"}));
}

TEST_CASE(
    "Inspection labels exact domains while keeping raw numbers and masks",
    "[erdblick.schema][erdblick.inspection]")
{
    erdblick::test::ScalarSchema fixture;
    using Node = erdblick::InspectionConverter::InspectionNode;
    Node unlimited;
    REQUIRE(unlimited.setScalarValue(fixture.number(255, fixture.speed)));
    CHECK(*unlimited.value_ == 255);
    CHECK(unlimited.displayValue_.find("UNLIMITED") != std::string::npos);
    CHECK(unlimited.displayValue_.find("km/h") == std::string::npos);
    Node ordinary;
    REQUIRE(ordinary.setScalarValue(fixture.number(0, fixture.classicSpeed)));
    CHECK(ordinary.displayValue_.find("UNDEFINED") == std::string::npos);
    Node width;
    REQUIRE(width.setScalarValue(fixture.number(12, fixture.width)));
    CHECK(*width.value_ == 12);
    CHECK(width.displayValue_.find(" m") != std::string::npos);
    CHECK(width.displayValue_.find("raw 12") != std::string::npos);
    Node computed;
    REQUIRE(computed.setScalarValue(simfil::Value(int64_t{255})));
    CHECK(computed.displayValue_.empty());
    CHECK_FALSE(computed.scalarDomain_);
    Node flags;
    REQUIRE(flags.setScalarValue(simfil::Value(simfil::Bitmask{
        UINT64_C(0x8000000000000003),
        {fixture.owner->binding(), fixture.flags}})));
    CHECK(*flags.value_ == "0x8000000000000003");
    CHECK(flags.displayValue_.find("BOTH") != std::string::npos);
    CHECK(flags.displayValue_.find("CAR_ALIAS") != std::string::npos);
    CHECK(flags.displayValue_.find("unknown bits 0x8000000000000000") != std::string::npos);
    Node zero;
    REQUIRE(zero.setScalarValue(simfil::Value(simfil::Bitmask{
        0,
        {fixture.owner->binding(), fixture.flags}})));
    CHECK(zero.displayValue_.find("NONE") != std::string::npos);
}

TEST_CASE(
    "Feature and SourceData inspection derive primitive meanings from parent fields",
    "[erdblick.schema][erdblick.inspection]")
{
    erdblick::test::ScalarSchema fixture;
    auto strings = std::make_shared<mapget::StringPool>(fixture.source.stringPoolId_);
    nlohmann::json rows;
    SECTION("feature properties")
    {
        auto tile = std::make_shared<mapget::TileFeatureLayer>(
            mapget::TileId{},
            fixture.source.stringPoolId_,
            fixture.source.mapId_,
            fixture.source.getLayer("Road"),
            strings);
        auto feature = tile->newFeature("Road", {{"id", int64_t{1}}});
        REQUIRE(feature->attributes()->addField("speed", int64_t{255}));
        REQUIRE(feature->attributes()->addField("width", int64_t{12}));
        auto inspected = erdblick::InspectionConverter().convert(feature);
        for (auto const& section : *inspected) {
            if (section.value("key", std::string{}) == "Basic Attributes")
                rows = section.at("children");
        }
    }
    SECTION("raw source compounds")
    {
        auto tile = std::make_shared<mapget::TileSourceDataLayer>(
            mapget::TileId{},
            fixture.source.stringPoolId_,
            fixture.source.mapId_,
            fixture.source.getLayer("Raw"),
            strings);
        auto root = tile->newCompound(2);
        root->setSchema(fixture.rawRoot);
        REQUIRE(root->object()->addField("speed", int64_t{255}));
        REQUIRE(root->object()->addField("width", int64_t{12}));
        tile->addRoot(root);
        rows = erdblick::TileSourceDataLayer(tile).toObject().at("children");
    }
    // These leaves were stored as ordinary integers. The containing field is
    // the source of meaning, exactly as it is for converted and raw map data.
    REQUIRE(rows.size() == 2);
    CHECK(rows[0]["value"] == 255);
    CHECK(rows[0]["displayValue"].get<std::string>().find("UNLIMITED") != std::string::npos);
    CHECK(rows[0]["domain"]["domainId"] == fixture.speed);
    CHECK(rows[1]["value"] == 12);
    CHECK(rows[1]["displayValue"].get<std::string>().find("1.2 m") != std::string::npos);
    CHECK(rows[1]["domain"]["domainId"] == fixture.width);
}

TEST_CASE(
    "Value summaries separate actual domains and exclude sentinel statistics",
    "[erdblick.schema][projection]")
{
    erdblick::test::ScalarSchema fixture;
    auto strings = std::make_shared<mapget::StringPool>(fixture.source.stringPoolId_);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        mapget::TileId{},
        fixture.source.stringPoolId_,
        fixture.source.mapId_,
        fixture.source.getLayer("Road"),
        strings,
        "result",
        1);
    std::vector<simfil::Value> values{
        fixture.number(0, fixture.speed),
        fixture.number(50, fixture.speed),
        fixture.number(254, fixture.speed),
        fixture.number(255, fixture.speed),
        fixture.number(0, fixture.classicSpeed),
        fixture.number(120, fixture.classicSpeed),
        fixture.number(255, fixture.classicSpeed),
        simfil::Value(int64_t{255}),
        simfil::Value(simfil::Bitmask{
            UINT64_C(0x8000000000000001),
            {fixture.owner->binding(), fixture.flags}})};
    auto sequence = subset->copySequence(values);
    REQUIRE(sequence);
    auto channel = subset->newChannel(
        "results",
        mapget::Scope::Feature,
        0,
        {},
        std::vector<std::string>{"mixed"});
    auto geometry = subset->newGeometryCollection(1);
    auto point = subset->newGeometry(mapget::GeomType::Points, 1);
    point->append({11., 48., 0.});
    geometry->addGeometry(point);
    channel->newFeatureEntry(
        subset->newFeatureId("Road", {{"id", int64_t{1}}}),
        geometry,
        std::vector<simfil::ModelNode::Ptr>{*sequence});
    simfil::Trace trace;
    trace.calls = 1;
    trace.values = values;
    subset->setTraces({{"mixed", std::move(trace)}});
    auto result = erdblick::TileSubsetLayer(subset).valueSummaries(0, 16, 512);
    REQUIRE(result["resultFields"].size() == 4);
    auto const& live = result["resultFields"][0]["summary"];
    CHECK(live["count"] == 4);
    CHECK(live["specials"] == 3);
    CHECK(live["numeric"]["count"] == 1);
    CHECK(live["numeric"]["min"] == 50);
    CHECK(live["numeric"]["max"] == 50);
    auto const& classic = result["resultFields"][1]["summary"];
    CHECK(classic["specials"] == 1);
    CHECK(classic["numeric"]["min"] == 0);
    CHECK(classic["numeric"]["average"] == 60);
    auto const& calculated = result["resultFields"][2]["summary"];
    CHECK_FALSE(calculated.contains("domain"));
    CHECK(calculated["numeric"]["min"] == 255);
    auto const& masks = result["resultFields"][3]["summary"];
    CHECK(masks["kinds"]["bitmask"] == 1);
    CHECK(masks["histogram"][0]["value"] == "0x8000000000000001");
    CHECK_FALSE(masks.contains("numeric"));
    REQUIRE(result["traces"].size() == 4);
    for (size_t index = 0; index < 4; ++index)
        CHECK(result["traces"][index]["summary"] == result["resultFields"][index]["summary"]);
}
