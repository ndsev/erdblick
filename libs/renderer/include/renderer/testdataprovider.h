#pragma once

#include "mapget/model/featurelayer.h"

class TestDataProvider
{
public:
    TestDataProvider() {
        auto layerInfo = mapget::LayerInfo::fromJson(R"({
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
        auto fieldNames = std::make_shared<mapget::Fields>("TastyTomatoSaladNode");

        // Create a basic TileFeatureLayer
        layer_ = std::make_shared<mapget::TileFeatureLayer>(
            mapget::TileId::fromWgs84(42., 11., 13),
            "TastyTomatoSaladNode",
            "GarlicChickenMap",
            layerInfo,
            fieldNames);
        layer_->setPrefix({{"areaId", "TheBestArea"}});

        // Create a feature with line geometry
        auto feature1 = layer_->newFeature("Way", {{"wayId", 42}});
        // Use high-level geometry API
        feature1->addPoint({41.5, 10.5, 0});
        feature1->addLine({{41.5, 10.5, 0}, {41.6, 10.7}});
        feature1->addMesh({{41.5, 10.5, 0}, {41.6, 10.7}, {41.5, 10.3}});
        feature1->addPoly({{41.5, 10.5, 0}, {41.6, 10.7}, {41.5, 10.3}, {41.8, 10.9}});

        // Add a fixed attribute
        feature1->attributes()->addField("main_ingredient", "Pepper");

        // Add an attribute layer
        auto attrLayer = feature1->attributeLayers()->newLayer("cheese");
        auto attr = attrLayer->newAttribute("mozzarella");
        attr->setDirection(mapget::Attribute::Direction::Positive);
        attr->addField("smell", "neutral");
    }

    std::shared_ptr<mapget::TileFeatureLayer> getTestLayer() {
        return layer_;
    }

private:
    std::shared_ptr<mapget::TileFeatureLayer> layer_;
};

