#pragma once

#include "buffer.h"
#include "cesium-interface/object.h"
#include "geometry.h"
#include "layer.h"
#include "style.h"

#include <map>
#include <memory>
#include <string>
#include <unordered_set>
#include <vector>

namespace erdblick
{

/**
 * GLB + 3D Tiles conversion for a TileFeatureLayer using a style.
 * This backend is intended to avoid per-feature JS primitive construction
 * by emitting a glTF model plus a lightweight tileset wrapper.
 */
class FeatureLayerVisualization3DTiles
{
public:
    FeatureLayerVisualization3DTiles(
        int viewIndex,
        std::string const& mapTileKey,
        FeatureLayerStyle const& style,
        NativeJsValue const& rawOptionValues,
        FeatureStyleRule::HighlightMode const& highlightMode = FeatureStyleRule::NoHighlight,
        NativeJsValue const& rawFeatureIdSubset = {});

    ~FeatureLayerVisualization3DTiles();

    /**
     * Add a tile which is considered for visualization. Only the
     * first tile is rendered; additional tiles are ignored for now.
     */
    void addTileFeatureLayer(TileFeatureLayer const& tile);

    /**
     * Convert the added tile to a GLB buffer. Returns false if
     * nothing was rendered.
     */
    bool renderGlb(SharedUint8Array& result);

    /**
     * Return the cartesian origin used for the GLB conversion.
     */
    [[nodiscard]] mapget::Point origin() const;

    /**
     * Create a Cesium tileset wrapper for a GLB URL.
     */
    void makeTileset(
        std::string const& tileGlbUrl,
        SharedUint8Array& result) const;

private:
    simfil::Value evaluateExpression(
        const std::string& expression,
        const simfil::ModelNode& ctx,
        bool anyMode,
        bool autoWildcard) const;

    void addOptionsToSimfilContext(simfil::model_ptr<simfil::OverlayNode>& context);

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------
    int viewIndex_;
    std::string mapTileKey_;
    FeatureLayerStyle const& style_;
    FeatureStyleRule::HighlightMode highlightMode_;

    mapget::TileFeatureLayer::Ptr tile_;
    std::shared_ptr<simfil::StringPool> internalStringPoolCopy_;
    std::map<std::string, simfil::Value> optionValues_;

    std::unordered_set<std::string> featureIdSubset_;
    std::unordered_set<std::string> featureIdBaseSubset_;

    glm::dvec3 tileOrigin_{.0, .0, .0};
    glm::dmat4 enuToEcef_{1.0};
    glm::dmat4 ecefToEnu_{1.0};
    double boundingRadius_ = 0.0;
    bool hasContent_ = false;
};

} // namespace erdblick
