#include <iostream>
#include <map>
#include <sstream>
#include <vector>

#include "glm/glm.hpp"
#include "glm/gtc/type_ptr.hpp"
#include "glm/gtc/matrix_transform.hpp"
#include "glm/gtx/quaternion.hpp"

#include "renderer.h"
#include "cesium-interface/point-conversion.h"
#include "cesium-interface/primitive.h"

using namespace mapget;

namespace erdblick
{

namespace
{

/** GLTF conversion for one geometry type of one rule. */
struct CesiumTileGeometry
{
    CesiumTileGeometry() : coloredLines_(CesiumPrimitive::withPolylineColorAppearance()) {}

    void addFeature(model_ptr<Feature>& feature, uint32_t id, FeatureStyleRule const& rule)
    {
        feature->geom()->forEachGeometry(
            [this, id, &rule](auto&& geom)
            {
                addGeometry(geom, id, rule);
                return true;
            });
    }

    void addGeometry(model_ptr<Geometry> const& geom, uint32_t id, FeatureStyleRule const& rule)
    {
        // TODO: Implement logic for points/meshes/polygons
        if (geom->geomType() != Geometry::GeomType::Line)
            return;

        auto jsPoints = JsValue::newList();

        uint32_t count = 0;
        geom->forEachPoint(
            [&count, &jsPoints](auto&& vertex)
            {
                jsPoints.push(JsValue(wgsToCartesian<mapget::Point>(vertex)));
                ++count;
                return true;
            });

        if (!count)
            return;

        coloredLines_.addLine(jsPoints, rule, id);
    }

    CesiumPrimitive coloredLines_;
};

}  // namespace

FeatureLayerRenderer::FeatureLayerRenderer() = default;

NativeJsValue FeatureLayerRenderer::render(
    const erdblick::FeatureLayerStyle& style,
    const std::shared_ptr<mapget::TileFeatureLayer>& layer)
{
    CesiumTileGeometry tileGeometry;

    uint32_t featureId = 0;
    bool featuresAdded = false;
    for (auto&& feature : *layer) {
        // TODO: Optimize performance by implementing style.rules(feature-type)
        for (auto&& rule : style.rules()) {
            if (rule.match(*feature)) {
                tileGeometry.addFeature(feature, featureId, rule);
                featuresAdded = true;
            }
        }
        ++featureId;
    }

    if (featuresAdded)
        return tileGeometry.coloredLines_.toJsObject();
    else
        return {};  // Equates to JS null
}

}  // namespace erdblick
