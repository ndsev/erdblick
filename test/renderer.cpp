#include <catch2/catch_test_macros.hpp>

#include "erdblick/renderer.h"
#include "erdblick/testdataprovider.h"

#include <iostream>

using namespace erdblick;

TEST_CASE("FeatureLayerRenderer", "[erdblick.renderer]")
{
    FeatureLayerStyle style(SharedUint8Array(R"(
    name: DemoStyle
    version: 1.0
    rules:
      - geometry: ["line"]
        color: [255.0, 255.0, 255.0]
      - geometry: ["mesh"]
        opacity: 0.9
      - geometry: ["point"]
    )"));

    auto testLayer = TestDataProvider().getTestLayer(42., 11., 13);

    SharedUint8Array result;
    FeatureLayerRenderer renderer;
    renderer.render(style, testLayer, result);

    std::cerr << result.toString() << std::endl;

    REQUIRE(result.getSize() != 0);
}