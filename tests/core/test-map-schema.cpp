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
             {"uniqueIdCompositions", {{{{"partId", "roadId"}, {"datatype", "U32"}}}}}});
        if (std::string_view(name) == "Road") {
            auto root = layer->newFeature(std::move(info));
            layer->setRootSchema(root.id());
        }
        else {
            // A relation target needs an identity definition but no invented
            // feature root or claim that the Road layer produces Junctions.
            graph->addFeatureType(std::move(info));
        }
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
    REQUIRE(parser.featureTypes("StillReady", "Road") == nlohmann::json::array({"Road"}));
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
    REQUIRE(first.featureTypes("First", "Road") == nlohmann::json::array({"Road"}));

    // Reference identities survive the binary roundtrip and remain usable for
    // decoding, without becoming roots or destinations in the omnibar.
    auto const& installed = first.info_.at("First");
    auto const& roadLayer = installed.layers_.at("Road");
    REQUIRE(installed.mapSchema_->featureIdentities().size() == 2);
    REQUIRE(roadLayer->getTypeInfo("Junction") == installed.mapSchema_->getTypeInfo("Junction"));
    REQUIRE(roadLayer->layerSchema()->featureSchema("Junction") == simfil::NoTypeId);
    auto targets = first.filterFeatureJumpTargets("7");
    REQUIRE(targets.size() == 1);
    REQUIRE(targets.front().jumpTarget_.name_ == "Road");
    REQUIRE_FALSE(targets.front().error_.has_value());
}

TEST_CASE(
    "Jump suggestions retain type prefixes and valid bare IDs without unrelated errors",
    "[erdblick.schema][erdblick.identity]")
{
    auto graph = schemaFixture();
    auto const id = std::string(graph->schemaId());
    erdblick::TileLayerParser parser;
    parser.installMapSchema(schemaBytes(*graph), id);
    parser.setDataSourceInfo(sourceFixture("JumpSuggestions", id));

    for (auto const* query : {"", " \t\n", "WARNING_SIGN", "Unknown.7", "7.8"}) {
        CAPTURE(query);
        CHECK(parser.filterFeatureJumpTargets(query).empty());
    }
    for (auto const* query : {"7", "Road.7", "Ro.7", " \tRoad.007  "}) {
        CAPTURE(query);
        auto targets = parser.filterFeatureJumpTargets(query);
        REQUIRE(targets.size() == 1);
        CHECK_FALSE(targets.front().error_);
        CHECK(targets.front().jumpTarget_.name_ == "Road");
        CHECK(std::get<int64_t>(targets.front().parsedParams_.front().second) == 7);
    }
    // A recognizable prefix still teaches the required ID composition.
    auto incomplete = parser.filterFeatureJumpTargets("Ro");
    REQUIRE(incomplete.size() == 1);
    CHECK(incomplete.front().error_.has_value());
    CHECK(std::get<std::string>(incomplete.front().parsedParams_.front().second) == "?");
}

TEST_CASE(
    "Jump targets preserve optional identity parts through canonical views",
    "[erdblick.schema][erdblick.identity]")
{
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    auto root = layer->newFeature(mapget::FeatureTypeInfo::fromJson(
        {{"name", "Road"},
         {"uniqueIdCompositions",
          nlohmann::json::array({nlohmann::json::array(
              {{{"partId", "roadId"}, {"datatype", "U32"}},
               {{"partId", "section"}, {"datatype", "STR"}, {"isOptional", true}}})})}}));
    layer->setRootSchema(root.id());
    graph->finalize();
    auto const id = std::string(graph->schemaId());
    erdblick::TileLayerParser parser;
    parser.installMapSchema(schemaBytes(*graph), id);
    parser.setDataSourceInfo(sourceFixture("JumpViews", id));

    for (auto const& query : {"Road.007", "Road.007.North"}) {
        auto targets = parser.filterFeatureJumpTargets(query);
        REQUIRE(targets.size() == 2);
        auto valid =
            std::ranges::find_if(targets, [](auto const& target) { return !target.error_; });
        REQUIRE(valid != targets.end());
        auto projected = valid->toJsValue();
        auto const& json = *projected;
        CHECK(json.at("name") == "Road");
        CHECK(json.at("maps") == nlohmann::json::array({"JumpViews"}));
        CHECK(json.at("idParts")[0] == nlohmann::json({{"key", "roadId"}, {"value", 7}}));
        if (query == std::string_view("Road.007.North")) {
            CHECK(
                json.at("idParts")[1] == nlohmann::json({{"key", "section"}, {"value", "North"}}));
        }
        else {
            CHECK(json.at("idParts").size() == 1);
        }
    }
}

