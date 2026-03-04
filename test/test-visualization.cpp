#include <catch2/catch_test_macros.hpp>

#include "erdblick/inspection.h"
#include "erdblick/parser.h"
#include "erdblick/rule.h"
#include "erdblick/testdataprovider.h"
#include "erdblick/visualization.h"

#include <iostream>

using namespace erdblick;

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
