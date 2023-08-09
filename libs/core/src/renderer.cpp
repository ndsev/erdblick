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
#include "CesiumGltf/ExtensionExtMeshFeatures.h"

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
    std::vector<glm::float32> featureIds_;

    int gltfPrimitiveMode_ = 0;
    glm::dvec3 const& offset_;
    FeatureStyleRule const& rule_;
    GeomType geomType_;

    // Reference to global buffer size variable shared by all RuleGeometryObjects
    // which belong to the same TileFeatureLayer.
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

    uint32_t numDistinctFeatureIDs() {
        float prevId = -1.;
        uint32_t result = 0;
        for (auto const& fid : featureIds_)
            if (fid != prevId) {
                ++result;
                prevId = fid;
            }
        return result;
    }

    void addToScene(
        CesiumGltf::Model& model,
        CesiumGltf::Scene& scene,
        std::byte* buffer,
        int64_t& offset)
    {
        if (vertices_.empty())
            return;

        auto materialIndex = static_cast<int>(model.materials.size());
        auto nodeIndex = static_cast<int>(model.nodes.size());
        auto meshIndex = static_cast<int>(model.meshes.size());
        auto posAttrAccessorIndex = static_cast<int>(model.accessors.size());
        auto posBufferViewIndex = static_cast<int>(model.bufferViews.size());
        auto featIdAttrAccessorIndex = posAttrAccessorIndex + 1;
        auto featIdBufferViewIndex = posBufferViewIndex + 1;

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
        primitive.attributes["_FEATURE_ID_0"] = featIdAttrAccessorIndex;
        primitive.material = materialIndex;

        // For an explainer, have a look at the Cesium EXT_mesh_features specification:
        //  https://github.com/CesiumGS/glTF/blob/proposal-EXT_mesh_features/extensions/2.0/Vendor/EXT_mesh_features/README.md
        auto meshFeatureExt = CesiumGltf::ExtensionExtMeshFeatures();
        auto& meshFeatureExtFeatureIds = meshFeatureExt.featureIds.emplace_back();
        meshFeatureExtFeatureIds.attribute = 0;
        meshFeatureExtFeatureIds.featureCount = numDistinctFeatureIDs();
        meshFeatureExtFeatureIds.nullFeatureId = -1;
        primitive.extensions[CesiumGltf::ExtensionExtMeshFeatures::ExtensionName] = meshFeatureExt;

        auto& posAccessor = model.accessors.emplace_back();
        posAccessor.bufferView = posBufferViewIndex;
        posAccessor.byteOffset = 0;
        posAccessor.componentType = CesiumGltf::Accessor::ComponentType::FLOAT;
        posAccessor.count = static_cast<int>(vertices_.size());
        posAccessor.type = CesiumGltf::Accessor::Type::VEC3;
        auto [minVal, maxVal] = getMinMax();
        posAccessor.min = {minVal.x, minVal.y, minVal.z};
        posAccessor.max = {maxVal.x, maxVal.y, maxVal.z};

        auto& posBufferView = model.bufferViews.emplace_back();
        posBufferView.buffer = 0;  // All buffer views must refer to the implicit buffer 0
        posBufferView.byteOffset = offset;
        posBufferView.byteLength = static_cast<int>(vertices_.size() * 3 * sizeof(glm::float32));
        posBufferView.target = CesiumGltf::BufferView::Target::ARRAY_BUFFER;

        std::memcpy(
            buffer + offset,
            vertices_.data(),
            static_cast<size_t>(posBufferView.byteLength));
        offset += posBufferView.byteLength;

        auto& featIdAccessor = model.accessors.emplace_back();
        featIdAccessor.bufferView = featIdBufferViewIndex;
        featIdAccessor.byteOffset = 0;
        featIdAccessor.componentType = CesiumGltf::Accessor::ComponentType::FLOAT;
        featIdAccessor.count = static_cast<int>(featureIds_.size());
        featIdAccessor.type = CesiumGltf::Accessor::Type::SCALAR;
        featIdAccessor.min = {featureIds_.front()};
        featIdAccessor.max = {featureIds_.back()};

        auto& featIdBufferView = model.bufferViews.emplace_back();
        featIdBufferView.buffer = 0;  // All buffer views must refer to the implicit buffer 0
        featIdBufferView.byteOffset = offset;
        featIdBufferView.byteLength = static_cast<int>(featureIds_.size() * sizeof(glm::float32));
        featIdBufferView.target = CesiumGltf::BufferView::Target::ARRAY_BUFFER;

        std::memcpy(
            buffer + offset,
            featureIds_.data(),
            static_cast<size_t>(featIdBufferView.byteLength));
        offset += featIdBufferView.byteLength;
    }

    void addFeature(model_ptr<Feature>& feature, uint32_t id)
    {
        feature->geom()->forEachGeometry(
            [this, id](auto&& geom)
            {
                addGeometry(geom, id);
                return true;
            });
    }

    void addGeometry(model_ptr<Geometry> const& geom, uint32_t id)
    {
        if (geom->geomType() != geomType_)
            return;

        // TODO: Add Geometry::numVertices
        // vertices_.reserve(vertices_.size() + geom->numVertices())
        // featureIds_.reserve(vertices_.size() + geom->numVertices())

        // TODO: Implement logic for points/meshes/polygons
        uint32_t count = 0;
        geom->forEachPoint(
            [this, &count, id](auto&& vertex)
            {
                if (count > 1) {
                    vertices_.emplace_back(vertices_.back());
                    featureIds_.emplace_back(featureIds_.back());
                    ++count;
                }
                vertices_.emplace_back(wgsToEuclidean(vertex, offset_));
                featureIds_.emplace_back((glm::float32)id);
                ++count;
                return true;
            });

        // Add buffer size required for vertex data
        requiredBufferSize_ += count * 3 * sizeof(glm::float32);
        // Add buffer size required for feature IDs
        requiredBufferSize_ += count * sizeof(glm::float32);
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

    // The Feature ID corresponds to the index of the feature
    // within the TileFeatureLayer.
    uint32_t featureId = 0;
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
                    it->second->addFeature(feature, featureId);
                }
            }
        }
        ++featureId;
    }

    // Convert to GLTF
    std::vector<std::byte> buffer;
    buffer.resize(bufferSize);
    int64_t bufferOffset = 0;
    CesiumGltf::Model model;
    model.buffers.emplace_back(); // Add single implicit buffer
    model.asset.version = "2.0";
    model.extensionsUsed.emplace_back(CesiumGltf::ExtensionExtMeshFeatures::ExtensionName);

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
    // Pick maximum geometric error (coarseness) so Cesium will never
    // assume that this tile is too detailed to display.
    constexpr auto geometricError = 1.0;

    // For now, we give the tile a hard-coded bounding sphere radius
    // of 200km. TODO: Calculate this value from the tile size.
    constexpr auto boundingSphereRadius = 200000.;

    Cesium3DTiles::Tileset tileset;
    tileset.asset.version = "1.1";

    tileset.geometricError = geometricError;

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
    root.geometricError = geometricError;
    root.boundingVolume.sphere = std::vector<double>{0, 0, 0, boundingSphereRadius};

    Cesium3DTilesWriter::TilesetWriter writer;
    auto serializedTileset = writer.writeTileset(tileset, {true});
    result.writeToArray(serializedTileset.tilesetBytes);
}

}  // namespace erdblick
