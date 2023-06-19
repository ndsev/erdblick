#include <vector>

#include "duckfile.c"
#include "tiny_gltf.h"

#include "featurelayerrenderer.h"

FeatureLayerRenderer::FeatureLayerRenderer() = default;

SharedUint8Array& FeatureLayerRenderer::render(
    const FeatureLayerStyle& style,
    const std::shared_ptr<mapget::TileFeatureLayer>& layer)
{
    // TODO use features from the supplied layer instead.
    // The example below is from a mapget test case.

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
    auto tile = std::make_shared<mapget::TileFeatureLayer>(
        mapget::TileId::fromWgs84(42., 11., 13),
        "TastyTomatoSaladNode",
        "GarlicChickenMap",
        layerInfo,
        fieldNames);
    tile->setPrefix({{"areaId", "TheBestArea"}});

    // Create a feature with line geometry
    auto feature1 = tile->newFeature("Way", {{"wayId", 42}});
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

    // TODO store rules by the feature they apply to for faster processing.

    for (auto& rule : style.rules()) {
        for (auto&& feature : *layer) {
            if (rule.match(*feature)) {
                // TODO visualization.
            }
        }
    }

    glbArray = std::make_shared<SharedUint8Array>(duckfile_len);
    glbArray->writeToArray(std::begin(duckfile), std::end(duckfile));
    return *glbArray;
}
