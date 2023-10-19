#pragma once

#include "mapget/model/featurelayer.h"
#include <iostream>
#include "style.h"

namespace erdblick
{

class TestDataProvider
{
public:
    TestDataProvider()
    {
        layerInfo_ = mapget::LayerInfo::fromJson(R"({
            "layerId": "WayLayer",
            "type": "Features",
            "featureTypes": [
                {
                    "name": "Way",
                    "uniqueIdCompositions": [
                        [
                            {
                                "partId": "areaId",
                                "description": "String which identifies the map area.",
                                "datatype": "STR"
                            },
                            {
                                "partId": "wayId",
                                "description": "Globally Unique 32b integer.",
                                "datatype": "U32"
                            }
                        ]
                    ]
                }
            ]
        })"_json);

        // Create empty shared autofilled field-name dictionary
        fieldNames_ = std::make_shared<mapget::Fields>("TastyTomatoSaladNode");
    }

    std::shared_ptr<mapget::TileFeatureLayer> getTestLayer(double camX, double camY, uint16_t level)
    {
        auto tileId = mapget::TileId::fromWgs84(camX, camY, level);

        // Create a basic TileFeatureLayer
        auto result = std::make_shared<mapget::TileFeatureLayer>(
            tileId,
            "TastyTomatoSaladNode",
            "GarlicChickenMap",
            layerInfo_,
            fieldNames_);
        result->setPrefix({{"areaId", "TheBestArea"}});

        // Create a function to generate a random coordinate between two given points
        auto randomCoordinateBetween = [&](const auto& point1, const auto& point2) {
            auto x = point1.x + (point2.x - point1.x) * (rand() / static_cast<double>(RAND_MAX));
            auto y = point1.y + (point2.y - point1.y) * (rand() / static_cast<double>(RAND_MAX));
            auto z = 100. / static_cast<double>(level);
            return mapget::Point{x, y, z};
        };

        // Seed the random number generator for consistency
        srand(time(nullptr));

        // Create 10 random lines inside the bounding box defined by ne and sw
        for (int i = 0; i < 10; i++) {
            // Create a feature with line geometry
            auto feature = result->newFeature("Way", {{"wayId", 42 + i}});

            // Generate random start and end points for the line
            auto start = randomCoordinateBetween(tileId.ne(), tileId.sw());
            auto end = randomCoordinateBetween(tileId.ne(), tileId.sw());
            feature->addLine({start, end});

            // Add a fixed attribute
            feature->attributes()->addField("main_ingredient", "Pepper");

            // Add an attribute layer
            auto attrLayer = feature->attributeLayers()->newLayer("cheese");
            auto attr = attrLayer->newAttribute("mozzarella");
            attr->setDirection(mapget::Attribute::Direction::Positive);
            attr->addField("smell", "neutral");
        }

        return result;
    }

private:
    std::shared_ptr<mapget::LayerInfo> layerInfo_;
    std::shared_ptr<mapget::Fields> fieldNames_;
};

}
