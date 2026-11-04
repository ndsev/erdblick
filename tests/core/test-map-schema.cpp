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

#include <algorithm>
#include <sstream>
#include <utility>

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
    parser.setDataSourceInfo(sourceFixture("StillReady", id));
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
    REQUIRE_THROWS(first.setDataSourceInfo(sourceFixture("First", id)));
    REQUIRE_THROWS(first.installMapSchema(bytes, id + "-wrong"));
    first.installMapSchema(bytes, id);
    second.installMapSchema(bytes, id);
    first.setDataSourceInfo(sourceFixture("First", id));
    second.setDataSourceInfo(sourceFixture("Second", id));
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
    parser.setDataSourceInfo(sourceFixture("First", id));
    auto retained = parser.info_.at("First").mapSchema_;
    REQUIRE_THROWS(parser.setDataSourceInfo(sourceFixture("Replacement", "unknown-schema")));
    REQUIRE(parser.info_.at("First").mapSchema_ == retained);
    REQUIRE(parser.featureTypes("First", "Road", false) == nlohmann::json::array({"Road"}));
}

TEST_CASE(
    "Scalar metadata preserves enum ordinals separately from logical labels",
    "[erdblick.schema]")
{
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Raw", mapget::LayerType::SourceData);
    auto type = layer->addSchema(simfil::Schema::Kind::String);
    layer->setRootSchema(type);
    layer->addNamedValue(
        type,
        {.name = "LOW", .value = std::string_view{"LOW"}, .rawValue = int64_t{-1}});
    layer->addNamedValue(
        type,
        {.name = "HIGH", .value = std::string_view{"HIGH"}, .rawValue = UINT64_MAX});
    layer->addNamedValue(type, {.name = "PLAIN", .value = std::string_view{"PLAIN"}});
    graph->finalize();

    auto metadata = erdblick::JsValue::fromSchema({graph->binding(), type});
    auto const& values = (*metadata).at("namedValues");
    REQUIRE(values.size() == 3);
    CHECK((*metadata).at("typeId") == type);
    CHECK(values[0].at("value") == "LOW");
    CHECK(values[0].at("rawValue") == -1);
    CHECK(values[1].at("value") == "HIGH");
    CHECK(values[1].at("rawValue") == "18446744073709551615");
    CHECK_FALSE(values[2].contains("rawValue"));
}

TEST_CASE(
    "Search styling exports widths only for concrete bitmask types",
    "[erdblick.schema][erdblick.search]")
{
    using Schema = simfil::Schema;
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    auto root =
        layer->addSchema(mapget::LayerSchema::FeatureKind, mapget::LayerSchema::featureKey("Road"));
    auto properties = layer->addSchema(Schema::Kind::Object);
    layer->addFieldSchema(root, "properties", properties);
    for (auto const& [name, kind] :
         {std::pair{"any", Schema::Kind::Any},
          {"unknown", Schema::Kind::Unknown},
          {"value", Schema::Kind::Value},
          {"flags", Schema::Kind::Bitmask}})
    {
        auto id = layer->addSchema(kind);
        layer->addFieldSchema(properties, name, id);
        if (kind == Schema::Kind::Bitmask)
            layer->setBitWidth(id, 8);
    }
    layer->addFeatureType(
        mapget::FeatureTypeInfo::fromJson(
            {{"name", "Road"},
             {"uniqueIdCompositions", {{{{"partId", "id"}, {"datatype", "U32"}}}}}}),
        root);
    layer->setRootSchema(root);
    graph->finalize();

    erdblick::TileLayerParser parser;
    parser.installMapSchema(schemaBytes(*graph), std::string(graph->schemaId()));
    parser.setDataSourceInfo(sourceFixture("StyleDomains", std::string(graph->schemaId())));
    auto inventory = parser.searchStyleFieldsForQuery("true", "feature", nlohmann::json::object());
    auto const& fields = inventory.at("fields");
    REQUIRE(inventory.at("complete") == true);

    // The picker lists only attributes. Explicit properties expressions keep
    // their query semantics; they do not create duplicate picker branches.
    for (auto const* name : {"any", "unknown", "value", "flags"}) {
        auto const path = std::string("attributes.") + name;
        INFO(path);
        auto field = std::ranges::find_if(fields,
            [&](auto const& candidate) { return candidate.at("path") == path; });
        REQUIRE(field != fields.end());
        auto const& metadata = inventory.at("types").at(field->at("metadata").get<size_t>());
        REQUIRE(metadata.contains("schemaType"));
        if (std::string_view(name) == "flags") {
            CHECK(metadata.at("valueKind") == "bitmask");
            CHECK(metadata.at("schemaType").at("bitWidth") == 8);
        }
        else {
            CHECK(metadata.at("valueKind") == "unknown");
            CHECK_FALSE(metadata.at("schemaType").contains("bitWidth"));
        }
    }
    REQUIRE(std::ranges::none_of(fields, [](auto const& field) {
        return field.at("path").template get<std::string>().starts_with("properties");
    }));
}

