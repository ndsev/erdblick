#include <catch2/catch_test_macros.hpp>

#include "erdblick/layer.h"
#include "erdblick/parser.h"
#include "mapget/model/info.h"
#include "mapget/model/feature.h"
#include "mapget/model/sourcedata.h"
#include "mapget/model/sourcedatalayer.h"
#include "mapget/model/stringpool.h"
#include "nlohmann/json.hpp"

TEST_CASE(
    "SourceData inspection reuses propagated feature summaries",
    "[erdblick.inspection][sourcedata]")
{
    auto layerInfo = mapget::LayerInfo::fromJson(nlohmann::json::parse(R"json(
        {
            "layerId": "SourceData-Test",
            "type": "SourceData"
        }
    )json"));
    auto strings = std::make_shared<mapget::StringPool>("SourceDataInspection");
    auto model = std::make_shared<mapget::TileSourceDataLayer>(
        mapget::TileId{},
        "SourceDataInspection",
        "TestMap",
        layerInfo,
        strings);

    auto root = model->newCompound(2);
    root->setSchemaName("Example.Root");
    root->setSourceDataAddress({0, 64});
    auto details = model->newCompound(2);
    details->setSchemaName("Example.Details");
    details->setSourceDataAddress({8, 32});
    REQUIRE(details->object()->addField("speed", int64_t{50}));
    REQUIRE(details->object()->addBool("enabled", true));
    REQUIRE(root->object()->addField("details", details));
    model->addRoot(root);

    auto result = erdblick::TileSourceDataLayer(model).toObject();
    REQUIRE(result.value("schemaType", std::string{}) == "Example.Root");
    REQUIRE(result.contains("children"));
    REQUIRE(result.at("children").size() == 1);

    auto const& detailsNode = result.at("children").front();
    REQUIRE(detailsNode.value("schemaType", std::string{}) == "Example.Details");
    REQUIRE(detailsNode.contains("valueBubbles"));
    REQUIRE(detailsNode.at("valueBubbles").size() == 2);
    REQUIRE(detailsNode.at("children").at(0).value("nodeId", std::string{}) ==
            "0:details/0:speed");
}

TEST_CASE(
    "SourceData inspection bounds wide aggregate summaries",
    "[erdblick.inspection][sourcedata]")
{
    auto layerInfo = mapget::LayerInfo::fromJson(nlohmann::json::parse(R"json(
        {
            "layerId": "SourceData-Test",
            "type": "SourceData"
        }
    )json"));
    auto strings = std::make_shared<mapget::StringPool>("SourceDataInspection");
    auto model = std::make_shared<mapget::TileSourceDataLayer>(
        mapget::TileId{},
        "SourceDataInspection",
        "TestMap",
        layerInfo,
        strings);

    auto root = model->newCompound(1);
    auto values = model->newCompound(150);
    for (auto index = 0; index < 150; ++index) {
        REQUIRE(values->object()->addField(
            "value" + std::to_string(index),
            static_cast<int64_t>(index)));
    }
    REQUIRE(root->object()->addField("values", values));
    model->addRoot(root);

    auto result = erdblick::TileSourceDataLayer(model).toObject();
    auto const& valuesNode = result.at("children").front();
    REQUIRE(valuesNode.at("children").size() == 150);
    REQUIRE(valuesNode.at("valueBubbles").size() == 101);
    REQUIRE(valuesNode.at("valueBubbles").back().value("label", std::string{}) == "…");
    REQUIRE(valuesNode.at("valueBubbles").back().value("kind", std::string{}) == "overflow");
}

TEST_CASE("Incoming inspection preserves the source owner and relation ordinal", "[erdblick.inspection][incoming]")
{
    using namespace mapget;
    auto info = LayerInfo::fromJson(nlohmann::json::parse(R"({"layerId":"Surface","type":"Features",
        "featureTypes":[{"name":"Surface","uniqueIdCompositions":[[{"partId":"id","datatype":"U64"}]]},
                        {"name":"Lane","uniqueIdCompositions":[[{"partId":"id","datatype":"U64"}]]}]})"));
    auto sourceInfo =
        LayerInfo::fromJson(nlohmann::json::parse(R"({"layerId":"Lane","type":"Features",
        "featureTypes":[{"name":"Surface","uniqueIdCompositions":[[{"partId":"id","datatype":"U64"}]]},
                        {"name":"Lane","uniqueIdCompositions":[[{"partId":"id","datatype":"U64"}]]}]})"));
    auto strings = std::make_shared<StringPool>("IncomingInspection");
    auto target = std::make_shared<mapget::TileFeatureLayer>(TileId::fromTileXY(1,1,2),
        "IncomingInspection", "Map", info, strings);
    auto source = std::make_shared<mapget::TileFeatureLayer>(target->partitionId(),
        "IncomingInspection", "Map", sourceInfo, strings);
    target->newFeature("Surface", {{"id", int64_t{1}}});
    erdblick::TileLayerParser parser;
    auto catalog = nlohmann::json::array(
        {{{"mapId", "Map"},
          {"stringPoolId", "IncomingInspection"},
          {"layers",
           {{"Surface",
             {{"incomingRelationTargetTypes", {"Surface"}},
              {"incomingRelationCoverageUnknown", false}}}}}}});
    parser.setIncomingRelationHints(erdblick::SharedUint8Array(catalog.dump()));
    CHECK(parser.hasIncomingRelations(erdblick::TileFeatureLayer(target), "Surface.1"));
    catalog[0]["layers"]["Surface"]["incomingRelationTargetTypes"] = nlohmann::json::array();
    parser.setIncomingRelationHints(erdblick::SharedUint8Array(catalog.dump()));
    CHECK_FALSE(parser.hasIncomingRelations(erdblick::TileFeatureLayer(target), "Surface.1"));
    parser.setDataSourceInfo(erdblick::SharedUint8Array("[]"));
    CHECK(parser.hasIncomingRelations(
        erdblick::TileFeatureLayer(target),
        "Surface.1"));  // Missing means unknown.
    auto lane = source->newFeature("Lane", {{"id", int64_t{7}}});
    lane->addRelation("ordinary", "Surface", {{"id", int64_t{1}}});
    lane->addRelation("visible", "Surface", {{"id", int64_t{1}}});
    IncomingRelationCollection collection;
    collection.target_ = target->id(); collection.featureId_ = "Surface.1";
    collection.snapshots_ = {target->id(), source->id()};
    collection.scope_ = {source->id()};
    collection.relations_ = {{source->id(), "Lane.7", 1, "visible", "Surface.1"}};
    erdblick::IncomingInspection inspection(collection.toJson().dump(), target->id().toString(), "Surface.1");
    inspection.addSnapshot(erdblick::TileFeatureLayer(target));
    CHECK_THROWS(inspection.inspectionModel());
    inspection.addSnapshot(erdblick::TileFeatureLayer(source));
    auto result = inspection.inspectionModel();
    REQUIRE(result.size() == 1);
    CHECK(result[0]["key"] == "Incoming Relations");
    auto owner = result[0]["children"][0];
    CHECK(owner["mapTileKey"] == source->id().toString());
    CHECK(owner["value"] == "Lane.7");
    REQUIRE(owner["children"].size() == 1);
    CHECK(owner["children"][0]["key"] == "visible");
    CHECK(owner["children"][0]["hoverId"] == "Lane.7:relation#1");
    CHECK(owner["children"][0]["geoJsonPath"] == "select(relations.*{name = \"visible\"}, 0)");
    CHECK(owner["children"][0]["nodeId"].get<std::string>().find(source->id().toString()) != std::string::npos);
    CHECK(owner["children"][0]["nodeId"].get<std::string>().ends_with(":relation#1"));
    CHECK(target->find("Surface.1")->numRelations() == 0);
}
