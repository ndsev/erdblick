#include <catch2/catch_test_macros.hpp>

#include "erdblick/testdataprovider.h"
#include "erdblick/visualization.h"

#include <iostream>

using namespace erdblick;

TEST_CASE("FeatureLayerVisualization", "[erdblick.renderer]")
{
    auto testLayer = TestDataProvider().getTestLayer(42., 11., 13);
    FeatureLayerVisualization visualization(TestDataProvider::style(), testLayer);
    auto result = visualization.primitiveCollection();
    std::cout << result << std::endl;
    REQUIRE(!result.empty());
}