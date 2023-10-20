#pragma once

#include <map>
#include <vector>
#include "style.h"
#include "cesium-interface/point-conversion.h"
#include "cesium-interface/primitive.h"

namespace erdblick
{

/**
 * Cesium Primitive Conversion for a TileFeatureLayer using a style.
 */
class FeatureLayerVisualization
{
public:
    /**
     * Convert a TileFeatureLayer into Cesium primitives based on the provided style.
     * @param style The style to apply to the features in the layer.
     * @param layer A shared pointer to the TileFeatureLayer that needs to be visualized.
     */
     FeatureLayerVisualization(const FeatureLayerStyle& style, const std::shared_ptr<mapget::TileFeatureLayer>& layer);

    /**
     * Returns all non-empty Cesium primitives which resulted from
     * the given TileFeatureLayer conversion, in one PrimitiveCollection.
     */
    [[nodiscard]] NativeJsValue primitiveCollection() const;

private:
    /**
     * Add all geometry of some feature which is compatible with the given rule.
     */
    void addFeature(mapget::model_ptr<mapget::Feature>& feature, uint32_t id, FeatureStyleRule const& rule);

    /**
     * Add some geometry. The Cesium conversion will be dispatched,
     * based on the geometry type and the style rule instructions.
     */
    void addGeometry(mapget::model_ptr<mapget::Geometry> const& geom, uint32_t id, FeatureStyleRule const& rule);

    /**
     * Get some WGS84 points as a list of Cesium Cartesian points.
     */
    static std::optional<JsValue> encodeVerticesAsList(mapget::model_ptr<mapget::Geometry> const& geom);

    /**
     * Get some WGS84 points as a float64 buffer of Cesium Cartesian points.
     */
    static std::optional<JsValue> encodeVerticesAsFloat64Array(mapget::model_ptr<mapget::Geometry> const& geom);

    bool featuresAdded_ = false;
    CesiumPrimitive coloredLines_;
    CesiumPrimitive coloredNontrivialMeshes_;
    CesiumPrimitive coloredTrivialMeshes_;
};

}  // namespace erdblick
