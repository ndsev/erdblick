#include <catch2/catch_test_macros.hpp>

#include "erdblick/inspection.h"
#include "erdblick/parser.h"
#include "erdblick/rule.h"
#include "erdblick/testdataprovider.h"
#include "erdblick/visualization.h"
#include "mapget/model/stringpool.h"
#include "nlohmann/json.hpp"

#include <iostream>

using namespace erdblick;

namespace {
std::shared_ptr<mapget::LayerInfo> relationTestLayerInfo()
{
    return mapget::LayerInfo::fromJson(nlohmann::json::parse(R"json(
    {
        "layerId": "RelationLayer",
        "type": "Features",
        "featureTypes": [
            {
                "name": "Diamond",
                "uniqueIdCompositions": [[
                    {"partId": "areaId", "datatype": "STR"},
                    {"partId": "diamondId", "datatype": "U32"}
                ]]
            },
            {
                "name": "PointOfInterest",
                "uniqueIdCompositions": [[
                    {"partId": "areaId", "datatype": "STR"},
                    {"partId": "pointId", "datatype": "U32"}
                ]]
            }
        ]
    })json"));
}

std::shared_ptr<mapget::TileFeatureLayer> makeRelationTestTile(
    mapget::TileId tileId,
    bool includeSource,
    bool includeTarget)
{
    auto layer = std::make_shared<mapget::TileFeatureLayer>(
        tileId,
        "RelationTestNode",
        "RelationTestMap",
        relationTestLayerInfo(),
        std::make_shared<simfil::StringPool>());
    layer->setIdPrefix({{"areaId", "Area"}});

    auto const center = tileId.center();
    if (includeSource) {
        auto source = layer->newFeature("Diamond", {{"diamondId", 1}});
        source->addLine({
            {center.x - 0.0005, center.y, 0.0},
            {center.x + 0.0005, center.y, 0.0},
        });
        source->addRelation("hasPoi", "PointOfInterest", {{"areaId", "Area"}, {"pointId", 200}});
    }
    if (includeTarget) {
        auto target = layer->newFeature("PointOfInterest", {{"pointId", 200}});
        target->addPoint({center.x, center.y + 0.0005, 0.0});
    }
    return layer;
}

FeatureLayerStyle relationTestStyle()
{
    return FeatureLayerStyle(SharedUint8Array(R"yaml(
name: "RelationTestStyle"
rules:
  - type: "Diamond"
    aspect: relation
    relation-type: "hasPoi"
    color: "#ff5500"
    width: 4
)yaml"));
}

std::shared_ptr<mapget::TileFeatureLayer> makeSecondaryReferenceSourceTile(mapget::TileId tileId)
{
    auto layer = std::make_shared<mapget::TileFeatureLayer>(
        tileId,
        "RelationTestNode",
        "RelationTestMap",
        relationTestLayerInfo(),
        std::make_shared<simfil::StringPool>());
    layer->setIdPrefix({{"areaId", "Area"}});

    auto const center = tileId.center();
    auto source = layer->newFeature("Diamond", {{"diamondId", 1}});
    source->addLine({
        {center.x - 0.0005, center.y, 0.0},
        {center.x + 0.0005, center.y, 0.0},
    });
    source->addRelation("hasPoi", "SecondaryPointOfInterest", {{"poiRef", 77}});
    return layer;
}
}

TEST_CASE("DeckFeatureLayerVisualization", "[erdblick.renderer]")
{
    auto style = TestDataProvider::style();
    DeckFeatureLayerVisualization visualization(0, "Features:Test:Test:0", style, {}, {});
    REQUIRE(visualization.abiVersion() == 1);
}

TEST_CASE("FeatureInspection", "[erdblick.inspection]")
{
    TileLayerParser tlp;
    auto testLayer = TestDataProvider(tlp).getTestLayer(42., 11., 13);
    for (auto const& f : *testLayer) {
        auto inspection = InspectionConverter().convert(f);
        std::cout << inspection.value_.dump(4) << std::endl;

        REQUIRE(inspection.size() > 0);
        REQUIRE(inspection.at(0)["key"].as<std::string>() == "Identifiers");

        bool hasFeatureRoot = false;
        for (uint32_t i = 0; i < inspection.size(); ++i) {
            if (inspection.at(i)["key"].as<std::string>() == "Feature") {
                hasFeatureRoot = true;
                break;
            }
        }
        REQUIRE_FALSE(hasFeatureRoot);
    }
}

TEST_CASE("FeatureStyleRuleLodFilterParsing", "[erdblick.style]")
{
    auto yamlWithLod = YAML::Load(R"(
type: Road
geometry: [line]
lod: 3
)");
    FeatureStyleRule ruleWithLod(yamlWithLod, 0);
    REQUIRE(ruleWithLod.lod().has_value());
    REQUIRE(*ruleWithLod.lod() == 3);

    auto yamlWithInvalidLod = YAML::Load(R"(
type: Road
geometry: [line]
lod: 42
)");
    FeatureStyleRule ruleWithInvalidLod(yamlWithInvalidLod, 0);
    REQUIRE_FALSE(ruleWithInvalidLod.lod().has_value());
}

TEST_CASE("FeatureStyleRuleOffsetIncrementParsing", "[erdblick.style]")
{
    auto yaml = YAML::Load(R"(
type: Road
geometry: [line]
offset: [1.0, 2.0, 3.0]
offset-increment: [4.0, 5.0, 6.0]
)");
    FeatureStyleRule rule(yaml, 0);
    REQUIRE(rule.offset() == glm::dvec3(1.0, 2.0, 3.0));
    REQUIRE(rule.offsetIncrement() == glm::dvec3(4.0, 5.0, 6.0));
}

TEST_CASE("DeckFeatureLayerVisualization renders intra-tile relations", "[erdblick.renderer]")
{
    auto style = relationTestStyle();
    auto tile = makeRelationTestTile(mapget::TileId::fromWgs84(42.0, 11.0, 13), true, true);

    DeckFeatureLayerVisualization visualization(0, "RelationTestMap/RelationLayer/0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(tile));
    visualization.run();

    SharedUint8Array pathPositions;
    visualization.pathPositionsRaw(pathPositions);

    REQUIRE_FALSE(pathPositions.bytes().empty());
}

TEST_CASE("DeckFeatureLayerVisualization resolves relation targets from added auxiliary tiles", "[erdblick.renderer]")
{
    auto style = relationTestStyle();
    auto sourceTileId = mapget::TileId::fromWgs84(42.0, 11.0, 13);
    auto sourceTile = makeRelationTestTile(sourceTileId, true, false);
    auto auxiliaryTile = makeRelationTestTile(sourceTileId.neighbor(1, 0), false, true);

    DeckFeatureLayerVisualization visualization(0, "RelationTestMap/RelationLayer/0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(sourceTile));
    visualization.addTileFeatureLayer(TileFeatureLayer(auxiliaryTile));
    visualization.run();

    SharedUint8Array pathPositions;
    visualization.pathPositionsRaw(pathPositions);

    REQUIRE_FALSE(pathPositions.bytes().empty());
}

TEST_CASE("DeckFeatureLayerVisualization exposes unresolved external relation references", "[erdblick.renderer]")
{
    auto style = relationTestStyle();
    auto sourceTile = makeRelationTestTile(mapget::TileId::fromWgs84(42.0, 11.0, 13), true, false);

    DeckFeatureLayerVisualization visualization(0, "RelationTestMap/RelationLayer/0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(sourceTile));
    visualization.run();

    auto unresolvedReferences =
        nlohmann::json(visualization.externalRelationReferences());
    REQUIRE(unresolvedReferences.is_array());
    REQUIRE(unresolvedReferences.size() == 1);
    REQUIRE(unresolvedReferences[0]["mapId"].get<std::string>() == "RelationTestMap");
    REQUIRE(unresolvedReferences[0]["typeId"].get<std::string>() == "PointOfInterest");
}

TEST_CASE("DeckFeatureLayerVisualization resolves external relations with canonical locate ids", "[erdblick.renderer]")
{
    auto style = relationTestStyle();
    auto sourceTile = makeSecondaryReferenceSourceTile(mapget::TileId::fromWgs84(42.0, 11.0, 13));
    auto targetTile = makeRelationTestTile(mapget::TileId::fromWgs84(42.0, 11.0, 13).neighbor(1, 0), false, true);

    DeckFeatureLayerVisualization visualization(0, "RelationTestMap/RelationLayer/0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(sourceTile));
    visualization.run();

    visualization.addTileFeatureLayer(TileFeatureLayer(targetTile));
    visualization.processResolvedExternalReferences(nlohmann::json::array({
        nlohmann::json::array({
            {
                {"tileId", "RelationTestMap/RelationLayer/1"},
                {"typeId", "PointOfInterest"},
                {"featureId", nlohmann::json::array({"areaId", "Area", "pointId", 200})}
            }
        })
    }));

    SharedUint8Array pathPositions;
    visualization.pathPositionsRaw(pathPositions);

    REQUIRE_FALSE(pathPositions.bytes().empty());
}
