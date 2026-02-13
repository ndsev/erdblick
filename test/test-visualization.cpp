#include <catch2/catch_test_macros.hpp>

#include "erdblick/inspection.h"
#include "erdblick/parser.h"
#include "erdblick/testdataprovider.h"
#include "erdblick/visualization.h"

#include <iostream>

using namespace erdblick;

TEST_CASE("CesiumFeatureLayerVisualization", "[erdblick.renderer]")
{
    TileLayerParser tlp;
    auto testLayer = TestDataProvider(tlp).getTestLayer(42., 11., 13);
    auto style = TestDataProvider::style();
    CesiumFeatureLayerVisualization visualization(0, "Features:Test:Test:0", style, {}, {});
    visualization.addTileFeatureLayer(TileFeatureLayer(testLayer));
    visualization.run();
    auto result = visualization.primitiveCollection();
    std::cout << result << std::endl;
    REQUIRE(!result.empty());
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