TEST_CASE(
    "Style discovery shares exact types and explores selected semantic branches without aliases",
    "[erdblick.schema][erdblick.search]")
{
    using Schema = simfil::Schema;
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    auto width = layer->addSchema(Schema::Kind::Int);
    auto nested = layer->addSchema(Schema::Kind::Object);
    layer->addFieldSchema(nested, "width", width);
    for (auto const* type : {"Road", "Building"}) {
        auto root = layer->addSchema(mapget::LayerSchema::FeatureKind);
        auto properties = layer->addSchema(Schema::Kind::Object);
        layer->addFieldSchema(properties, "width", width);
        layer->addFieldSchema(properties, "nested", nested);
        layer->addFieldSchema(properties, "meaning", layer->addSchema(
            std::string_view(type) == "Road" ? Schema::Kind::Int : Schema::Kind::String));
        layer->addFieldSchema(root, "properties", properties);
        layer->addFieldSchema(root, "$value", width);
        layer->addFieldSchema(root, "$feature", root);
        layer->setFieldRole(root, "$feature", Schema::FieldRole::Context);
        layer->addFeatureType(mapget::FeatureTypeInfo::fromJson({{"name", type},
            {"uniqueIdCompositions", {{{{"partId", "id"}, {"datatype", "U32"}}}}}}), root);
        if (std::string_view(type) == "Road") layer->setRootSchema(root);
    }
    graph->finalize();
    erdblick::TileLayerParser parser;
    parser.installMapSchema(schemaBytes(*graph), std::string(graph->schemaId()));
    parser.setDataSourceInfo(sourceFixture("Catalog", std::string(graph->schemaId())));
    auto const all = parser.searchStyleFieldsForQuery("false", "feature", {{"values", "scalar"}});
    auto const& fields = all.at("fields");
    auto find = [&](std::string const& path) {
        return std::ranges::find_if(fields, [&](auto const& field) { return field.at("path") == path; });
    };
    auto direct = find("attributes.width");
    auto descendant = find("attributes.nested.width");
    REQUIRE(direct != fields.end());
    REQUIRE(descendant != fields.end());
    CHECK(direct->at("metadata") == descendant->at("metadata"));
    CHECK(direct->at("contexts").size() == 2);
    CHECK(std::ranges::count_if(fields, [](auto const& field) {
        return field.at("path") == "attributes.meaning";
    }) == 2); // Same path, two meanings: neither is silently selected or erased.
    CHECK(find("$value") != fields.end());
    CHECK(find("$feature") == fields.end());
    CHECK(find("properties.width") == fields.end());
    CHECK(all.at("complete") == true);

    auto options = nlohmann::json{{"selectedFeatureTypes", {"Road"}},
        {"path", {"attributes"}}, {"recursive", false}, {"values", "scalar"}};
    auto branch = parser.searchStyleFieldsForQuery("another predicate", "feature", options);
    REQUIRE(branch.at("contexts").size() == 1);
    CHECK(branch.at("contexts")[0].at("featureType") == "Road");
    CHECK(std::ranges::none_of(branch.at("fields"), [](auto const& field) {
        return field.at("path") == "attributes.nested.width";
    }));
    REQUIRE(branch.at("branches").size() == 1);
    CHECK(branch.at("branches")[0].at("path") == nlohmann::json::array({"attributes", "nested"}));
    options["path"] = {"attributes", "nested"};
    auto child = parser.searchStyleFieldsForQuery("true", "feature", options);
    REQUIRE(child.at("fields").size() == 1);
    CHECK(child.at("fields")[0].at("path") == "attributes.nested.width");

    // Explicit contextual lookup remains possible even though the recursive
    // picker does not follow the owner edge on its own.
    options["path"] = {"$feature", "attributes"};
    auto contextual = parser.searchStyleFieldsForQuery("true", "feature", options);
    CHECK(std::ranges::any_of(contextual.at("fields"), [](auto const& field) {
        return field.at("path") == "$feature.attributes.width";
    }));
}

