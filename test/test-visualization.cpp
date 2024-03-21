#include <catch2/catch_test_macros.hpp>

#include "erdblick/testdataprovider.h"
#include "erdblick/visualization.h"
#include "erdblick/stream.h"

#include <iostream>

using namespace erdblick;

TEST_CASE("FeatureLayerVisualization", "[erdblick.renderer]")
{
    TileLayerParser tlp;
    auto testLayer = TestDataProvider(tlp).getTestLayer(42., 11., 13);
    auto style = TestDataProvider::style();
    FeatureLayerVisualization visualization(style);
    visualization.addTileFeatureLayer(testLayer);
    visualization.run();
    auto result = visualization.primitiveCollection();
    std::cout << result << std::endl;
    REQUIRE(!result.empty());
}