TEST_CASE(
    "Inspection reads unsigned ID encoding from canonical identity views",
    "[erdblick.schema][erdblick.identity]")
{
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    auto root = layer->newFeature(mapget::FeatureTypeInfo::fromJson(
        {{"name", "Road"},
         {"uniqueIdCompositions", {{{{"partId", "roadId"}, {"datatype", "U64"}}}}}}));
    layer->setRootSchema(root.id());
    graph->finalize();
    auto source = mapget::DataSourceInfo::fromJson(
        nlohmann::json::parse(
            sourceFixture("UnsignedViews", std::string(graph->schemaId())).toString())
            .front(),
        [graph](std::string_view) { return graph; });
    auto strings = std::make_shared<mapget::StringPool>(source.stringPoolId_);
    auto tile = std::make_shared<mapget::TileFeatureLayer>(
        mapget::TileId{},
        source.stringPoolId_,
        source.mapId_,
        source.getLayer("Road"),
        strings);
    // The native feature-ID representation uses signed storage for uint64 bits.
    // Inspection must preserve the unsigned decimal spelling at the UI boundary.
    auto feature = tile->newFeature("Road", {{"roadId", int64_t{-1}}});
    auto projected = erdblick::InspectionConverter().convert(feature);
    auto const& identifiers = (*projected).front().at("children");
    auto part = std::ranges::find_if(
        identifiers,
        [](auto const& row) { return row.at("key") == "roadId"; });
    REQUIRE(part != identifiers.end());
    CHECK(part->at("value") == "18446744073709551615");
}

TEST_CASE(
    "Layer suggestions preserve unknown names without confusing the empty key",
    "[erdblick.schema][erdblick.search]")
{
    auto graph = std::make_shared<mapget::MapSchema>();
    for (auto const* name : {"Closed", "Open"}) {
        auto layer = graph->newLayer(name, mapget::LayerType::Features);
        auto root = graph->newObjectType(mapget::LayerSchema::FeatureKind);
        root.setOpen(std::string_view(name) == "Open");
        root.addField("", graph->newScalarType(simfil::SchemaType::Kind::String));
        layer->addFeatureType(
            mapget::FeatureTypeInfo::fromJson(
                {{"name", "Thing"},
                 {"uniqueIdCompositions", {{{{"partId", "thingId"}, {"datatype", "U32"}}}}}}),
            root.id());
        layer->setRootSchema(root.id());
    }
    graph->finalize();
    erdblick::TileLayerParser parser;
    auto const id = std::string(graph->schemaId());
    parser.installMapSchema(schemaBytes(*graph), id);
    parser.setDataSourceInfo(erdblick::SharedUint8Array(
        nlohmann::json::array(
            {{{"mapId", "Suggestions"},
              {"stringPoolId", "Suggestions"},
              {"schemaId", id},
              {"layers",
               {{"Closed", {{"layerId", "Closed"}, {"type", "Features"}}},
                {"Open", {{"layerId", "Open"}, {"type", "Features"}}}}}}})
            .dump()));
    auto fields = parser.getMapLayersForQuery("missingQueryField", nlohmann::json::object());
    CHECK(
        fields.at("mapLayers") ==
        nlohmann::json::array({{{"mapId", "Suggestions"}, {"layerId", "Open"}}}));
    // Unknown object fields remain possible; undeclared enum meanings do not.
    auto enums = parser.getMapLayersForQuery("\"NEVER_DECLARED_ENUM\"", nlohmann::json::object());
    CHECK(enums.at("mapLayers").empty());
    CHECK(graph->dictionary().get("missingQueryField") == simfil::StringPool::Empty);
    CHECK(graph->dictionary().get("NEVER_DECLARED_ENUM") == simfil::StringPool::Empty);
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
    REQUIRE(parser.featureTypes("First", "Road") == nlohmann::json::array({"Road"}));
}