TEST_CASE(
    "Style discovery retains array elements and every object alternative",
    "[erdblick.schema][erdblick.search]")
{
    using Schema = simfil::Schema;
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    auto root = layer->addSchema(mapget::LayerSchema::FeatureKind);
    auto properties = layer->addSchema(Schema::Kind::Object);
    auto samples = layer->addSchema(Schema::Kind::Array);
    auto alternatives = layer->addSchema(Schema::Kind::Union);
    auto reading = layer->addSchema(Schema::Kind::Object);
    auto label = layer->addSchema(Schema::Kind::Object);
    layer->addFieldSchema(reading, "reading", layer->addSchema(Schema::Kind::Int));
    layer->addFieldSchema(label, "label", layer->addSchema(Schema::Kind::String));
    layer->addAlternative(alternatives, reading);
    layer->addAlternative(alternatives, label);
    layer->addElementSchema(samples, alternatives);
    layer->addFieldSchema(properties, "samples", samples);
    layer->addFieldSchema(root, "properties", properties);
    layer->addFeatureType(mapget::FeatureTypeInfo::fromJson({{"name", "Road"},
        {"uniqueIdCompositions", {{{{"partId", "id"}, {"datatype", "U32"}}}}}}), root);
    layer->setRootSchema(root);
    graph->finalize();

    erdblick::TileLayerParser parser;
    parser.installMapSchema(schemaBytes(*graph), std::string(graph->schemaId()));
    parser.setDataSourceInfo(sourceFixture("Catalog", std::string(graph->schemaId())));
    auto all = parser.searchStyleFieldsForQuery("false", "feature", {{"values", "scalar"}});
    for (auto const* path : {"attributes.samples.*.reading", "attributes.samples.*.label"}) {
        INFO(path);
        CHECK(std::ranges::any_of(all.at("fields"), [&](auto const& field) {
            return field.at("path") == path;
        }));
    }
    CHECK(all.at("complete") == true);
    CHECK(std::ranges::none_of(
        all.at("types"),
        [](auto const& type)
        { return type.at("valueKind") == "object" || type.at("valueKind") == "array"; }));

    auto options = nlohmann::json{{"path", {"attributes", "samples"}},
        {"recursive", false}, {"values", "scalar"}};
    auto array = parser.searchStyleFieldsForQuery("true", "feature", options);
    REQUIRE(array.at("branches").size() == 1);
    auto elementPath = nlohmann::json::array({"attributes", "samples", {{"elements", true}}});
    CHECK(array.at("branches")[0].at("path") == elementPath);
    options["path"] = elementPath;
    auto elements = parser.searchStyleFieldsForQuery("true", "feature", options);
    REQUIRE(elements.at("fields").size() == 2);
    CHECK(elements.at("fields")[0].at("path") == "attributes.samples.*.label");
    CHECK(elements.at("fields")[1].at("path") == "attributes.samples.*.reading");
}

TEST_CASE(
    "Inspection labels exact types while keeping raw numbers and masks",
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
    CHECK_FALSE(computed.scalarType_);
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
    CHECK(rows[0]["scalarType"]["typeId"] == fixture.speed);
    CHECK(rows[1]["value"] == 12);
    CHECK(rows[1]["displayValue"].get<std::string>().find("1.2 m") != std::string::npos);
    CHECK(rows[1]["scalarType"]["typeId"] == fixture.width);
}

TEST_CASE(
    "Native picking exports named foreign identities without a source composition",
    "[erdblick.schema][erdblick.picking]")
{
    erdblick::test::ScalarSchema fixture;
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        mapget::TileId{}, fixture.source.stringPoolId_, fixture.source.mapId_,
        fixture.source.getLayer("Road"), std::make_shared<mapget::StringPool>(fixture.source.stringPoolId_),
        "foreign-pick", 1);
    auto id = subset->newFeatureId("ExternalType", {
        {"large", INT64_MAX}, {"negative", INT64_MIN}, {"text", "007"}, {"__proto__", "plain-data"}
    }, "Remote");
    auto channel = subset->newChannel("features", mapget::Scope::Feature, 0, {}, {});
    channel->newFeatureEntry(id, subset->newGeometryCollection());
    auto result = erdblick::TileSubsetLayer(subset).resolvePick(0, 0, 0);
    CHECK_FALSE(result.contains("featureId"));
    CHECK(result.at("featureReference") == nlohmann::json{
        {"mapId", "Remote"}, {"typeId", "ExternalType"},
        {"id", {{"large", INT64_MAX}, {"negative", INT64_MIN}, {"text", "007"}, {"__proto__", "plain-data"}}}
    });
}

TEST_CASE(
    "Value summaries separate actual types and exclude sentinel statistics",
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
    CHECK_FALSE(calculated.contains("schemaType"));
    CHECK(calculated["numeric"]["min"] == 255);
    auto const& masks = result["resultFields"][3]["summary"];
    CHECK(masks["kinds"]["bitmask"] == 1);
    CHECK(masks["histogram"][0]["value"] == "0x8000000000000001");
    CHECK_FALSE(masks.contains("numeric"));
    REQUIRE(result["traces"].size() == 4);
    for (size_t index = 0; index < 4; ++index)
        CHECK(result["traces"][index]["summary"] == result["resultFields"][index]["summary"]);
}
