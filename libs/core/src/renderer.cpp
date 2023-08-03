#include <iostream>
#include <map>
#include <sstream>
#include <vector>

#include "glm/glm.hpp"
#include "glm/gtc/type_ptr.hpp"
#include "glm/gtc/matrix_transform.hpp"
#include "glm/gtx/quaternion.hpp"

#include "CesiumGeospatial/Ellipsoid.h"
#include "Cesium3DTilesWriter/TilesetWriter.h"
#include "CesiumGeometry/Transforms.h"
#include "Cesium3DTiles/Tileset.h"
#include "CesiumUtility/Math.h"
#include "CesiumGltf/Model.h"
#include "CesiumGltfWriter/GltfWriter.h"

#include "renderer.h"

using namespace mapget;

namespace erdblick
{

namespace
{
template <typename ResultVec = glm::vec3>
ResultVec
wgsToEuclidean(Point const& wgsPoint, glm::dvec3 const& origin = glm::dvec3{.0, .0, .0})
{
    namespace geo = CesiumGeospatial;
    auto& wgs84Elli = geo::Ellipsoid::WGS84;
    auto cartoCoords = geo::Cartographic::fromDegrees(wgsPoint.x, wgsPoint.y, wgsPoint.z);
    auto cartesian = wgs84Elli.cartographicToCartesian(cartoCoords);
    return {
        cartesian.x - origin.x,
        cartesian.y - origin.y,
        cartesian.z - origin.z};
}

/** GLTF conversion for one geometry type of one rule. */
struct RuleGeometry
{
    std::vector<glm::vec3> vertices_;
    int gltfPrimitiveMode_ = 0;
    glm::dvec3 const& offset_;
    FeatureStyleRule const& rule_;
    GeomType geomType_;
    uint32_t& requiredBufferSize_;

    RuleGeometry(GeomType geomType, glm::dvec3 const& offset, FeatureStyleRule const& rule, uint32_t& bufferSize)
        : offset_(offset), rule_(rule), geomType_(geomType), requiredBufferSize_(bufferSize)
    {
        switch (geomType_) {
        case GeomType::Line: gltfPrimitiveMode_ = CesiumGltf::MeshPrimitive::Mode::LINES; break;
        case GeomType::Points: gltfPrimitiveMode_ = CesiumGltf::MeshPrimitive::Mode::POINTS; break;
        case GeomType::Mesh: gltfPrimitiveMode_ = CesiumGltf::MeshPrimitive::Mode::TRIANGLES; break;
        default:
            // empty
            break;
        }
    }

    std::pair<glm::vec3, glm::vec3> getMinMax()
    {
        if (vertices_.empty()) {
            throw std::runtime_error("Empty vertices vector.");
        }

        glm::vec3 minVec = vertices_[0];
        glm::vec3 maxVec = vertices_[0];

        for (const auto& v : vertices_) {
            minVec.x = std::min(minVec.x, v.x);
            minVec.y = std::min(minVec.y, v.y);
            minVec.z = std::min(minVec.z, v.z);
            maxVec.x = std::max(maxVec.x, v.x);
            maxVec.y = std::max(maxVec.y, v.y);
            maxVec.z = std::max(maxVec.z, v.z);
        }

        return {minVec, maxVec};
    }

    void addToScene(CesiumGltf::Model& model, CesiumGltf::Scene& scene, std::byte* buf, int64_t& off)
    {
        if (vertices_.empty())
            return;

        auto materialIndex = static_cast<int>(model.materials.size());
        auto nodeIndex = static_cast<int>(model.nodes.size());
        auto meshIndex = static_cast<int>(model.meshes.size());
        auto posAttrAccessorIndex = static_cast<int>(model.accessors.size());
        auto bufferViewIndex = static_cast<int>(model.bufferViews.size());

        auto& node = model.nodes.emplace_back();
        node.mesh = meshIndex;
        scene.nodes.push_back(nodeIndex);

        auto& material = model.materials.emplace_back();
        auto color = rule_.color().toFVec4();
        material.pbrMetallicRoughness->baseColorFactor = {color.r, color.g, color.b, color.a};

        auto& mesh = model.meshes.emplace_back();
        auto& primitive = mesh.primitives.emplace_back();
        primitive.mode = gltfPrimitiveMode_;
        primitive.attributes["POSITION"] = posAttrAccessorIndex;
        primitive.material = materialIndex;

        auto& accessor = model.accessors.emplace_back();
        accessor.bufferView = bufferViewIndex;
        accessor.byteOffset = 0;
        accessor.componentType = CesiumGltf::Accessor::ComponentType::FLOAT;
        accessor.count = static_cast<int>(vertices_.size());
        accessor.type = CesiumGltf::Accessor::Type::VEC3;
        auto [minVal, maxVal] = getMinMax();
        accessor.min = {minVal.x, minVal.y, minVal.z};
        accessor.max = {maxVal.x, maxVal.y, maxVal.z};

        auto& bufferView = model.bufferViews.emplace_back();
        bufferView.buffer = 0;  // All buffer views must refer to the implicit buffer 0
        bufferView.byteOffset = off;
        bufferView.byteLength = static_cast<int>(vertices_.size() * 3 * sizeof(float_t));
        bufferView.target = CesiumGltf::BufferView::Target::ARRAY_BUFFER;

        std::memcpy(
            buf + off,
            vertices_.data(),
            static_cast<size_t>(bufferView.byteLength));
        off += bufferView.byteLength;
    }