TEST_CASE(
    "Scalar metadata preserves enum ordinals separately from logical labels",
    "[erdblick.schema]")
{
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Raw", mapget::LayerType::SourceData);
    auto type = graph->newScalarType(simfil::SchemaType::Kind::String);
    layer->setRootSchema(type.id());
    type.addNamedValue({.name = "LOW", .value = std::string_view{"LOW"}, .rawValue = int64_t{-1}});
    type.addNamedValue({.name = "HIGH", .value = std::string_view{"HIGH"}, .rawValue = UINT64_MAX});
    type.addNamedValue({.name = "PLAIN", .value = std::string_view{"PLAIN"}});
    graph->finalize();

    auto metadata = erdblick::JsValue::fromSchema(type);
    auto const& values = (*metadata).at("namedValues");
    REQUIRE(values.size() == 3);
    CHECK((*metadata).at("typeId") == type.id());
    CHECK(values[0].at("value") == "LOW");
    CHECK(values[0].at("rawValue") == -1);
    CHECK(values[1].at("value") == "HIGH");
    CHECK(values[1].at("rawValue") == "18446744073709551615");
    CHECK_FALSE(values[2].contains("rawValue"));
}

TEST_CASE(
    "Search styling recognizes coded enum labels with unknown integer alternatives",
    "[erdblick.schema][erdblick.search]")
{
    using Type = simfil::SchemaType;
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    auto properties = graph->newObjectType();
    auto warning = graph->newCompositionType(Type::Composition::AnyOf);
    auto labels = graph->newEnumType();
    std::vector<std::string> symbols{"GENERAL_HAZARD", "CURVE_LEFT"};
    for (auto const& symbol : symbols)
        labels.addSymbol(symbol);
    warning.addAlternative(labels);
    warning.addAlternative(graph->newScalarType(Type::Kind::Int));
    warning.addNamedValue(
        {.name = "GENERAL_HAZARD",
         .value = std::string_view{"GENERAL_HAZARD"},
         .rawValue = int64_t{0}});
    warning.addNamedValue(
        {.name = "CURVE_LEFT", .value = std::string_view{"CURVE_LEFT"}, .rawValue = int64_t{10}});
    properties.addField("warningSign", warning);
    auto root = layer->newFeature(
        mapget::FeatureTypeInfo::fromJson(
            {{"name", "Road"},
             {"uniqueIdCompositions", {{{{"partId", "roadId"}, {"datatype", "U32"}}}}}}),
        properties);
    layer->setRootSchema(root.id());
    graph->finalize();

    erdblick::TileLayerParser parser;
    parser.installMapSchema(schemaBytes(*graph), std::string(graph->schemaId()));
    parser.setDataSourceInfo(sourceFixture("Signs", std::string(graph->schemaId())));
    auto inventory = parser.searchStyleFieldsForQuery("true", "feature", nlohmann::json::object());
    auto const& fields = inventory.at("fields");
    auto field = std::ranges::find_if(
        fields,
        [](auto const& value) { return value.at("path") == "attributes.warningSign"; });
    REQUIRE(field != fields.end());
    auto const& type = inventory.at("types").at(field->at("metadata").template get<size_t>());
    CHECK(type.at("valueKind") == "enum");
    CHECK(type.at("enumValues") == nlohmann::json::array({"CURVE_LEFT", "GENERAL_HAZARD"}));
    CHECK(type.at("schemaType").at("typeId") == warning.id());
    CHECK_FALSE(type.contains("numericRange"));
}

