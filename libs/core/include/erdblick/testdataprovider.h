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
                },
                {
                    "name": "Sign",
                    "uniqueIdCompositions": [
                        [
                            {
                                "partId": "areaId",
                                "description": "String which identifies the map area.",
                                "datatype": "STR"
                            },
                            {
                                "partId": "signId",
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
        static const std::vector<std::string> signTypes{"Stop", "Yield", "Parking", "No Entry", "Speed Limit"};
        static const std::vector<std::string> wayTypes{"Bike", "Pedestrian", "Any", "Vehicle"};

        // Seed the random number generator for consistency
        srand(time(nullptr));

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
        auto randomPointBetween = [&](const auto& point1, const auto& point2, double baseHeight) {
            auto x = point1.x + (point2.x - point1.x) * (rand() / static_cast<double>(RAND_MAX));
            auto y = point1.y + (point2.y - point1.y) * (rand() / static_cast<double>(RAND_MAX));
            double heightOffset = (rand() / static_cast<double>(RAND_MAX)) * 1000.0 - 500.0; // Between -500 and 500
            auto z = baseHeight + heightOffset;
            return mapget::Point{x, y, z};
        };

        // Helper function to generate a random number of points with a given base height
        auto generateRandomPoints = [&](int minPoints, int maxPoints, const auto& ne, const auto& sw) {
            double baseHeight = 1000.0;
            std::vector<mapget::Point> points;
            int numPoints = minPoints + rand() % (maxPoints - minPoints + 1); // Random number of points between min and max
            points.reserve(numPoints);
            while (numPoints --> 0) {
                points.push_back(randomPointBetween(ne, sw, baseHeight));
            }
            return points;
        };

        // Create 10 random Way features inside the bounding box defined by NE and SW
        for (int i = 0; i < 10; i++) {
            std::cout << "Generated Way " << i << std::endl;
            // Create a feature with line geometry
            auto feature = result->newFeature("Way", {{"wayId", 42 + i}});
            auto linePoints = generateRandomPoints(2, 8, tileId.ne(), tileId.sw());
            feature->addLine(linePoints);

            // Add a random wayType attribute
            int randomIndex = rand() % wayTypes.size();
            feature->attributes()->addField("wayType", wayTypes[randomIndex]);

            // Add an attribute layer
            auto attrLayer = feature->attributeLayers()->newLayer("lane");
            auto attr = attrLayer->newAttribute("numLanes");
            attr->setDirection(mapget::Attribute::Direction::Positive);
            attr->addField("count", (int64_t)rand());
        }

        // Create 10 random Sign features inside the bounding box defined by NE and SW
        for (int i = 0; i < 10; i++) {
            std::cout << "Generated Sign " << i << std::endl;

            // Create a feature with polygon geometry
            auto feature = result->newFeature("Sign", {{"signId", 100 + i}});
            auto polyPoints = generateRandomPoints(2, 6, tileId.ne(), tileId.sw());
            feature->addPoly(polyPoints);

            // Add a random signType attribute
            int randomIndex = rand() % signTypes.size();
            feature->attributes()->addField("signType", signTypes[randomIndex]);
        }

        return result;
    }

    static FeatureLayerStyle style()
    {
        return FeatureLayerStyle(SharedUint8Array(R"yaml(
        rules:
          - geometry:
              - line
            type: "Way"
            filter: "properties.wayType == 'Bike'"
            color: "#3498db" # Blue color for Bike Way
            width: 2.0

          - geometry:
              - line
            type: "Way"
            filter: "properties.wayType == 'Pedestrian'"
            color: "#2ecc71" # Green color for Pedestrian Way
            width: 1.5

          - geometry:
              - line
            type: "Way"
            filter: "properties.wayType == 'Any'"
            color: "#f39c12" # Orange color for Any Way
            width: 2.5

          - geometry:
              - line
            type: "Way"
            filter: "properties.wayType == 'Vehicle'"
            color: "#e74c3c" # Red color for Vehicle Way
            width: 3.0

          - geometry:
              - polygon
            type: "Sign"
            filter: "properties.signType == 'Stop'"
            color: "#e74c3c" # Red color for Stop Sign

          - geometry:
              - polygon
            type: "Sign"
            filter: "properties.signType == 'Yield'"
            color: "#f39c12" # Orange color for Yield Sign

          - geometry:
              - polygon
            type: "Sign"
            filter: "properties.signType == 'Parking'"
            color: "#3498db" # Blue color for Parking Sign

          - geometry:
              - polygon
            type: "Sign"
            filter: "properties.signType == 'No Entry'"
            color: "#8e44ad" # Purple color for No Entry Sign

          - geometry:
              - polygon
            type: "Sign"
            filter: "properties.signType == 'Speed Limit'"
            color: "#2c3e50" # Dark color for Speed Limit Sign
        )yaml"));
    }

private:
    std::shared_ptr<mapget::LayerInfo> layerInfo_;
    std::shared_ptr<mapget::Fields> fieldNames_;
};

}