    void addFeature(model_ptr<Feature>& feature)
    {
        feature->geom()->forEachGeometry(
            [this](auto&& geom)
            {
                addGeometry(geom);
                return true;
            });
    }

    void addGeometry(model_ptr<Geometry> const& geom)
    {
        if (geom->geomType() != geomType_)
            return;
        // TODO: Add Geometry::numVertices
        // vertices_.reserve(vertices_.size() + geom->numVertices())
        uint32_t count = 0;
        geom->forEachPoint(
            [this, &count](auto&& vertex)
            {
                if (count > 1) {
                    vertices_.emplace_back(vertices_.back());
                    ++count;
                }
                vertices_.emplace_back(wgsToEuclidean(vertex, offset_));
                ++count;
                return true;
            });
        requiredBufferSize_ += count * 3 * sizeof(float_t);
    }
};

}  // namespace

FeatureLayerRenderer::FeatureLayerRenderer() = default;

mapget::Point FeatureLayerRenderer::render(  // NOLINT (render can be made static)
    const FeatureLayerStyle& style,
    const std::shared_ptr<TileFeatureLayer>& layer,
    SharedUint8Array& result)
{
    uint32_t bufferSize = 0;
    auto tileOrigin = wgsToEuclidean<glm::dvec3>(layer->tileId().center());
    std::map<std::pair<uint64_t, GeomType>, std::unique_ptr<RuleGeometry>> geomForRule;

    for (auto&& feature : *layer) {
        // TODO: Optimize performance by implementing style.rules(feature-type)
        for (auto&& rule : style.rules()) {
            if (rule.match(*feature)) {
                for (auto geomType : rule.geometryTypes()) {
                    auto [it, wasInserted] = geomForRule.emplace(
                        std::make_pair(reinterpret_cast<uint64_t>(&rule), geomType),
                        std::unique_ptr<RuleGeometry>{});
                    if (wasInserted) {
                        it->second =
                            std::make_unique<RuleGeometry>(geomType, tileOrigin, rule, bufferSize);
                    }
                    it->second->addFeature(feature);
                }
            }
        }
    }

    // Convert to GLTF
    std::vector<std::byte> buffer;
    buffer.resize(bufferSize);
    int64_t bufferOffset = 0;
    CesiumGltf::Model model;
    model.buffers.emplace_back(); // Add single implicit buffer
    model.asset.version = "2.0";
    auto& scene = model.scenes.emplace_back();
    for (auto&& [_, ruleGeom] : geomForRule)
        ruleGeom->addToScene(model, scene, buffer.data(), bufferOffset);

    // Write the glTF model to an output stream.
    CesiumGltfWriter::GltfWriter gltfSerializer;
    auto glbSerializationResult = gltfSerializer.writeGlb(model, buffer);
    if (!glbSerializationResult.errors.empty())
        std::cerr << "Failed to write glTF to output stream." << std::endl;
    else {
        result.writeToArray(glbSerializationResult.gltfBytes);
    }

    return {tileOrigin.x, tileOrigin.y, tileOrigin.z};
}

void FeatureLayerRenderer::makeTileset(  // NOLINT (could be made static)
    std::string const& tileGlbUrl,
    mapget::Point const& origin,
    SharedUint8Array& result)
{
    Cesium3DTiles::Tileset tileset;
    tileset.asset.version = "1.1";
    tileset.geometricError = 1.0;  // TODO: Pick/understand value

    glm::dquat noRotation =
        glm::angleAxis(CesiumUtility::Math::degreesToRadians(0.0), glm::dvec3(1.0, 0.0, 0.0));
    auto localToGlobal = CesiumGeometry::Transforms::createTranslationRotationScaleMatrix(
        {origin.x, origin.y, origin.z},
        noRotation,
        glm::dvec3(1.0, 1.0, 1.0));
    localToGlobal = localToGlobal * CesiumGeometry::Transforms::Z_UP_TO_Y_UP;

    auto& root = tileset.root;
    root.transform =
        std::vector<double>(glm::value_ptr(localToGlobal), glm::value_ptr(localToGlobal) + 16);
    root.refine = Cesium3DTiles::Tile::Refine::REPLACE;
    root.content = Cesium3DTiles::Content();
    root.content->uri = tileGlbUrl;
    root.geometricError = 0.0;
    // Set a sphere with 200km radius as bounding volume
    root.boundingVolume.sphere = std::vector<double>{0, 0, 0, 200000.0};

    Cesium3DTilesWriter::TilesetWriter writer;
    auto serializedTileset = writer.writeTileset(tileset, {true});
    result.writeToArray(serializedTileset.tilesetBytes);
}

}  // namespace erdblick