TEST_CASE(
    "Search styling exports widths only for concrete bitmask types",
    "[erdblick.schema][erdblick.search]")
{
    using Type = simfil::SchemaType;
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    auto properties = graph->newObjectType();
    for (auto const& [name, kind] :
         {std::pair{"any", Type::Kind::Any},
          {"unknown", Type::Kind::Unknown},
          {"value", Type::Kind::Value},
          {"flags", Type::Kind::Bitmask}})
    {
        auto type = graph->newType(kind);
        properties.addField(name, type);
        if (kind == Type::Kind::Bitmask)
            type.asBitmask().setBitWidth(8);
    }
    auto root = layer->newFeature(
        mapget::FeatureTypeInfo::fromJson(
            {{"name", "Road"},
             {"uniqueIdCompositions", {{{{"partId", "roadId"}, {"datatype", "U32"}}}}}}),
        properties);
    layer->setRootSchema(root.id());
    graph->finalize();

    erdblick::TileLayerParser parser;
    parser.installMapSchema(schemaBytes(*graph), std::string(graph->schemaId()));
    parser.setDataSourceInfo(sourceFixture("StyleDomains", std::string(graph->schemaId())));
    auto inventory =
        parser.searchStyleFieldsForQuery("true", "feature", {{"path", {"attributes"}}});
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
    using Type = simfil::SchemaType;
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    auto width = graph->newScalarType(Type::Kind::Int);
    auto nested = graph->newObjectType();
    nested.addField("width", width);
    for (auto const* type : {"Road", "Building"}) {
        // This is a metadata-only root for testing arbitrary field spellings
        // and Context edges. A native Feature factory owns a fixed envelope;
        // its real geometry/relations would add unrelated recursive branches.
        auto root = graph->newObjectType(mapget::LayerSchema::FeatureKind);
        auto properties = graph->newObjectType();
        properties.addField("width", width);
        properties.addField("nested", nested);
        properties.addField(
            "meaning",
            graph->newScalarType(
                std::string_view(type) == "Road" ? Type::Kind::Int : Type::Kind::String));
        root.addField("properties", properties);
        root.addField("$value", width);
        root.addField("$feature", root).setRole(Type::FieldRole::Context);
        layer->addFeatureType(
            mapget::FeatureTypeInfo::fromJson(
                {{"name", type},
                 {"uniqueIdCompositions", {{{{"partId", "roadId"}, {"datatype", "U32"}}}}}}),
            root.id());
        if (std::string_view(type) == "Road")
            layer->setRootSchema(root.id());
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
    using Type = simfil::SchemaType;
    auto graph = std::make_shared<mapget::MapSchema>();
    auto layer = graph->newLayer("Road", mapget::LayerType::Features);
    auto root = layer->newFeature(mapget::FeatureTypeInfo::fromJson(
        {{"name", "Road"},
         {"uniqueIdCompositions", {{{{"partId", "roadId"}, {"datatype", "U32"}}}}}}));
    auto samples = graph->newArrayType();
    auto alternatives = graph->newCompositionType(Type::Composition::AnyOf);
    auto reading = graph->newObjectType();
    auto label = graph->newObjectType();
    reading.addField("reading", graph->newScalarType(Type::Kind::Int));
    label.addField("label", graph->newScalarType(Type::Kind::String));
    alternatives.addAlternative(reading);
    alternatives.addAlternative(label);
    samples.addElement(alternatives);
    root.properties().addField("samples", samples);
    layer->setRootSchema(root.id());
    graph->finalize();

    erdblick::TileLayerParser parser;
    parser.installMapSchema(schemaBytes(*graph), std::string(graph->schemaId()));
    parser.setDataSourceInfo(sourceFixture("Catalog", std::string(graph->schemaId())));
    auto all = parser.searchStyleFieldsForQuery(
        "false",
        "feature",
        {{"path", {"attributes"}}, {"values", "scalar"}});
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
        fixture.owner->schemaType(fixture.flags)})));
    CHECK(*flags.value_ == "0x8000000000000003");
    CHECK(flags.displayValue_.find("BOTH") != std::string::npos);
    CHECK(flags.displayValue_.find("CAR_ALIAS") != std::string::npos);
    CHECK(flags.displayValue_.find("unknown bits 0x8000000000000000") != std::string::npos);
    Node zero;
    REQUIRE(zero.setScalarValue(simfil::Value(simfil::Bitmask{
        0,
        fixture.owner->schemaType(fixture.flags)})));
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
        auto feature = tile->newFeature("Road", {{"roadId", int64_t{1}}});
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
            fixture.owner->schemaType(fixture.flags)})};
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
        subset->newFeatureId("Road", {{"roadId", int64_t{1}}}),
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
