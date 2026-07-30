#include <catch2/catch_test_macros.hpp>

#include "erdblick/subset-renderer.h"
#include "mapget/model/info.h"
#include "mapget/model/stringpool.h"
#include "mapget/model/subsetlayer.h"

#include <nlohmann/json.hpp>

using namespace erdblick;

namespace
{

std::shared_ptr<mapget::LayerInfo> rendererLayerInfo()
{
    return mapget::LayerInfo::fromJson(
        nlohmann::json::parse(R"json(
        {
            "layerId": "Road",
            "type": "Features",
            "featureTypes": [
                {
                    "name": "Road",
                    "uniqueIdCompositions": [[
                        {"partId": "roadId", "datatype": "U64"}
                    ]]
                }
            ]
        })json"));
}

mapget::model_ptr<mapget::GeometryCollection> lineGeometry(
    mapget::TileSubsetLayer& layer,
    std::string_view name)
{
    auto collection = layer.newGeometryCollection(1, true);
    auto geometry = layer.newGeometry(
        mapget::GeomType::Line,
        2,
        true);
    geometry->setName(name);
    geometry->append({11.0, 48.0, 0.0});
    geometry->append({11.001, 48.001, 0.0});
    collection->addGeometry(geometry);
    return collection;
}

FeatureLayerStyle rendererStyle(std::string_view source)
{
    return FeatureLayerStyle(
        SharedUint8Array(std::string(source)));
}

} // namespace

TEST_CASE(
    "TileSubsetLayerRenderer consumes projected color scales and emits tuple picks",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererPool",
        "TestMap",
        info,
        strings,
        "roads",
        3);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{7}}});
    std::vector<std::string> featureFields{"roadClass"};
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline",
        featureFields);
    std::vector<simfil::ModelNode::Ptr> featureValues{
        subset->newValue(int64_t{2}),
    };
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        featureValues);

    auto style = rendererStyle(R"yaml(
name: SubsetRenderer
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    width: 4
    color-scale:
      mode: categorical
      expression: roadClass
      stops:
        - [1, "#ff0000"]
        - [2, "#00ff00"]
      fallback: "#0000ff"
    width-scale:
      mode: categorical
      expression: roadClass
      stops:
        - [1, 2]
        - [2, 6]
      fallback: 1
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    auto result = renderer.renderResult();
    REQUIRE(renderer.abiVersion() == 3);
    REQUIRE(renderer.vertexCount() == 2);
    REQUIRE(result["pathWorld"]["positions"].size() == 6);
    REQUIRE(result["pathWorld"]["colors"] == "AP8A/wD/AP8=");
    REQUIRE(result["pathWorld"]["widths"][0] == 6.0);
    REQUIRE(result["pathWorld"]["featureAddresses"][0] == 0);
    REQUIRE(result["pickRefs"] == nlohmann::json::array({0, 0, 0, 0}));
    REQUIRE(result["pickResults"][0]["subsetOrdinal"] == 0);
    REQUIRE(result["pickResults"][0]["featureId"] == "Road.7");
    REQUIRE(renderer.runtimeStyleIssues().empty());

    TileSubsetLayerRenderer blockRenderer(
        0,
        "z13/d1/p0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    blockRenderer.addTileSubsetLayer(TileSubsetLayer(subset));
    blockRenderer.addTileSubsetLayer(TileSubsetLayer(subset));
    blockRenderer.run();
    auto blockResult = blockRenderer.renderResult();
    REQUIRE(blockResult["pathWorld"]["featureAddresses"].size() == 2);
    REQUIRE(blockResult["pathWorld"]["featureAddresses"][0] == 0);
    REQUIRE(blockResult["pathWorld"]["featureAddresses"][1] == 1);
    REQUIRE(blockResult["pickResults"][0]["subsetOrdinal"] == 0);
    REQUIRE(blockResult["pickResults"][1]["subsetOrdinal"] == 1);
    REQUIRE(blockResult["subsetVertexCounts"] ==
        nlohmann::json::array({2, 2}));
}

TEST_CASE(
    "TileSubsetLayerRenderer rejects geometry with the wrong semantic name",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererNamePool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererNamePool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{8}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "topology"),
        {});

    auto style = rendererStyle(R"yaml(
name: SemanticGeometry
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    width: 2
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    REQUIRE(renderer.renderResult()["pathWorld"]["positions"].empty());
}

TEST_CASE(
    "TileSubsetLayerRenderer offsets every terminal attribute validity entry",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererValidityPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererValidityPool",
        "TestMap",
        info,
        strings,
        "validities",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{11}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Attribute,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newAttributeValidityEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        0,
        true,
        0,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");
    channel->newAttributeValidityEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        0,
        true,
        1,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");

    auto style = rendererStyle(R"yaml(
name: ValidityOffsets
version: 2
rules:
  - type: Road
    scope: attribute
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    offset-increment: [0, 0, 5]
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    auto result = renderer.renderResult();
    auto const& positions = result["pathWorld"]["positions"];
    REQUIRE(positions.size() == 12);
    REQUIRE(positions[2] == 0.0);
    REQUIRE(positions[5] == 0.0);
    REQUIRE(positions[8] == 5.0);
    REQUIRE(positions[11] == 5.0);
}

TEST_CASE(
    "TileSubsetLayerRenderer diagnoses entries which match no concrete rule",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererRuleMatchPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererRuleMatchPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{9}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        {});

    auto style = rendererStyle(R"yaml(
name: RuleMismatch
version: 2
rules:
  - type: Lane
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::AnyFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    auto issues = renderer.runtimeStyleIssues();
    REQUIRE(issues.size() == 1);
    REQUIRE(issues[0]["property"] == "rule-match");
    REQUIRE(issues[0]["expression"] == "Road");
}

TEST_CASE(
    "TileSubsetLayerRenderer silently skips an inactive fidelity channel",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererFidelityPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererFidelityPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{10}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        {});

    auto style = rendererStyle(R"yaml(
name: FidelitySwitch
version: 2
rules:
  - type: Road
    fidelity: low
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        static_cast<int>(FeatureStyleRule::HighFidelity));
    renderer.addTileSubsetLayer(TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    REQUIRE(renderer.runtimeStyleIssues().empty());
}
