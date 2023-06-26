#pragma once

#include "mapget/model/featurelayer.h"

namespace erdblick
{

class TestDataProvider
{
public:
    TestDataProvider()
    {
        auto layerInfo_ = mapget::LayerInfo::fromJson(R"({
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

        // Create a feature with line geometry
        auto feature1 = result->newFeature("Way", {{"wayId", 42}});

        // Use high-level geometry API
        auto ne = tileId.ne();
        auto sw = tileId.sw();
        ne.z = sw.z = 100./static_cast<double>(level);
        feature1->addLine({ne, sw});

        // Add a fixed attribute
        feature1->attributes()->addField("main_ingredient", "Pepper");

        // Add an attribute layer
        auto attrLayer = feature1->attributeLayers()->newLayer("cheese");
        auto attr = attrLayer->newAttribute("mozzarella");
        attr->setDirection(mapget::Attribute::Direction::Positive);
        attr->addField("smell", "neutral");

        return result;
    }

private:
    std::shared_ptr<mapget::LayerInfo> layerInfo_;
    std::shared_ptr<mapget::Fields> fieldNames_;
};

}
