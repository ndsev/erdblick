#pragma once

#include "mapget/model/featurelayer.h"
#include <iostream>
#include "style.h"
#include "stream.h"

namespace erdblick
{

class TestDataProvider
{
public:
    TestDataProvider(TileLayerParser& tileLayerParser)
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
                },
                {
                    "name": "Diamond",
                    "uniqueIdCompositions": [
                        [
                            {
                                "partId": "areaId",
                                "description": "String which identifies the map area.",
                                "datatype": "STR"
                            },
                            {
                                "partId": "diamondId",
                                "description": "Globally Unique 32b integer.",
                                "datatype": "U32"
                            }
                        ]
                    ]
                },
                {
                    "name": "PointOfInterest",
                    "uniqueIdCompositions": [
                        [
                            {
                                "partId": "areaId",
                                "description": "String which identifies the map area.",
                                "datatype": "STR"
                            },
                            {
                                "partId": "pointId",
                                "description": "Globally Unique 32b integer.",
                                "datatype": "U32"
                            }
                        ]
                    ]
                },
                {
                    "name": "PointOfNoInterest",
                    "uniqueIdCompositions": [
                        [
                            {
                                "partId": "areaId",
                                "description": "String which identifies the map area.",
                                "datatype": "STR"
                            },
                            {
                                "partId": "pointId",
                                "description": "Globally Unique 32b integer.",
                                "datatype": "U32"
                            }
                        ]
                    ]
                }
            ]
        })"_json);

        // Get a field dictionary which the parser can later pick up again,
        // and also inform the parser about the layer info used by features
        // in the test data.
        fieldNames_ = tileLayerParser.cachedFieldDicts_->operator()("TestDataNode");
        tileLayerParser.setFallbackLayerInfo(layerInfo_);
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
            "TestDataNode",
            "TestMap",
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
        for (int i = 0; i < 2; i++) {
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
        for (int i = 0; i < 2; i++) {
            std::cout << "Generated Sign " << i << std::endl;

            // Create a feature with polygon geometry
            auto feature = result->newFeature("Sign", {{"signId", 100 + i}});
            auto polyPoints = generateRandomPoints(2, 6, tileId.ne(), tileId.sw());
            feature->addPoly(polyPoints);

            // Add a random signType attribute
            int randomIndex = rand() % signTypes.size();
            feature->attributes()->addField("signType", signTypes[randomIndex]);
        }

        // Add some points of interest...
        for (int i = 0; i < 5; i++) {
            std::cout << "Generated POI " << i << std::endl;

            auto feature = result->newFeature("PointOfInterest", {{"pointId", 200 + i}});
            auto points = generateRandomPoints(1, 1, tileId.ne(), tileId.sw());
            feature->addPoints(points);
        }

        // ...and points of no interest.
        for (int i = 0; i < 5; i++) {
            std::cout << "Generated PONI " << i << std::endl;

            auto feature = result->newFeature("PointOfNoInterest", {{"pointId", 300 + i}});
            auto points = generateRandomPoints(1, 1, tileId.ne(), tileId.sw());
            feature->addPoints(points);
        }

        // Add a diamond mesh in the center of the tile.
        auto diamondMeshFeature = result->newFeature("Diamond", {{"diamondId", 999}});
        auto center = tileId.center();
        auto size = tileId.size();
        size.x *= .25;
        size.y *= .25;
        size.z = 1000.;
        double baseHeight = 1600.0; // Base height from previous code
        // Define the vertices of the diamond
        std::vector<mapget::Point> diamondVertices = {
            {center.x, center.y - size.y, baseHeight}, // Top front vertex
            {center.x - size.x, center.y, baseHeight}, // Left vertex
            {center.x, center.y + size.y, baseHeight}, // Bottom front vertex
            {center.x + size.x, center.y, baseHeight}, // Right vertex
            {center.x, center.y, baseHeight + size.z}, // Top apex (center top vertex)
            {center.x, center.y, baseHeight - size.z}  // Bottom apex (center bottom vertex)
        };
        // Form triangles for the 3D diamond
        std::vector<mapget::Point> diamondTriangles = {
            diamondVertices[4], diamondVertices[0], diamondVertices[1], // Top front-left triangle
            diamondVertices[4], diamondVertices[1], diamondVertices[2], // Top left-right triangle
            diamondVertices[4], diamondVertices[2], diamondVertices[3], // Top right-bottom triangle
            diamondVertices[4], diamondVertices[3], diamondVertices[0], // Top bottom-front triangle
            diamondVertices[5], diamondVertices[1], diamondVertices[0], // Bottom left-front triangle
            diamondVertices[5], diamondVertices[2], diamondVertices[1], // Bottom right-left triangle
            diamondVertices[5], diamondVertices[3], diamondVertices[2], // Bottom bottom-right triangle
            diamondVertices[5], diamondVertices[0], diamondVertices[3]  // Bottom front-bottom triangle
        };
        diamondMeshFeature->addMesh(diamondTriangles);

        return result;
    }

    static FeatureLayerStyle style()
    {
        return FeatureLayerStyle(SharedUint8Array(R"yaml(
        name: "TestDataProviderStyle"
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
              - line
            type: "Way"
            filter: "properties.wayType == 'Vehicle'"
            color: "#17e38e"
            width: 3.0
            flat: true

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

          - geometry:
              - polygon
            type: "Sign"
            color: "#e342f5" # Dark color for Speed Limit Sign
            flat: true

          - geometry:
              - mesh
            type: "Diamond"
            color: gold
            opacity: 0.5

          - geometry:
              - point
            type: "PointOfInterest"
            color: "#2ecc71" # Green color for Points of Interest
            width: 10

          - geometry:
              - point
            type: "PointOfNoInterest"
            color: "#e74c3c" # Red color for Points of No Interest
            width: 5
            outline-color: orange
            outline-width: 3
            near-far-scale: [1.5e2, 3, 8.0e6, 0.0]
        )yaml"));
    }

private:
    std::shared_ptr<mapget::LayerInfo> layerInfo_;
    std::shared_ptr<mapget::Fields> fieldNames_;
};

}
