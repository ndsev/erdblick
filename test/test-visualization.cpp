#include <catch2/catch_test_macros.hpp>

#include "erdblick/inspection.h"
#include "erdblick/parser.h"
#include "erdblick/testdataprovider.h"
#include "erdblick/visualization.h"

#include <iostream>

using namespace erdblick;

TEST_CASE("FeatureLayerVisualization", "[erdblick.renderer]")
{
    TileLayerParser tlp;
    auto testLayer = TestDataProvider(tlp).getTestLayer(42., 11., 13);
    auto style = TestDataProvider::style();
    FeatureLayerVisualization visualization(0, "Features:Test:Test:0", style, {}, {});
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
        std::cout << InspectionConverter().convert(f).value_.dump(4) << std::endl;
    }
}
